import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { normalizeBackendUrl } from '../shared/backend-url'
import type { BackendAuthResult, BackendAuthState, BackendLoginCodeDraft, BackendLoginDraft, BackendUser, Web2termDevice } from '../shared/types'
import type { ConversationStore } from './db'

const URL_KEY = 'backendUrl'
const AUTH_KEY = 'backendAuth'
const REQUEST_TIMEOUT_MS = 20_000
const MAX_RESPONSE_BYTES = 64 * 1024
const MAX_DEVICE_RESPONSE_BYTES = 8 * 1024 * 1024

interface SavedLogin {
  backendUrl: string
  accessToken: string
  tokenType: 'Bearer'
  expiresAt: string
  user: BackendUser
}

/** Main-process credential access; never expose this through IPC. */
export interface BackendConnectionCredentials {
  backendUrl: string
  accessToken: string
  expiresAt: number
}

interface LoginLog {
  path: string | null
  write(record: Record<string, string | number>): void
}

interface AuthDependencies {
  encrypt(value: string): string
  decrypt(value: string): string
  onBackendUrlSaved(value: string): void
  onLoginChanged?(): void
  request?: typeof fetch
  now?: () => number
  log?: LoginLog
}

class AuthError extends Error {
  constructor(message: string, readonly category: string, readonly retryAfterSeconds?: number) {
    super(message)
  }
}

/** Metadata only: never log email, code, token, headers or response bodies. */
function createLoginLog(): LoginLog {
  const log: LoginLog = {
    path: null,
    write(record) {
      try {
        if (!log.path) {
          const directory = join(tmpdir(), 'gpt-login-diag')
          mkdirSync(directory, { recursive: true })
          const file = join(directory, `web2term-desktop-login-${Date.now()}-${randomUUID()}.log`)
          writeFileSync(file, '', { flag: 'wx', mode: 0o600 })
          log.path = file
        }
        appendFileSync(log.path, JSON.stringify({ time: new Date().toISOString(), ...record }) + '\n')
      } catch {
        // A diagnostic failure must not interrupt login.
      }
    }
  }
  return log
}

function emailAddress(value: unknown): string {
  if (typeof value !== 'string') throw new AuthError('请输入有效的邮箱地址。', 'invalid_email')
  const email = value.trim()
  if (email.length > 254 || !/^[^\s@<>]+@[^\s@<>]+$/u.test(email)) {
    throw new AuthError('请输入有效的邮箱地址。', 'invalid_email')
  }
  return email
}

function requiredUrl(value: unknown): string {
  let url: string
  try { url = normalizeBackendUrl(value) } catch {
    throw new AuthError('后端地址无效，请检查 HTTP/HTTPS 地址、端口和部署路径。', 'invalid_url')
  }
  if (!url) throw new AuthError('请先填写后端地址。', 'missing_url')
  return url
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function readUser(value: unknown): BackendUser {
  const user = object(value)
  for (const key of ['publicId', 'email', 'nickname', 'role']) {
    if (typeof user[key] !== 'string' || !(user[key] as string).trim() || (user[key] as string).length > 1024) {
      throw new AuthError('后端返回的用户信息不完整，请检查登录接口。', 'invalid_response')
    }
  }
  if (user.avatarUrl !== null && typeof user.avatarUrl !== 'string') {
    throw new AuthError('后端返回的用户信息格式不正确。', 'invalid_response')
  }
  return { publicId: user.publicId as string, email: user.email as string, nickname: user.nickname as string, avatarUrl: user.avatarUrl as string | null, role: user.role as string }
}

async function readBody(response: Response, maximumBytes = MAX_RESPONSE_BYTES): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > maximumBytes) {
        await reader.cancel()
        throw new AuthError('后端响应过大，请检查接口。', 'invalid_response')
      }
      chunks.push(chunk.value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks).toString('utf8')
}

const ERROR_MESSAGES: Record<string, string> = {
  INVALID_REQUEST: '请求参数不正确，请检查邮箱和验证码。',
  INVALID_EMAIL: '邮箱格式不正确，请检查后重试。',
  INVALID_LOGIN_CODE: '验证码必须是 6 位数字。',
  LOGIN_CODE_TOO_FREQUENT: '验证码发送过于频繁，请稍后重新获取。',
  LOGIN_CODE_SEND_FAILED: '验证码邮件发送失败，请稍后重试。',
  LOGIN_CODE_INCORRECT: '验证码错误或已过期，请重新输入或获取新验证码。',
  USER_NOT_AVAILABLE: '用户不存在或当前不可用，请联系管理员。',
  USER_DISABLED: '账号已被禁用，请联系管理员。'
}

function networkFailure(error: unknown): AuthError {
  if (error instanceof AuthError) return error
  const outer = object(error)
  const cause = object(outer.cause)
  const code = typeof cause.code === 'string' ? cause.code : outer.code
  if (outer.name === 'TimeoutError' || outer.name === 'AbortError') {
    return new AuthError('请求超时，请检查后端地址和网络后重试。', 'timeout')
  }
  if (code === 'ECONNREFUSED') return new AuthError('后端拒绝连接，请检查服务是否启动及端口是否正确。', 'connection_refused')
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new AuthError('无法解析后端域名，请检查地址和 DNS。', 'dns')
  if (typeof code === 'string' && /CERT|SSL|TLS/u.test(code)) {
    return new AuthError('HTTPS 证书校验失败，请检查后端证书和系统时间。', 'tls')
  }
  return new AuthError('无法连接后端，请检查地址、网络和 TLS 证书后重试。', 'network')
}

/** Requests run outside Chromium; the renderer receives no access token. */
export class BackendAuthService {
  private readonly request: typeof fetch
  private readonly now: () => number
  private readonly log: LoginLog
  private busy = false
  private generation = 0

  constructor(private readonly store: Pick<ConversationStore, 'getSetting' | 'setSettings'>, private readonly dependencies: AuthDependencies) {
    this.request = dependencies.request ?? fetch
    this.now = dependencies.now ?? Date.now
    this.log = dependencies.log ?? createLoginLog()
  }

  getState(): BackendAuthState {
    const backendUrl = this.store.getSetting(URL_KEY) ?? ''
    const signedOut: BackendAuthState = { backendUrl, status: 'signed-out', user: null, expiresAt: null }
    const secret = this.store.getSetting(AUTH_KEY)
    if (!secret) return signedOut
    try {
      const saved = object(JSON.parse(this.dependencies.decrypt(secret)))
      if (saved.backendUrl !== backendUrl || typeof saved.accessToken !== 'string' || !saved.accessToken || saved.tokenType !== 'Bearer') return signedOut
      const expiry = typeof saved.expiresAt === 'string' ? Date.parse(saved.expiresAt) : NaN
      if (!Number.isFinite(expiry)) return signedOut
      return { backendUrl, status: expiry > this.now() ? 'signed-in' : 'expired', user: readUser(saved.user), expiresAt: saved.expiresAt as string }
    } catch {
      return signedOut
    }
  }

  getConnectionCredentials(): BackendConnectionCredentials | null {
    if (this.getState().status !== 'signed-in') return null
    try {
      const saved = object(JSON.parse(this.dependencies.decrypt(this.store.getSetting(AUTH_KEY) ?? '')))
      if (typeof saved.accessToken !== 'string' || saved.accessToken.length > 16384 || /\s/u.test(saved.accessToken)) return null
      return { backendUrl: saved.backendUrl as string, accessToken: saved.accessToken, expiresAt: Date.parse(saved.expiresAt as string) }
    } catch { return null }
  }

  /** Authenticated GET; return only device display fields, never credentials or raw bodies. */
  async listDevices(): Promise<BackendAuthResult<Web2termDevice[]>> {
    const endpoint = '/api/user/devices'
    const started = this.now()
    try {
      const credentials = this.getConnectionCredentials()
      const auth = this.getState()
      if (!credentials) throw new AuthError(auth.status === 'expired' ? '登录已过期，请重新登录后查看设备。' : '请先登录后查看当前账号的设备。', 'login_required')
      this.log.write({ event: 'devices_request_start', endpoint })
      const response = await this.request(credentials.backendUrl.replace(/\/$/u, '') + endpoint, {
        method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${credentials.accessToken}` },
        redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
      this.log.write({ event: 'devices_response', endpoint, status: response.status, elapsedMs: this.now() - started })
      if (response.status !== 200) {
        await response.body?.cancel()
        const message = response.status === 401 ? '登录凭据被后端拒绝，请重新登录后刷新设备。' :
          response.status === 403 ? '当前账号没有查询设备的权限，请检查账号状态。' :
          response.status === 404 ? '设备列表接口不存在，请检查后端地址和部署路径。' :
          response.status >= 300 && response.status < 400 ? '后端返回了重定向，请配置最终服务地址后重新登录。' :
          response.status === 429 ? '设备查询过于频繁，请稍后刷新。' :
          response.status >= 500 ? '后端设备服务暂时异常，请稍后刷新。' : '后端未接受设备查询，请稍后刷新。'
        throw new AuthError(message, `devices_http_${response.status}`)
      }
      const body = await readBody(response, MAX_DEVICE_RESPONSE_BYTES)
      let data: unknown
      try { data = JSON.parse(body) } catch { throw new AuthError('设备列表响应格式不正确，请检查后端接口。', 'devices_invalid_response') }
      if (!Array.isArray(data)) throw new AuthError('设备列表应为数组，请检查后端接口。', 'devices_invalid_response')
      const ids = new Set<string>()
      const devices: Web2termDevice[] = data.map((value) => {
        const device = object(value)
        const id = typeof device.deviceId === 'string' ? device.deviceId.toLowerCase() : ''
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(id) || ids.has(id) ||
            typeof device.deviceName !== 'string' || !device.deviceName.trim() || device.deviceName.length > 100 ||
            (device.enabled !== 0 && device.enabled !== 1) || (device.onlineStatus !== 0 && device.onlineStatus !== 1)) {
          throw new AuthError('设备列表包含无效信息，请检查后端接口后刷新。', 'devices_invalid_response')
        }
        ids.add(id)
        return { deviceId: id, deviceName: device.deviceName, enabled: device.enabled, onlineStatus: device.onlineStatus }
      })
      const current = this.getConnectionCredentials()
      if (!current || current.backendUrl !== credentials.backendUrl || current.accessToken !== credentials.accessToken || this.getState().user?.publicId !== auth.user?.publicId) {
        throw new AuthError('后端地址或登录状态已变化，请重新加载设备列表。', 'devices_identity_changed')
      }
      this.log.write({ event: 'devices_success', count: devices.length, elapsedMs: this.now() - started })
      return { ok: true, value: devices, logPath: this.log.path }
    } catch (error) {
      const failure = networkFailure(error)
      this.log.write({ event: 'devices_failed', category: failure.category, elapsedMs: this.now() - started })
      return { ok: false, message: failure.message, logPath: this.log.path }
    }
  }

  /** A login for one server must never be reused after changing servers. */
  setBackendUrl(backendUrl: string): void {
    if (backendUrl === (this.store.getSetting(URL_KEY) ?? '')) return
    this.store.setSettings({ [URL_KEY]: backendUrl, [AUTH_KEY]: '' })
    this.generation++
    this.dependencies.onLoginChanged?.()
  }

  private async post(backendUrl: string, endpoint: string, body: Record<string, string>, expectedStatus: number): Promise<unknown> {
    const started = this.now()
    this.log.write({ event: 'request_start', endpoint })
    try {
      const response = await this.request(backendUrl.replace(/\/$/u, '') + endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
      this.log.write({ event: 'response', endpoint, status: response.status, elapsedMs: this.now() - started })
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel()
        throw new AuthError('后端返回了重定向，请直接填写最终服务地址。', 'redirect')
      }
      const text = await readBody(response)
      let data: unknown
      try { data = text ? JSON.parse(text) : null } catch { data = null }
      if (response.status !== expectedStatus) {
        const errorCode = object(data).code
        const message = typeof errorCode === 'string' && Object.hasOwn(ERROR_MESSAGES, errorCode) ? ERROR_MESSAGES[errorCode] :
          response.status === 429 ? ERROR_MESSAGES.LOGIN_CODE_TOO_FREQUENT :
          response.status === 404 ? '登录接口不存在，请检查后端地址及部署路径。' :
          response.status >= 500 ? '后端服务暂时异常，请稍后重试。' :
          response.status === 401 ? '登录被拒绝，请检查验证码后重试。' :
          response.status === 403 ? '后端拒绝了登录请求，请联系管理员。' :
          '后端响应不符合登录接口约定，请检查后端地址。'
        const retryHeader = Number(response.headers.get('retry-after'))
        throw new AuthError(message, `http_${response.status}`, response.status === 429 ? (Number.isFinite(retryHeader) && retryHeader > 0 ? Math.min(3600, Math.ceil(retryHeader)) : 60) : undefined)
      }
      return data
    } catch (error) {
      const failure = networkFailure(error)
      this.log.write({ event: 'request_failed', endpoint, category: failure.category, elapsedMs: this.now() - started })
      throw failure
    }
  }

  private async operation<T>(name: string, action: () => Promise<T>): Promise<BackendAuthResult<T>> {
    if (this.busy) return { ok: false, message: '已有登录请求正在处理，请稍候。', logPath: this.log.path }
    this.busy = true
    try {
      const value = await action()
      this.log.write({ event: `${name}_success` })
      return { ok: true, value, logPath: this.log.path }
    } catch (error) {
      const failure = error instanceof AuthError ? error : new AuthError('登录信息保存失败，请检查本地存储后重试。', 'storage')
      this.log.write({ event: `${name}_failed`, category: failure.category })
      return { ok: false, message: failure.message, logPath: this.log.path, retryAfterSeconds: failure.retryAfterSeconds }
    } finally { this.busy = false }
  }

  sendCode(draft: BackendLoginCodeDraft): Promise<BackendAuthResult<{ resendAfterSeconds: number }>> {
    return this.operation('send_code', async () => {
      const backendUrl = requiredUrl(draft?.backendUrl)
      const email = emailAddress(draft?.email)
      await this.post(backendUrl, '/api/user/login/code', { email }, 204)
      return { resendAfterSeconds: 60 }
    })
  }

  login(draft: BackendLoginDraft): Promise<BackendAuthResult<BackendAuthState>> {
    return this.operation('login', async () => {
      const backendUrl = requiredUrl(draft?.backendUrl)
      const email = emailAddress(draft?.email)
      const code = typeof draft?.code === 'string' ? draft.code.trim() : ''
      if (!/^\d{6}$/u.test(code)) throw new AuthError('验证码必须是 6 位数字。', 'invalid_code')
      const generation = this.generation
      const previousUrl = this.store.getSetting(URL_KEY) ?? ''
      const data = object(await this.post(backendUrl, '/api/user/login', { email, code }, 200))
      if (typeof data.accessToken !== 'string' || !data.accessToken || data.accessToken.length > 16384 || /\s/u.test(data.accessToken) || data.tokenType !== 'Bearer') {
        throw new AuthError('后端返回的登录凭据格式不正确。', 'invalid_response')
      }
      if (typeof data.expiresInSeconds !== 'number' || !Number.isSafeInteger(data.expiresInSeconds) || data.expiresInSeconds <= 0) {
        throw new AuthError('后端返回的登录有效期不正确。', 'invalid_response')
      }
      const expiresAt = this.now() + data.expiresInSeconds * 1000
      if (!Number.isFinite(expiresAt) || expiresAt > 8.64e15) throw new AuthError('后端返回的登录有效期超出范围。', 'invalid_response')
      const saved: SavedLogin = { backendUrl, accessToken: data.accessToken, tokenType: 'Bearer', expiresAt: new Date(expiresAt).toISOString(), user: readUser(data.user) }
      if (saved.user.email.toLowerCase() !== email.toLowerCase()) throw new AuthError('后端返回的登录邮箱与请求不一致。', 'invalid_response')
      if (generation !== this.generation || previousUrl !== (this.store.getSetting(URL_KEY) ?? '')) {
        throw new AuthError('后端地址已变更，请重新打开登录。', 'server_changed')
      }
      let secret: string
      try { secret = this.dependencies.encrypt(JSON.stringify(saved)) } catch {
        throw new AuthError('无法加密保存登录信息，请检查系统凭据存储后重试。', 'encryption')
      }
      if (!secret) throw new AuthError('无法加密保存登录信息，请重试。', 'encryption')
      this.store.setSettings({ [URL_KEY]: backendUrl, [AUTH_KEY]: secret })
      this.dependencies.onBackendUrlSaved(backendUrl)
      this.dependencies.onLoginChanged?.()
      return { backendUrl, status: 'signed-in', user: saved.user, expiresAt: saved.expiresAt }
    })
  }
}
