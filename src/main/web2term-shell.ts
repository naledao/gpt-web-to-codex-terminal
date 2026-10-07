import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { RemoteShell } from './remote-shell'
import { REMOTE_DETECT_COMMAND } from './environment'
import type { ExecutionShell, ShellResult } from './shell'
import type { Web2termConnection } from './web2term-connection'
import type { TerminalState, Web2termTerminalOutput } from '../shared/types'

export interface Web2termSessionBinding {
  agentId: string
  deviceName: string
  backendUrl: string
  userId: string
}

export function parseWeb2termBinding(value: string | null): Web2termSessionBinding | null {
  try {
    const item = JSON.parse(value ?? 'null')
    if (item && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(item.agentId)
      && typeof item.deviceName === 'string' && typeof item.backendUrl === 'string'
      && typeof item.userId === 'string' && item.userId) return item
  } catch { /* Ignore invalid settings rather than treating them as local sessions. */ }
  return null
}

/** Release the shared desktop route only after all of its workspace owners stop using it. */
export function disconnectUnusedWeb2term(
  connection: Web2termConnection,
  shells: Iterable<Web2termShell>,
  binding: Web2termSessionBinding,
  allowUnconfirmed = false
): void {
  const state = connection.getState()
  if (!['connecting', 'connected'].includes(state.status) || state.agentId !== binding.agentId
    || state.auth.backendUrl !== binding.backendUrl || state.auth.user?.publicId !== binding.userId) return
  for (const shell of shells) {
    if (shell.needsConnection && shell.binding.agentId === binding.agentId
      && shell.binding.backendUrl === binding.backendUrl && shell.binding.userId === binding.userId) return
  }
  // Other terminals still using this socket must survive. Normally wait for all close acknowledgements.
  if (connection.terminals.getState().sessions.some(item => ['opening', 'ready'].includes(item.status)
    || (item.status === 'closing' && !allowUnconfirmed && !['CLOSE_TIMEOUT', 'CLOSE_SEND_FAILED'].includes(item.errorCode)))) return
  connection.disconnect()
}

class RelayChannel extends EventEmitter {
  private closed = false
  constructor(private readonly input: (data: Buffer) => void, private readonly stop: () => void) { super() }
  write(data: string): void {
    if (this.closed) throw new Error('Channel closed')
    try { this.input(Buffer.from(data, 'utf8')) }
    catch { this.close(); throw new Error('Remote input unavailable') }
  }
  signal(): void { this.close() }
  close(): void { if (!this.closed) { this.stop(); this.finish() } }
  finish(): void { if (!this.closed) { this.closed = true; this.emit('close') } }
}

/** One managed workspace owns one device PTY, shared by manual and model commands. */
export class Web2termShell implements ExecutionShell {
  readonly kind = 'posix' as const
  readonly probeCommand = REMOTE_DETECT_COMMAND
  readonly hostId: string
  private sessionId: string | null = null
  private connectionId = ''
  private channel: RelayChannel | null = null
  private shell: RemoteShell | null = null
  private enabled = false
  private wantOpen = false
  private closeRequested = false
  private closeReported = false
  private closeUnconfirmed = false
  private disposed = false
  private bootToken = ''
  private bootBuffer = Buffer.alloc(0)
  private bootTimer: ReturnType<typeof setTimeout> | null = null
  private lastCwd = ''
  private state: NonNullable<TerminalState['transport']>['status'] = 'disconnected'
  private message = '尚未连接设备，请点击重新连接。'
  private readonly unsubscribe: () => void
  onOutput: (chunk: string) => void = () => {}
  onChanged: (message?: string) => void = () => {}
  onReady: () => void = () => {}
  onClosed: (unconfirmed: boolean) => void = () => {}

  constructor(readonly binding: Web2termSessionBinding, private readonly connection: Web2termConnection) {
    this.hostId = 'web2term:' + createHash('sha256').update(JSON.stringify([binding.backendUrl, binding.userId, binding.agentId])).digest('hex')
    this.unsubscribe = connection.terminals.subscribe(() => queueMicrotask(() => this.sync()), output => this.receive(output))
  }

  get alive(): boolean { return this.enabled && !this.disposed && this.state === 'ready' && this.matches() && this.connection.getState().status === 'connected' && Boolean(this.shell?.alive) }
  get running(): boolean { return this.shell?.running ?? false }
  get needsConnection(): boolean { return !this.disposed && this.enabled && (this.wantOpen || Boolean(this.sessionId)) }
  get cwd(): string { return this.shell?.cwd || this.lastCwd }
  get transport(): NonNullable<TerminalState['transport']> {
    return { kind: 'web2term', deviceId: this.binding.agentId, deviceName: this.binding.deviceName,
      status: this.state, canClose: !this.disposed && (this.enabled || Boolean(this.sessionId)),
      message: this.message, logPath: this.connection.getState().logPath }
  }

  activate(): void { if (!this.disposed) { this.enabled = true; this.closeRequested = false; this.wantOpen = true; this.sync() } }

  reconnect(): void {
    if (this.disposed) return
    if (!this.matchesAccount()) { this.update('error', '请在设置中登录创建此会话时的后端和账号。'); return }
    this.enabled = true
    this.closeRequested = false
    this.wantOpen = true
    this.update('connecting', '正在重新连接设备终端…')
    if (this.sessionId) {
      if (this.channel && this.shell?.alive) this.channel.close()
      else this.connection.terminals.close(this.sessionId)
    }
    this.connection.connect({ agentId: this.binding.agentId, deviceName: this.binding.deviceName })
    this.sync()
  }

  reset(): void { this.reconnect() }

  /** Close this PTY without deleting its managed workspace, transcript or device binding. */
  close(): void {
    if (this.disposed || (this.closeRequested && this.state === 'closing')) return
    this.enabled = false; this.wantOpen = false
    this.closeRequested = true; this.closeReported = false; this.closeUnconfirmed = false
    this.lastCwd = this.cwd
    this.clearBootTimer()
    this.update('closing', '正在关闭设备终端…')
    // Mark an active command interrupted before finishing the channel; it must not reopen this PTY.
    if (this.shell?.running) void this.shell.interrupt()
    else if (this.channel && this.shell?.alive) this.channel.close()
    else if (this.sessionId && this.connection.terminals.getState().connectionId === this.connectionId) this.connection.terminals.close(this.sessionId)
    this.sync()
  }

  sync(): void {
    if (this.disposed) return
    const connection = this.connection.getState()
    const terminals = this.connection.terminals.getState()
    const entry = terminals.connectionId === this.connectionId ? terminals.sessions.find(item => item.id === this.sessionId) : undefined
    if (this.sessionId) {
      if (!entry || ['closed', 'error', 'disconnected'].includes(entry.status)) {
        this.lastCwd = this.cwd
        this.channel?.finish()
        this.channel = null; this.shell = null; this.sessionId = null
        this.clearBootTimer()
        if (this.closeRequested && !this.enabled && entry?.status !== 'closed') this.closeUnconfirmed = true
        if (!this.wantOpen && !this.closeRequested) this.update(entry?.status === 'error' ? 'error' : 'disconnected', entry?.message || '设备终端已断开，请重新连接。')
      } else if (entry.status === 'ready' && !this.channel && this.enabled) this.bootstrap()
      else if (entry.status === 'closing') {
        if (['CLOSE_TIMEOUT', 'CLOSE_SEND_FAILED'].includes(entry.errorCode)) {
          this.update('error', '设备尚未确认终端关闭，请再次关闭或重新连接。')
          if (this.closeRequested && !this.enabled) { this.closeUnconfirmed = true; this.reportClosed() }
        }
        else if (entry.errorCode && this.shell?.alive) this.channel?.close()
        return
      }
    }
    if (!this.enabled) {
      if (this.closeRequested && !this.sessionId) {
        this.update('disconnected', this.closeUnconfirmed
          ? '连接已断开，设备未确认终端关闭。可重新连接查看设备状态。'
          : '设备终端已关闭，点击重新连接可恢复。')
        this.reportClosed()
      }
      return
    }
    if (!this.matches() || connection.status !== 'connected') {
      this.wantOpen = connection.status === 'connecting' && this.matches()
      const failed = this.matches() && connection.status === 'error'
      this.update(this.wantOpen ? 'connecting' : failed ? 'error' : 'disconnected',
        this.wantOpen ? '正在连接设备…' : failed ? connection.message || '连接设备失败，请重新连接。' : '设备连接已断开，请重新连接。')
      return
    }
    if (!this.sessionId && this.wantOpen) {
      this.wantOpen = false
      this.update('connecting', '正在等待设备创建终端…')
      const opened = this.connection.terminals.open({ cols: 120, rows: 30 })
      this.sessionId = opened.sessionId
      this.connectionId = terminals.connectionId
      if (!opened.ok) this.update('error', opened.message)
    }
  }

  async run(command: string, timeoutMs?: number): Promise<ShellResult> {
    if (!this.alive || !this.shell) return this.reject(this.message || '设备终端未就绪，请重新连接。')
    const shell = this.shell
    const result = await shell.run(command, timeoutMs)
    this.lastCwd = result.cwd
    // A killed/expired shell is replaced only after the tool releases its slot.
    if (this.enabled && !this.disposed && (result.interrupted || result.timedOut || result.sessionLost)) {
      this.wantOpen = this.matches() && this.connection.getState().status === 'connected'
      this.sync()
    }
    this.onChanged()
    return result
  }

  async interrupt(): Promise<boolean> {
    if (!this.enabled || this.disposed || !this.shell?.running) return false
    this.wantOpen = true
    return this.shell.interrupt()
  }

  dispose(): void {
    this.disposed = true; this.enabled = false; this.wantOpen = false
    this.unsubscribe(); this.clearBootTimer()
    this.shell?.dispose()
    if (this.sessionId && !this.channel) this.connection.terminals.close(this.sessionId)
    this.channel = null; this.shell = null
  }

  private bootstrap(): void {
    const id = this.sessionId!
    this.connection.terminals.recordShellEvent(id, 'shell_initializing')
    this.bootToken = '__W2T_READY_' + randomUUID().replace(/-/g, '') + '__'
    this.bootBuffer = Buffer.alloc(0)
    this.channel = new RelayChannel(data => {
      // Envelopes may exceed 16 KiB; each protocol input still obeys that limit.
      for (let offset = 0; offset < data.length; offset += 16 * 1024) {
        const result = this.connection.terminals.input(id, data.subarray(offset, offset + 16 * 1024))
        if (!result.ok) throw new Error('Remote input unavailable')
      }
    }, () => {
      this.connection.terminals.close(id); this.clearBootTimer()
      this.update(this.enabled ? 'connecting' : 'closing', this.enabled ? '正在结束设备终端…' : '正在关闭设备终端…')
    })
    this.shell = new RemoteShell(this.channel, { onOutput: chunk => this.onOutput(chunk) })
    // Remove PTY echo/canonical line limits and prompts before command framing.
    // The initial interactive shell execs sh; this still occupies exactly one PTY.
    this.bootTimer = setTimeout(() => {
      this.connection.terminals.recordShellEvent(id, 'shell_init_timeout')
      this.channel?.close()
      this.update('error', '设备 Shell 未在 10 秒内就绪，请重新连接。')
    }, 10_000)
    this.bootTimer.unref()
    try {
      this.channel.write(`stty -echo -icanon && { unset ENV BASH_ENV; export PS1='' PS2='' TERM=dumb; printf '\\n%s\\n' '${this.bootToken}'; if command -v bash >/dev/null 2>&1; then export SHELL="$(command -v bash)"; exec "$SHELL" --noprofile --norc +i -s; else export SHELL=/bin/sh; exec /bin/sh +i -s; fi; }\n`)
    } catch {
      this.connection.terminals.recordShellEvent(id, 'shell_init_failed')
      this.channel.close(); this.update('error', '无法初始化设备 Shell，请重新连接。')
    }
  }

  private receive(output: Web2termTerminalOutput): void {
    if (this.disposed || !this.enabled || output.sessionId !== this.sessionId || output.connectionId !== this.connectionId || !this.channel) return
    const bytes = Buffer.from(output.data, 'base64')
    if (!this.bootToken) { this.channel.emit('data', bytes); return }
    this.bootBuffer = Buffer.concat([this.bootBuffer, bytes])
    if (this.bootBuffer.length > 64 * 1024) {
      this.connection.terminals.recordShellEvent(this.sessionId!, 'shell_init_failed')
      this.channel.close(); this.update('error', '设备 Shell 初始化响应异常，请重新连接。'); return
    }
    let newline: number
    while ((newline = this.bootBuffer.indexOf('\n')) >= 0) {
      const line = this.bootBuffer.subarray(0, newline).toString('utf8').replace(/\r$/, '')
      this.bootBuffer = this.bootBuffer.subarray(newline + 1)
      if (line !== this.bootToken) continue
      this.bootToken = ''; this.clearBootTimer()
      if (this.bootBuffer.length) this.channel.emit('data', this.bootBuffer)
      this.bootBuffer = Buffer.alloc(0)
      void this.finishBootstrap(this.shell!, this.channel)
      return
    }
  }

  private async finishBootstrap(shell: RemoteShell, channel: RelayChannel): Promise<void> {
    if (this.lastCwd) {
      const path = "'" + this.lastCwd.replace(/'/g, "'\\''") + "'"
      const result = await shell.run('cd ' + path, 10_000, true)
      this.lastCwd = result.cwd
    }
    if (this.disposed || !this.enabled || this.shell !== shell || this.channel !== channel || !shell.alive) return
    this.connection.terminals.recordShellEvent(this.sessionId!, 'shell_ready')
    this.update('ready', '设备终端已就绪。')
    this.onReady()
  }

  private matchesAccount(): boolean {
    const auth = this.connection.getState().auth
    return auth.status === 'signed-in' && auth.backendUrl === this.binding.backendUrl && auth.user?.publicId === this.binding.userId
  }
  private matches(): boolean { return this.matchesAccount() && this.connection.getState().agentId === this.binding.agentId }
  private clearBootTimer(): void { if (this.bootTimer) clearTimeout(this.bootTimer); this.bootTimer = null }
  private reportClosed(): void {
    if (this.closeReported) return
    this.closeReported = true
    this.onClosed(this.closeUnconfirmed)
  }
  private update(status: typeof this.state, message: string): void {
    if (this.state === status && this.message === message) return
    this.state = status; this.message = message; this.onChanged(message)
  }
  private reject(message: string): ShellResult {
    return { output: message, exitCode: null, timedOut: false, interrupted: false, rejected: true, sessionLost: false, cwd: this.cwd }
  }
}
