import { randomUUID } from 'node:crypto'
import type { Web2termTerminalBuffer, Web2termTerminalOutput, Web2termTerminalResult, Web2termTerminalSession, Web2termTerminalSize, Web2termTerminalsState } from '../shared/types'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const MAX_TERMINALS = 3
const MAX_DATA = 16 * 1024
const HISTORY_BYTES = 1024 * 1024
const REQUEST_TIMEOUT = 10_000
const ERROR_CODES = new Set(['INVALID_SESSION_ID', 'UNSUPPORTED_VERSION', 'UNSUPPORTED_MESSAGE', 'INVALID_PAYLOAD', 'INVALID_SIZE', 'INVALID_INPUT', 'SESSION_EXISTS', 'SESSION_CLOSED', 'SESSION_NOT_FOUND', 'SESSION_CLOSING', 'TERMINAL_LIMIT_REACHED', 'TERMINAL_START_FAILED', 'INPUT_BACKPRESSURE', 'TERMINAL_INPUT_FAILED', 'TERMINAL_OUTPUT_FAILED'])
const active = (session: Web2termTerminalSession): boolean => ['opening', 'ready', 'closing'].includes(session.status)
const sizeValid = (size: Web2termTerminalSize): boolean => Boolean(size && Number.isInteger(size.cols) && Number.isInteger(size.rows) && size.cols >= 1 && size.cols <= 1000 && size.rows >= 1 && size.rows <= 1000)
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))

interface Entry {
  state: Web2termTerminalSession
  timer: ReturnType<typeof setTimeout> | null
  chunks: Web2termTerminalOutput[]
  bytes: number
  sequence: number
  truncated: boolean
}
interface Dependencies {
  send(message: Record<string, unknown>): boolean
  changed(state: Web2termTerminalsState): void
  output(output: Web2termTerminalOutput): void
  log(record: Record<string, string | number>): void
  schedule?(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>
  unschedule?(handle: ReturnType<typeof setTimeout>): void
}

/** Tool protocol v1 over the existing relay. Never starts a local shell or records terminal content. */
export class Web2termTerminals {
  private readonly entries = new Map<string, Entry>()
  private readonly retired = new Set<string>()
  private readonly schedule: NonNullable<Dependencies['schedule']>
  private readonly unschedule: NonNullable<Dependencies['unschedule']>
  private revision = 0
  private connectionId = ''
  private connected = false
  private title = 0
  private readonly stateListeners = new Set<() => void>()
  private readonly outputListeners = new Set<(output: Web2termTerminalOutput) => void>()

  subscribe(changed: () => void, output: (output: Web2termTerminalOutput) => void): () => void {
    this.stateListeners.add(changed)
    this.outputListeners.add(output)
    return () => { this.stateListeners.delete(changed); this.outputListeners.delete(output) }
  }

  recordShellEvent(sessionId: string, event: 'shell_initializing' | 'shell_ready' | 'shell_init_timeout' | 'shell_init_failed'): void {
    this.dependencies.log({ event, sessionId })
  }

  constructor(private readonly dependencies: Dependencies) {
    this.schedule = dependencies.schedule ?? setTimeout
    this.unschedule = dependencies.unschedule ?? clearTimeout
  }

  getState(): Web2termTerminalsState {
    return { revision: this.revision, connectionId: this.connectionId, sessions: [...this.entries.values()].map(({ state }) => ({ ...state })) }
  }

  getBuffer(sessionId: string): Web2termTerminalBuffer | null {
    const entry = this.entries.get(sessionId)
    return entry ? { connectionId: this.connectionId, sessionId, chunks: entry.chunks.map(chunk => ({ ...chunk })), truncated: entry.truncated } : null
  }

  reset(): void {
    for (const entry of this.entries.values()) this.clearTimer(entry)
    this.entries.clear()
    this.retired.clear()
    this.connected = false
    this.connectionId = randomUUID()
    this.title = 0
    this.publish()
  }

  attach(): void {
    this.connected = true
    this.publish()
  }

  /** Best effort before an orderly socket close; an abrupt network loss cannot reach the tool. */
  disconnect(notify: boolean): void {
    this.connected = false
    for (const entry of this.entries.values()) {
      this.clearTimer(entry)
      if (!active(entry.state)) continue
      if (notify) this.send('terminal_close', entry.state.id, {})
      entry.state.status = 'disconnected'
      entry.state.message = '设备通道已断开，请重新连接并新建终端。'
    }
    this.publish()
  }

  open(size: Web2termTerminalSize): Web2termTerminalResult {
    if (!this.connected) return this.result(false, '请先连接设备。')
    if (!sizeValid(size)) return this.result(false, '终端行列数必须为 1 到 1000 的整数。')
    if ([...this.entries.values()].filter(entry => active(entry.state)).length >= MAX_TERMINALS) return this.result(false, '最多同时运行 3 个终端，请先关闭一个终端。')
    // Keep at most three tabs, replacing the oldest completed tab when a slot is reused.
    if (this.entries.size >= MAX_TERMINALS) {
      const old = [...this.entries.values()].find(entry => !active(entry.state))
      if (old) { this.clearTimer(old); this.retire(old.state.id); this.entries.delete(old.state.id) }
    }
    const id = randomUUID()
    const entry: Entry = {
      state: { id, title: `终端 ${++this.title}`, status: 'opening', ...size, shell: '', message: '正在等待设备创建终端…', errorCode: '', exitCode: null },
      timer: null, chunks: [], bytes: 0, sequence: 0, truncated: false
    }
    this.entries.set(id, entry)
    this.publish()
    this.dependencies.log({ event: 'terminal_open_requested', sessionId: id, cols: size.cols, rows: size.rows })
    if (!this.send('terminal_open', id, size)) {
      entry.state.status = 'error'; entry.state.message = '终端请求未发送，请检查设备连接。'; this.publish()
      return this.result(false, entry.state.message, id)
    }
    if (entry.state.status === 'opening') this.arm(entry, () => {
      entry.state.status = 'error'
      entry.state.errorCode = 'OPEN_TIMEOUT'
      entry.state.message = '设备未在 10 秒内确认终端创建，请检查工具是否在线后重试。'
      this.send('terminal_close', id, {})
      this.dependencies.log({ event: 'terminal_open_timeout', sessionId: id })
      this.publish()
    })
    return this.result(true, '', id)
  }

  close(sessionId: string): Web2termTerminalResult {
    const entry = this.entries.get(sessionId)
    if (!entry) return this.result(false, '终端已不存在。')
    if (!active(entry.state)) {
      this.clearTimer(entry); this.retire(sessionId); this.entries.delete(sessionId); this.publish()
      return this.result(true, '', sessionId)
    }
    this.clearTimer(entry)
    entry.state.status = 'closing'; entry.state.errorCode = ''; entry.state.message = '正在关闭终端…'; this.publish()
    this.dependencies.log({ event: 'terminal_close_requested', sessionId })
    if (!this.send('terminal_close', sessionId, {})) {
      if (entry.state.status === 'closing') {
        entry.state.errorCode = 'CLOSE_SEND_FAILED'
        entry.state.message = '关闭请求未发送，请再次关闭或断开设备连接。'
        this.dependencies.log({ event: 'terminal_close_send_failed', sessionId }); this.publish()
      }
      return this.result(false, '关闭请求未发送，请检查设备连接。', sessionId)
    }
    if (entry.state.status === 'closing') this.arm(entry, () => {
      entry.state.errorCode = 'CLOSE_TIMEOUT'
      entry.state.message = '设备尚未确认关闭，可以再次关闭或断开设备连接。'
      this.dependencies.log({ event: 'terminal_close_timeout', sessionId }); this.publish()
    })
    return this.result(true, '', sessionId)
  }

  input(sessionId: string, data: Uint8Array): Web2termTerminalResult {
    const entry = this.entries.get(sessionId)
    if (!this.connected || entry?.state.status !== 'ready') return this.result(false, '终端尚未就绪或已结束。', sessionId)
    if (!(data instanceof Uint8Array) || data.byteLength > MAX_DATA) return this.result(false, '每次终端输入最多 16 KiB。', sessionId)
    // Small input packets work with the current backend's default text-message buffer.
    for (let offset = 0; offset < data.byteLength; offset += 4096) {
      if (!this.send('terminal_input', sessionId, { data: Buffer.from(data.subarray(offset, offset + 4096)).toString('base64') })) return this.result(false, '终端输入未发送，请检查连接。', sessionId)
    }
    return this.result(true, '', sessionId)
  }

  resize(sessionId: string, size: Web2termTerminalSize): Web2termTerminalResult {
    const entry = this.entries.get(sessionId)
    if (!this.connected || entry?.state.status !== 'ready') return this.result(false, '终端尚未就绪或已结束。', sessionId)
    if (!sizeValid(size)) return this.result(false, '终端行列数必须为 1 到 1000 的整数。', sessionId)
    if (size.cols === entry.state.cols && size.rows === entry.state.rows) return this.result(true, '', sessionId)
    if (!this.send('terminal_resize', sessionId, size)) return this.result(false, '终端尺寸未发送，请检查连接。', sessionId)
    entry.state.cols = size.cols; entry.state.rows = size.rows
    this.publish()
    return this.result(true, '', sessionId)
  }

  receive(data: Buffer, binary: boolean): void {
    if (!this.connected) return
    if (binary || data.byteLength > 64 * 1024) { this.invalid('frame'); return }
    let message: unknown
    try { message = JSON.parse(data.toString('utf8')) } catch { this.invalid('json'); return }
    if (!object(message) || typeof message.type !== 'string') { this.invalid('envelope'); return }
    if (message.type === 'agent_hello') { this.dependencies.log({ event: 'agent_hello_received' }); return }
    if (!['terminal_ready', 'terminal_output', 'terminal_resized', 'terminal_exit', 'terminal_error'].includes(message.type)) return
    if (message.version !== 1 || !object(message.payload)) { this.invalid('version_or_payload'); return }
    const id = message.session_id
    if (typeof id !== 'string' || !UUID.test(id)) { this.invalid('session_id'); return }
    const entry = this.entries.get(id)
    if (!entry) {
      // A timed-out creation may complete after its tab was removed. Release that tool slot.
      if (message.type === 'terminal_ready' && this.retired.has(id)) this.send('terminal_close', id, {})
      return
    }
    const payload = message.payload
    if (message.type === 'terminal_ready') {
      if (!sizeValid(payload as unknown as Web2termTerminalSize) || typeof payload.shell !== 'string' || payload.shell.length > 512) { this.invalid('ready'); return }
      if (entry.state.status !== 'opening') {
        if (entry.state.status !== 'ready') this.send('terminal_close', id, {})
        return
      }
      this.clearTimer(entry)
      entry.state.status = 'ready'; entry.state.cols = payload.cols as number; entry.state.rows = payload.rows as number
      entry.state.shell = payload.shell; entry.state.message = ''; entry.state.errorCode = ''
      this.dependencies.log({ event: 'terminal_ready', sessionId: id }); this.publish()
    } else if (message.type === 'terminal_output') {
      const encoded = payload.data
      if (typeof encoded !== 'string' || encoded.length > Math.ceil(MAX_DATA / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) { this.invalid('output'); return }
      const bytes = Buffer.from(encoded, 'base64')
      if (bytes.length > MAX_DATA || bytes.toString('base64') !== encoded) { this.invalid('output'); return }
      if (!active(entry.state)) return
      const output: Web2termTerminalOutput = { connectionId: this.connectionId, sessionId: id, sequence: ++entry.sequence, data: encoded }
      entry.chunks.push(output); entry.bytes += bytes.length
      while (entry.bytes > HISTORY_BYTES || entry.chunks.length > 1024) {
        const removed = entry.chunks.shift()!; entry.bytes -= Buffer.byteLength(removed.data, 'base64'); entry.truncated = true
      }
      this.dependencies.output({ ...output })
      for (const listener of this.outputListeners) listener({ ...output })
    } else if (message.type === 'terminal_resized') {
      if (!sizeValid(payload as unknown as Web2termTerminalSize)) { this.invalid('resize'); return }
      this.dependencies.log({ event: 'terminal_resized', sessionId: id })
    } else if (message.type === 'terminal_exit') {
      if (!Number.isInteger(payload.exit_code) || typeof payload.reason !== 'string') { this.invalid('exit'); return }
      this.clearTimer(entry); entry.state.status = 'closed'; entry.state.exitCode = payload.exit_code as number
      entry.state.message = `终端已结束（退出码 ${entry.state.exitCode}）。`; entry.state.errorCode = ''
      this.dependencies.log({ event: 'terminal_exit', sessionId: id, exitCode: entry.state.exitCode }); this.publish()
    } else {
      if (!active(entry.state)) return
      const code = typeof payload.code === 'string' && ERROR_CODES.has(payload.code) ? payload.code : 'UNKNOWN_TERMINAL_ERROR'
      entry.state.errorCode = code
      entry.state.message = typeof payload.message === 'string' ? payload.message.slice(0, 256) : '工具拒绝了终端请求，请重试。'
      if (entry.state.status === 'opening' || ['SESSION_CLOSED', 'SESSION_NOT_FOUND'].includes(code)) {
        this.clearTimer(entry); entry.state.status = 'error'
      } else if (['INPUT_BACKPRESSURE', 'TERMINAL_INPUT_FAILED', 'TERMINAL_OUTPUT_FAILED'].includes(code) && entry.state.status === 'ready') entry.state.status = 'closing'
      this.dependencies.log({ event: 'terminal_error', sessionId: id, code }); this.publish()
    }
  }

  private send(type: string, sessionId: string, payload: object): boolean {
    return this.dependencies.send({ version: 1, type, session_id: sessionId, payload })
  }
  private retire(id: string): void {
    this.retired.add(id)
    if (this.retired.size > 128) this.retired.delete(this.retired.values().next().value!)
  }
  private arm(entry: Entry, callback: () => void): void {
    this.clearTimer(entry)
    entry.timer = this.schedule(() => { entry.timer = null; if (this.entries.get(entry.state.id) === entry && this.connected) callback() }, REQUEST_TIMEOUT)
    entry.timer.unref?.()
  }
  private clearTimer(entry: Entry): void {
    if (entry.timer) this.unschedule(entry.timer)
    entry.timer = null
  }
  private result(ok: boolean, message: string, sessionId: string | null = null): Web2termTerminalResult { return { ok, message, sessionId } }
  private publish(): void {
    this.revision++
    this.dependencies.changed(this.getState())
    for (const listener of this.stateListeners) listener()
  }
  private invalid(category: string): void { this.dependencies.log({ event: 'terminal_protocol_rejected', category }) }
}
