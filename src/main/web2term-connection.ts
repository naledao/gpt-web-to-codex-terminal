import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import type { ClientOptions } from 'ws'
import { normalizeBackendUrl } from '../shared/backend-url'
import type { BackendAuthState, Web2termConnectDraft, Web2termConnectionState, Web2termTerminalsState, Web2termTerminalOutput } from '../shared/types'
import { Web2termTerminals } from './web2term-terminals'
import type { BackendAuthService } from './backend-auth'
import type { ConversationStore } from './db'

const CLIENT_ID_KEY = 'web2termDesktopClientId'
const TARGET_KEY = 'web2termTargetAgent'
const HANDSHAKE_TIMEOUT = 10_000
const MAX_TIMER = 2_147_483_647
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

interface ConnectionLog {
  path: string | null
  write(record: Record<string, string | number>): void
}
interface Dependencies {
  changed(state: Web2termConnectionState): void
  terminalsChanged?(state: Web2termTerminalsState): void
  terminalOutput?(output: Web2termTerminalOutput): void
  createSocket?(url: string, options: ClientOptions): WebSocket
  now?(): number
  log?: ConnectionLog
  schedule?(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>
  unschedule?(handle: ReturnType<typeof setTimeout>): void
}
type DesktopClientOptions = ClientOptions & { closeTimeout: number }

/** Preserve deployment paths and IPv6; credentials are supplied only as headers. */
export function desktopWebSocketUrl(backendUrl: string): string {
  const base = normalizeBackendUrl(backendUrl)
  if (!base) throw new Error('后端地址未配置。')
  const url = new URL(base)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = url.pathname.replace(/\/+$/u, '') + '/ws/desktop'
  return url.toString()
}

function connectionLog(): ConnectionLog {
  const log: ConnectionLog = {
    path: null,
    write(record) {
      try {
        if (!log.path) {
          const directory = join(tmpdir(), 'gpt-login-diag')
          mkdirSync(directory, { recursive: true })
          const file = join(directory, `web2term-desktop-connect-${Date.now()}-${randomUUID()}.log`)
          writeFileSync(file, '', { flag: 'wx', mode: 0o600 })
          log.path = file
        }
        appendFileSync(log.path, JSON.stringify({ time: new Date().toISOString(), ...record }) + '\n')
      } catch { /* Keep connection operations available if diagnostic writes fail. */ }
    }
  }
  return log
}

function errorCategory(error: unknown): string {
  const value = error as { code?: unknown; message?: unknown } | null
  const code = value?.code
  if (code === 'ECONNREFUSED') return 'connection_refused'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns'
  if (code === 'ETIMEDOUT' || value?.message === 'Opening handshake has timed out') return 'timeout'
  if (typeof code === 'string' && /CERT|SSL|TLS/u.test(code)) return 'tls'
  if (typeof code === 'string' && code.startsWith('WS_ERR_')) return 'protocol'
  return 'network'
}
const FAILURE_MESSAGES: Record<string, string> = {
  connection_refused: '后端拒绝连接，请检查服务是否启动及端口是否正确。',
  dns: '无法解析后端域名，请检查地址和 DNS。',
  timeout: '连接后端超时，请检查地址和网络后重试。',
  tls: '后端 TLS 证书校验失败，请检查证书和系统时间。',
  protocol: '后端 WebSocket 响应不符合协议，请检查服务配置。',
  network: '后端连接异常，请检查网络后重新连接。'
}
function handshakeMessage(status: number): string {
  if (status === 401) return '登录凭据被后端拒绝，请重新登录后连接。'
  if (status === 403) return '后端拒绝连接，请确认设备属于当前账号且已启用，并检查账号权限。'
  if (status === 400) return '后端拒绝桌面端握手参数，请检查设备 ID、桌面客户端 ID 和后端配置。'
  if (status === 404) return '后端未找到设备或 /ws/desktop，请检查设备 ID、后端地址和部署路径。'
  if (status === 409) return '设备已被占用，无法建立连接。请先断开已有的客户端连接，再重试。'
  if (status >= 300 && status < 400) return '后端返回了重定向，请填写最终服务地址后重新登录。'
  if (status >= 500) return `后端服务暂时异常（HTTP ${status}），请稍后重新连接。`
  return `后端未接受 WebSocket 连接（HTTP ${status}），请检查服务配置。`
}

/** One app-wide socket. Switching screens never creates a competing client ID connection. */
export class Web2termConnection {
  readonly terminals: Web2termTerminals
  private socket: WebSocket | null = null
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null
  private expiryTimer: ReturnType<typeof setTimeout> | null = null
  private readonly now: () => number
  private readonly log: ConnectionLog
  private readonly schedule: NonNullable<Dependencies['schedule']>
  private readonly unschedule: NonNullable<Dependencies['unschedule']>
  private revision = 0
  private status: Web2termConnectionState['status'] = 'idle'
  private url = ''
  private clientId = ''
  private agentId = ''
  private deviceName = ''
  private connectedAt: string | null = null
  private message = ''
  private disposed = false
  private releasing = false

  constructor(
    private readonly store: Pick<ConversationStore, 'getSetting' | 'setSettings'>,
    private readonly auth: Pick<BackendAuthService, 'getState' | 'getConnectionCredentials'>,
    private readonly dependencies: Dependencies
  ) {
    this.now = dependencies.now ?? Date.now
    this.log = dependencies.log ?? connectionLog()
    this.schedule = dependencies.schedule ?? setTimeout
    this.unschedule = dependencies.unschedule ?? clearTimeout
    this.terminals = new Web2termTerminals({
      send: (message) => this.sendTerminalMessage(message),
      changed: (state) => dependencies.terminalsChanged?.(state),
      output: (output) => dependencies.terminalOutput?.(output),
      log: (record) => this.log.write(record),
      schedule: this.schedule, unschedule: this.unschedule
    })
  }

  getState(): Web2termConnectionState {
    const auth = this.auth.getState()
    const target = this.savedTarget(auth)
    let url = ''
    try { url = desktopWebSocketUrl(auth.backendUrl) } catch { /* Not configured yet. */ }
    return {
      revision: this.revision, status: this.status, auth,
      webSocketUrl: this.socket ? this.url : url, desktopClientId: this.clientId,
      agentId: this.socket ? this.agentId : target.agentId,
      deviceName: this.socket ? this.deviceName : target.deviceName,
      connectedAt: this.connectedAt, message: this.message, logPath: this.log.path
    }
  }

  connect(draft: Web2termConnectDraft): Web2termConnectionState {
    if (this.disposed) return this.getState()
    const auth = this.auth.getState()
    const credentials = this.auth.getConnectionCredentials()
    if (!credentials || credentials.expiresAt <= this.now()) {
      this.fail(!auth.backendUrl ? '请先配置后端地址并登录。' : auth.status === 'expired' ? '登录已过期，请重新登录后连接。' : '请先登录当前后端。')
      return this.getState()
    }
    const agentId = draft && typeof draft.agentId === 'string' ? draft.agentId.trim().toLowerCase() : ''
    if (!UUID.test(agentId)) {
      if (this.socket) return this.getState()
      this.setState('error', '设备 ID 格式无效，请刷新设备列表后重新选择。')
      return this.getState()
    }
    if (this.socket && this.agentId === agentId) return this.getState()
    // An explicit click on another device replaces the current transport.
    if (this.socket) this.disconnect()
    try {
      this.url = desktopWebSocketUrl(credentials.backendUrl)
      const stored = this.store.getSetting(CLIENT_ID_KEY)
      if (stored && !UUID.test(stored.toLowerCase())) throw new Error('invalid client id')
      this.clientId = stored?.toLowerCase() || randomUUID()
      this.agentId = agentId
      this.deviceName = typeof draft.deviceName === 'string' && draft.deviceName.trim() && draft.deviceName.length <= 100 ? draft.deviceName.trim() : agentId
      const target = JSON.stringify({ backendUrl: credentials.backendUrl, publicId: auth.user?.publicId, agentId, deviceName: this.deviceName })
      const fields: Record<string, string> = {}
      if (stored !== this.clientId) fields[CLIENT_ID_KEY] = this.clientId
      if (this.store.getSetting(TARGET_KEY) !== target) fields[TARGET_KEY] = target
      if (Object.keys(fields).length) this.store.setSettings(fields)
    } catch {
      this.setState('error', '无法读取或保存连接配置，请检查本地配置和存储后重试。')
      return this.getState()
    }
    this.log.write({ event: 'connect_started', url: this.url, desktopClientId: this.clientId, agentId, timeoutMs: HANDSHAKE_TIMEOUT })
    this.terminals.reset()
    this.setState('connecting', '正在连接后端…')
    try {
      const options: DesktopClientOptions = {
        headers: { Authorization: `Bearer ${credentials.accessToken}`, 'X-Desktop-Client-Id': this.clientId, 'X-Agent-Id': agentId },
        followRedirects: false, handshakeTimeout: HANDSHAKE_TIMEOUT, closeTimeout: 3000,
        maxPayload: 64 * 1024, perMessageDeflate: false
      }
      const socket = this.dependencies.createSocket ? this.dependencies.createSocket(this.url, options) : new WebSocket(this.url, options)
      this.socket = socket
      const current = (): boolean => this.socket === socket && !this.disposed
      socket.on('open', () => {
        if (!current()) return
        this.clearHandshakeTimer()
        this.connectedAt = new Date(this.now()).toISOString()
        this.log.write({ event: 'connected', desktopClientId: this.clientId })
        this.setState('connected', '已连接后端。')
        this.terminals.attach()
      })
      socket.on('unexpected-response', (request, response) => {
        // Abort without reading bodies/headers or following redirects with credentials.
        const status = response.statusCode ?? 0
        if (current()) {
          this.log.write({ event: 'handshake_rejected', status })
          this.fail(handshakeMessage(status))
        }
        response.destroy()
        request.destroy()
      })
      socket.on('error', (error) => {
        if (!current()) return // Keep an error listener for retired sockets' late events.
        const category = errorCategory(error)
        this.log.write({ event: 'connection_error', category })
        this.fail(FAILURE_MESSAGES[category])
      })
      socket.on('close', (code) => {
        if (!current()) return
        this.log.write({ event: 'connection_closed', code })
        this.releaseSocket()
        this.setState('disconnected', code === 1000 ? '后端已关闭连接，可以重新连接。' : `后端连接已断开（${code}），请重新连接。`)
      })
      socket.on('message', (data, binary) => {
        if (!current()) return
        const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)
        this.terminals.receive(bytes, binary)
      })
      this.handshakeTimer = this.schedule(() => {
        if (!current() || this.status !== 'connecting') return
        this.log.write({ event: 'handshake_timeout', timeoutMs: HANDSHAKE_TIMEOUT })
        this.fail(FAILURE_MESSAGES.timeout)
      }, HANDSHAKE_TIMEOUT)
      this.handshakeTimer.unref?.()
      this.scheduleExpiry(credentials.expiresAt)
    } catch (error) {
      const category = errorCategory(error)
      this.log.write({ event: 'connection_error', category })
      this.fail(FAILURE_MESSAGES[category])
    }
    return this.getState()
  }

  disconnect(): Web2termConnectionState {
    if (this.socket) this.log.write({ event: 'disconnect_requested', desktopClientId: this.clientId })
    this.releaseSocket()
    this.setState('disconnected', '已断开后端连接。')
    return this.getState()
  }

  close(): Web2termConnectionState {
    this.disconnect()
    this.setState('idle', '')
    return this.getState()
  }

  credentialsChanged(): void {
    const connected = Boolean(this.socket)
    this.releaseSocket()
    this.terminals.reset()
    this.setState(connected ? 'disconnected' : 'idle', connected ? '后端地址或登录信息已更新，请重新连接。' : '')
    if (connected) this.log.write({ event: 'credentials_changed' })
  }

  dispose(): void {
    this.disposed = true
    this.releaseSocket()
  }

  private setState(status: Web2termConnectionState['status'], message: string): void {
    this.status = status
    this.message = message
    this.revision++
    this.dependencies.changed(this.getState())
  }
  private savedTarget(auth: BackendAuthState): { agentId: string; deviceName: string } {
    const empty = { agentId: '', deviceName: '' }
    if (!auth.user) return empty
    try {
      const saved = JSON.parse(this.store.getSetting(TARGET_KEY) ?? 'null') as Record<string, unknown> | null
      if (saved?.backendUrl !== auth.backendUrl || saved?.publicId !== auth.user.publicId || typeof saved?.agentId !== 'string' || !UUID.test(saved.agentId)) return empty
      return { agentId: saved.agentId, deviceName: typeof saved.deviceName === 'string' && saved.deviceName.length <= 100 ? saved.deviceName : saved.agentId }
    } catch { return empty }
  }
  private fail(message: string): void {
    this.releaseSocket()
    this.setState('error', message)
  }
  private clearHandshakeTimer(): void {
    if (this.handshakeTimer) this.unschedule(this.handshakeTimer)
    this.handshakeTimer = null
  }
  private releaseSocket(): void {
    this.clearHandshakeTimer()
    if (this.expiryTimer) this.unschedule(this.expiryTimer)
    this.expiryTimer = null
    const socket = this.socket
    this.releasing = true
    this.terminals.disconnect(socket?.readyState === WebSocket.OPEN)
    this.socket = null // Retired callbacks cannot overwrite a newer connection.
    this.releasing = false
    this.connectedAt = null
    if (!socket) return
    if (socket.readyState === WebSocket.OPEN) socket.close(1000, 'desktop disconnected')
    else if (socket.readyState !== WebSocket.CLOSED) socket.terminate()
  }
  private sendTerminalMessage(message: Record<string, unknown>): boolean {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 256 * 1024) return false
    try {
      socket.send(JSON.stringify(message), (error) => {
        if (!error || this.socket !== socket || this.releasing || this.disposed) return
        this.log.write({ event: 'terminal_send_failed', category: errorCategory(error) })
        this.fail('终端消息发送失败，连接已关闭，请重新连接。')
      })
      return true
    } catch {
      this.log.write({ event: 'terminal_send_failed', category: 'network' })
      return false
    }
  }
  private scheduleExpiry(expiresAt: number): void {
    const delay = Math.min(MAX_TIMER, Math.max(1, expiresAt - this.now()))
    this.expiryTimer = this.schedule(() => {
      this.expiryTimer = null
      if (!this.socket || this.disposed) return
      if (this.now() < expiresAt) { this.scheduleExpiry(expiresAt); return }
      this.log.write({ event: 'login_expired' })
      this.fail('登录已过期，连接已关闭。请重新登录后连接。')
    }, delay)
    this.expiryTimer.unref?.()
  }
}
