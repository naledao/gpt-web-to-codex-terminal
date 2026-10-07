import { useEffect, useRef, useState } from 'react'
import type { FormEvent, JSX } from 'react'
import type { BackendAuthState } from '@shared/types'
import { readBackendUrl } from '@shared/backend-url'

interface Props {
  backendUrl: string
  open: boolean
  disabled: boolean
  hideAccountStatus?: boolean
  onCancel(): void
  onBusyChange(busy: boolean): void
  onSignedIn(state: BackendAuthState): void
}

export default function BackendLoginForm({ backendUrl, open, disabled, hideAccountStatus = false, onCancel, onBusyChange, onSignedIn }: Props): JSX.Element {
  const [auth, setAuth] = useState<BackendAuthState | null>(null)
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState<'send-code' | 'login' | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [logPath, setLogPath] = useState<string | null>(null)
  const [resendAt, setResendAt] = useState(0)
  const [now, setNow] = useState(Date.now)
  const emailRef = useRef<HTMLInputElement>(null)
  const codeRef = useRef<HTMLInputElement>(null)
  const alive = useRef(true)
  const authRevision = useRef(0)
  const locked = disabled || busy !== null
  const resendSeconds = Math.max(0, Math.ceil((resendAt - now) / 1000))
  const currentAuth = auth?.backendUrl === readBackendUrl(backendUrl) ? auth : null

  useEffect(() => {
    let cancelled = false
    alive.current = true
    const revision = authRevision.current
    void window.api.getBackendAuthState().then((value) => {
      if (cancelled || revision !== authRevision.current) return
      setAuth(value)
      if (value.user) setEmail((previous) => previous || value.user!.email)
    }).catch(() => {
      if (!cancelled && revision === authRevision.current) setError('读取登录状态失败，请关闭设置后重新打开。')
    })
    return () => { cancelled = true; alive.current = false; onBusyChange(false) }
  }, [onBusyChange])

  useEffect(() => {
    setCode('')
    setError('')
    setNotice('')
    setLogPath(null)
    if (open) emailRef.current?.focus()
  }, [open, backendUrl])

  useEffect(() => {
    setResendAt(0)
    setNow(Date.now())
  }, [backendUrl])

  useEffect(() => {
    if (!resendAt) return
    const timer = window.setInterval(() => {
      const current = Date.now()
      setNow(current)
      if (current >= resendAt) setResendAt(0)
    }, 1000)
    return () => window.clearInterval(timer)
  }, [resendAt])

  const setPending = (value: 'send-code' | 'login' | null): void => {
    setBusy(value)
    onBusyChange(value !== null)
  }

  const finishRequest = (focusCode = true): void => {
    if (!alive.current) return
    setPending(null)
    if (focusCode) requestAnimationFrame(() => { if (alive.current) codeRef.current?.focus() })
  }

  const emailIsValid = (): boolean => {
    if (emailRef.current?.checkValidity() && email.trim()) return true
    setError('请输入有效的邮箱地址。')
    emailRef.current?.focus()
    return false
  }

  const sendCode = async (): Promise<void> => {
    if (locked || resendSeconds || !emailIsValid()) return
    setPending('send-code')
    setError('')
    setNotice('')
    setCode('')
    try {
      const result = await window.api.sendBackendLoginCode({ backendUrl, email: email.trim() })
      if (!alive.current) return
      setLogPath(result.logPath)
      if (!result.ok) {
        setError(result.message)
        if (result.retryAfterSeconds) { setNow(Date.now()); setResendAt(Date.now() + result.retryAfterSeconds * 1000) }
        return
      }
      setNow(Date.now())
      setResendAt(Date.now() + result.value.resendAfterSeconds * 1000)
      setNotice('验证码已发送，请查看邮箱并输入 6 位验证码。')
    } catch {
      if (alive.current) setError('验证码请求失败，请重试。')
    } finally { finishRequest() }
  }

  const login = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (locked || !emailIsValid()) return
    if (!/^\d{6}$/u.test(code)) {
      setError('请输入 6 位数字验证码。')
      codeRef.current?.focus()
      return
    }
    setPending('login')
    setError('')
    setNotice('')
    let signedIn = false
    try {
      const result = await window.api.loginBackend({ backendUrl, email: email.trim(), code })
      if (!alive.current) return
      setLogPath(result.logPath)
      setCode('')
      if (!result.ok) { setError(result.message); return }
      authRevision.current++
      setAuth(result.value)
      signedIn = true
      onSignedIn(result.value)
    } catch {
      if (alive.current) { setCode(''); setError('登录请求失败，请重试。') }
    } finally { finishRequest(!signedIn) }
  }

  return (
    <div className="settings-backend-account">
      {!hideAccountStatus && currentAuth?.user ? (
        <div className="settings-backend-account__status" role="status">
          <strong>{currentAuth.status === 'signed-in' ? '已登录' : '登录已过期'}：{currentAuth.user.email}</strong>
          {currentAuth.expiresAt ? <span>有效期至 {new Date(currentAuth.expiresAt).toLocaleString('zh-CN', { hour12: false })}</span> : null}
        </div>
      ) : null}
      {open ? (
        <form id="web2term-backend-login" className="settings-backend-login" noValidate onSubmit={(event) => void login(event)} aria-busy={busy !== null}>
          <label className="settings-proxy-row__label" htmlFor="web2term-login-email">登录邮箱</label>
          <div className="settings-backend-login__email">
            <input ref={emailRef} id="web2term-login-email" className="settings-input" type="email" autoComplete="email" spellCheck={false} maxLength={254} required disabled={locked} value={email} onChange={(event) => { setEmail(event.target.value); setCode(''); setError(''); setNotice(''); setResendAt(0) }} />
            <button type="button" className="settings-outline-btn" disabled={locked || resendSeconds > 0 || !email.trim()} onClick={() => void sendCode()}>
              {busy === 'send-code' ? '发送中…' : resendSeconds > 0 ? `${resendSeconds} 秒后重发` : '获取验证码'}
            </button>
          </div>
          <label className="settings-proxy-row__label" htmlFor="web2term-login-code">验证码</label>
          <input ref={codeRef} id="web2term-login-code" className="settings-input settings-backend-login__code" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="[0-9]{6}" required placeholder="6 位数字验证码" disabled={locked} value={code} aria-describedby={error ? 'web2term-login-error' : undefined} aria-invalid={Boolean(error)} onChange={(event) => { setCode(event.target.value); setError('') }} />
          {notice ? <p className="settings-backend-login__notice" role="status">{notice}</p> : null}
          {error ? <p id="web2term-login-error" className="settings-feedback" role="alert">{error}</p> : null}
          <div className="settings-backend-actions">
            <button type="submit" className="settings-save-btn settings-backend-submit" disabled={locked || !email.trim() || !code}>{busy === 'login' ? '登录中…' : '确认登录'}</button>
            <button type="button" className="settings-outline-btn" disabled={locked} onClick={onCancel}>取消登录</button>
          </div>
          {error && logPath ? <p className="settings-backend-hint settings-backend-login__log">诊断日志：{logPath}</p> : null}
        </form>
      ) : null}
    </div>
  )
}
