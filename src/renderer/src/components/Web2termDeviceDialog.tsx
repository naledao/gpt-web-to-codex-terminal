import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactElement } from 'react'
import { EMPTY_WEB2TERM_CONNECTION } from '@shared/types'
import type { Web2termConnectionState, Web2termDevice } from '@shared/types'
import './Web2termDeviceDialog.css'

interface Props {
  onClose(): void
  onConnected(): Promise<void>
}
interface Catalog {
  identity: string
  phase: 'idle' | 'loading' | 'ready' | 'error'
  devices: Web2termDevice[]
  error: string
  logPath: string | null
}
const EMPTY_CATALOG: Catalog = { identity: '', phase: 'idle', devices: [], error: '', logPath: null }

export default function Web2termDeviceDialog({ onClose, onConnected }: Props): ReactElement {
  const [state, setState] = useState<Web2termConnectionState>(EMPTY_WEB2TERM_CONNECTION)
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [catalog, setCatalog] = useState<Catalog>(EMPTY_CATALOG)
  const alive = useRef(true)
  const request = useRef(0)
  const dialog = useRef<HTMLDivElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const locked = loading || pending
  const identity = JSON.stringify([state.auth.backendUrl, state.auth.user?.publicId, state.auth.expiresAt])
  const signedIn = state.auth.status === 'signed-in'
  const current = signedIn && catalog.identity === identity ? catalog : EMPTY_CATALOG

  const accept = useCallback((next: Web2termConnectionState): void => {
    if (!alive.current) return
    setState((previous) => next.revision >= previous.revision ? next : previous)
    setLoading(false)
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await window.api.getWeb2termConnection()
      if (!alive.current) return
      accept(next)
      setError('')
    } catch {
      if (alive.current) { setLoading(false); setError('读取登录状态失败，请重试。') }
    }
  }, [accept])

  const refreshDevices = useCallback(async (): Promise<void> => {
    if (!signedIn) return
    const revision = ++request.current
    setCatalog({ identity, phase: 'loading', devices: [], error: '', logPath: null })
    try {
      const result = await window.api.listWeb2termDevices()
      if (!alive.current || revision !== request.current) return
      setCatalog(result.ok
        ? { identity, phase: 'ready', devices: result.value, error: '', logPath: result.logPath }
        : { identity, phase: 'error', devices: [], error: result.message, logPath: result.logPath })
    } catch {
      if (alive.current && revision === request.current) setCatalog({ identity, phase: 'error', devices: [], error: '读取设备列表失败，请刷新重试。', logPath: null })
    }
  }, [identity, signedIn])

  useEffect(() => {
    alive.current = true
    let cancelled = false
    let received = false
    const previousFocus = document.activeElement as HTMLElement | null
    const off = window.api.onWeb2termConnectionChanged((next) => { received = true; accept(next) })
    void window.api.getWeb2termConnection().then((next) => {
      if (!cancelled) accept(next)
    }).catch(() => {
      if (!cancelled && !received) { setLoading(false); setError('读取登录状态失败，请重试。') }
    })
    heading.current?.focus()
    return () => {
      cancelled = true
      alive.current = false
      request.current++
      off()
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [accept])

  useEffect(() => {
    if (!loading && signedIn) void refreshDevices()
    else { request.current++; setCatalog(EMPTY_CATALOG) }
    return () => { request.current++ }
  }, [loading, signedIn, refreshDevices])

  const connectDevice = async (device: Web2termDevice): Promise<void> => {
    if (locked || !device.enabled) return
    setPending(true)
    setError('')
    try {
      const next = await window.api.connectWeb2term({ agentId: device.deviceId, deviceName: device.deviceName })
      if (!alive.current) return
      accept(next)
      if (next.status === 'connecting' || next.status === 'connected') await onConnected()
      else setError(next.message || '连接未建立，请刷新设备后重试。')
    } catch {
      if (!alive.current) return
      let message = '发起设备连接失败，请重试。'
      try {
        // The handshake may fail between starting the socket and activating its workspace.
        const next = await window.api.getWeb2termConnection()
        if (next.agentId === device.deviceId && next.status === 'error') {
          accept(next)
          message = next.message || message
        }
      } catch { /* Keep an actionable fallback if the connection state cannot be read. */ }
      if (alive.current) setError(message)
    } finally { if (alive.current) setPending(false) }
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (!pending) onClose()
      return
    }
    if (event.key !== 'Tab') return
    const buttons = dialog.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])')
    if (!buttons?.length) { event.preventDefault(); heading.current?.focus(); return }
    const first = buttons[0], last = buttons[buttons.length - 1]
    if (event.shiftKey && (document.activeElement === first || document.activeElement === heading.current)) {
      event.preventDefault(); last.focus()
    } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === heading.current)) {
      event.preventDefault(); first.focus()
    }
  }

  return (
    <div className="modal ssh-connect-overlay" role="dialog" aria-modal="true" aria-labelledby="web2term-device-dialog-title" onKeyDown={handleKeyDown} onMouseDown={(event) => { if (!pending && event.target === event.currentTarget) onClose() }}>
      <div ref={dialog} className="ssh-connect-modal web2term-device-dialog">
        <header className="ssh-connect__head web2term-device-dialog__head">
          <h2 ref={heading} id="web2term-device-dialog-title" className="ssh-connect__title" tabIndex={-1}>我的设备{current.phase === 'ready' ? <span>（{current.devices.length}）</span> : null}</h2>
          <button type="button" className="web2term-connect__button" disabled={locked || !signedIn || current.phase === 'loading'} onClick={() => void refreshDevices()}>{current.phase === 'loading' ? '刷新中…' : '刷新设备'}</button>
          <button type="button" className="ssh-connect__close" disabled={pending} aria-label="关闭设备选择" onClick={onClose}><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg></button>
        </header>
        <section className="web2term-device-dialog__body" aria-label="设备列表" aria-busy={loading || current.phase === 'loading'}>
          {error ? <p className="web2term-connect__feedback web2term-connect__feedback--error" role="alert">{error} <button type="button" className="web2term-connect__retry" disabled={pending} onClick={() => void refresh()}>重新读取</button></p> : null}
          {!error && (loading || (signedIn && (current.phase === 'idle' || current.phase === 'loading'))) ? <p className="web2term-connect__empty" role="status">正在读取设备列表…</p> : null}
          {!loading && !signedIn && !error ? <p className="web2term-connect__empty">{state.auth.status === 'expired' ? '登录已过期，' : ''}请先在“设置 → 后端服务”中登录，再选择设备。</p> : null}
          {current.phase === 'error' ? <p className="web2term-connect__feedback web2term-connect__feedback--error" role="alert">{current.error} <button type="button" className="web2term-connect__retry" disabled={locked} onClick={() => void refreshDevices()}>重试</button></p> : null}
          {current.phase === 'ready' && !current.devices.length ? <div className="web2term-connect__empty"><strong>当前账号还没有设备</strong><p>在设备上登录同一账号并运行 web2term run，设备注册后点击“刷新设备”。</p></div> : null}
          {current.phase === 'ready' && current.devices.length > 0 ? (
            <ul className="web2term-connect__device-list">
              {current.devices.map((device) => (
                <li className="web2term-connect__device" key={device.deviceId}>
                  <div className="web2term-connect__device-info"><strong>{device.deviceName}</strong><code>{device.deviceId}</code></div>
                  <span className={`web2term-connect__device-status${!device.enabled ? ' web2term-connect__device-status--disabled' : device.onlineStatus ? ' web2term-connect__device-status--online' : ''}`}><i aria-hidden="true" />{!device.enabled ? '已禁用' : device.onlineStatus ? '在线' : '离线'}</span>
                  <button type="button" className="web2term-connect__button web2term-connect__button--primary" disabled={locked || !device.enabled} aria-label={`连接 ${device.deviceName}`} onClick={() => void connectDevice(device)}>{!device.enabled ? '已禁用' : pending ? '请稍候…' : '连接'}</button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      </div>
    </div>
  )
}
