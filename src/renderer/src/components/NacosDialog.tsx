import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactElement } from 'react'
import { EMPTY_NACOS_VIEW_STATE } from '../../../shared/types'
import type { AppTheme, NacosViewState } from '../../../shared/types'
import NacosIcon from './NacosIcon'

interface NacosDialogProps {
  open: boolean
  theme: AppTheme
  onClose: () => void
}

/** Remembered between restarts, so the address is typed once rather than every launch. */
const LAST_URL_KEY = 'nacos.lastUrl'

/**
 * The Nacos console, opened from the toolbox.
 *
 * This dialog is deliberately thin: the console is the server's OWN web UI, so there is no
 * Nacos client here. All the app contributes is an address to point a native view at, the
 * chrome around it (back / forward / reload, an address bar, a way to close the page), and
 * the full-screen room to show it in.
 *
 * WHY THE PAGE CANNOT BE AN `<iframe>`: Nacos sends `X-Frame-Options`/CSP headers that refuse
 * framing, so the page has to live in its own out-of-process view. See `src/main/nacos-view.ts`.
 *
 * Full-screen like the Git and MySQL dialogs next to it: the console is a wide, dense admin
 * UI, and a 440px card would make it unusable.
 */
export default function NacosDialog({ open, theme, onClose }: NacosDialogProps): ReactElement | null {
  const [state, setState] = useState<NacosViewState>(EMPTY_NACOS_VIEW_STATE)
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState(false)
  const [address, setAddress] = useState('')
  const [opening, setOpening] = useState(false)
  const slotRef = useRef<HTMLDivElement>(null)

  // Restore the last address when the dialog is shown, so the common case — one Nacos
  // server, opened repeatedly — costs a single click.
  useEffect(() => {
    if (!open) return
    setDraft((value) => (value === '' ? window.localStorage.getItem(LAST_URL_KEY) ?? '' : value))
  }, [open])

  /*
   * Mirror the live view state. Subscribed rather than polled, because the address changes on
   * navigation, on redirects and on in-page routing — every one of which the main process
   * already reports for the reason that the address bar has to follow the page.
   */
  useEffect(() => {
    if (!open) return
    void window.api.getNacosState().then(setState)
    return window.api.onNacosState(setState)
  }, [open])

  // The address bar follows the page, but never while it is being typed into.
  useEffect(() => {
    if (!editing) setAddress(state.url)
  }, [state.url, editing])

  /*
   * The console is a NATIVE view, not a DOM node, so it cannot be positioned by CSS. Measure
   * the slot and hand the rectangle to the main process, which moves the view on top of it.
   * `getBoundingClientRect()` is already in the coordinate space `setBounds()` expects, so no
   * devicePixelRatio scaling belongs here.
   */
  useEffect(() => {
    if (!open || !state.active) return
    const element = slotRef.current
    if (!element) return

    const report = (): void => {
      const rect = element.getBoundingClientRect()
      window.api.setNacosBounds({
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      })
    }

    window.api.setNacosVisible(true)
    report()
    const observer = new ResizeObserver(report)
    observer.observe(element)
    window.addEventListener('resize', report)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', report)
      // A native view outlives the DOM that anchored it, so it has to be told to go away.
      window.api.setNacosVisible(false)
      window.api.setNacosBounds({ x: 0, y: 0, width: 0, height: 0 })
    }
  }, [open, state.active])

  const remember = useCallback((url: string): void => {
    window.localStorage.setItem(LAST_URL_KEY, url)
  }, [])

  const openConsole = useCallback(
    async (event: FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault()
      const url = draft.trim()
      if (url === '' || opening) return
      setOpening(true)
      remember(url)
      try {
        setState(await window.api.openNacosView(url))
      } finally {
        setOpening(false)
      }
    },
    [draft, opening, remember]
  )

  const submitAddress = useCallback(
    (event: FormEvent<HTMLFormElement>): void => {
      event.preventDefault()
      const url = address.trim()
      setEditing(false)
      if (url === '' || url === state.url) return
      remember(url)
      void window.api.navigateNacos(url)
    },
    [address, state.url, remember]
  )

  const closeConsole = useCallback(async (): Promise<void> => {
    setState(await window.api.closeNacosView())
  }, [])

  if (!open) return null

  return (
    <div
      className={theme === 'dark' ? 'modal modal--nacos nacos-page--dark' : 'modal modal--nacos'}
      role="dialog"
      aria-modal="true"
      aria-label="Nacos 连接"
    >
      <div className="nacos-page">
        <header className="nacos-page__head">
          <div className="nacos-page__mark">
            <NacosIcon size={26} />
          </div>

          <div className="nacos-page__titles">
            <h2 className="nacos-page__title">Nacos 连接</h2>
            <p className="nacos-page__sub">
              {state.active && state.url !== '' ? state.url : '配置管理与服务发现'}
            </p>
          </div>

          {state.active ? (
            <button type="button" className="nacos-page__disconnect" onClick={() => void closeConsole()}>
              关闭控制台
            </button>
          ) : null}

          <button type="button" className="nacos-page__close" aria-label="关闭" onClick={onClose}>
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </header>

        {state.active ? (
          <>
            <div className="nacos-page__toolbar">
              <button
                type="button"
                className="nacos-page__nav"
                title="后退"
                aria-label="后退"
                disabled={!state.canGoBack}
                onClick={() => window.api.sendNacosCommand('back')}
              >
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10 3 5 8l5 5" />
                </svg>
              </button>
              <button
                type="button"
                className="nacos-page__nav"
                title="前进"
                aria-label="前进"
                disabled={!state.canGoForward}
                onClick={() => window.api.sendNacosCommand('forward')}
              >
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6 3l5 5-5 5" />
                </svg>
              </button>
              <button
                type="button"
                className="nacos-page__nav"
                title={state.isLoading ? '停止加载' : '刷新'}
                aria-label={state.isLoading ? '停止加载' : '刷新'}
                onClick={() => window.api.sendNacosCommand(state.isLoading ? 'stop' : 'reload')}
              >
                {state.isLoading ? (
                  <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                    <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M13 8a5 5 0 1 1-1.6-3.7" />
                    <path d="M13 2.6V5h-2.4" />
                  </svg>
                )}
              </button>

              <form className="nacos-page__address" onSubmit={submitAddress}>
                <input
                  className="nacos-page__address-input"
                  value={address}
                  spellCheck={false}
                  aria-label="控制台地址"
                  onChange={(event) => setAddress(event.target.value)}
                  onFocus={() => setEditing(true)}
                  onBlur={() => setEditing(false)}
                />
              </form>
            </div>

            {state.error !== '' ? (
              <p className="nacos-page__error" role="alert">
                {state.error}
              </p>
            ) : null}

            {state.isLoading ? <div className="nacos-page__progress" aria-hidden="true" /> : null}

            {/* The native console is positioned over this slot; it stays empty by design. */}
            <div className="nacos-page__slot" ref={slotRef} />
          </>
        ) : (
          <div className="nacos-page__body">
            <form className="nacos-page__connect" onSubmit={(event) => void openConsole(event)}>
              <div className="nacos-page__connect-mark">
                <NacosIcon size={44} />
              </div>
              <h3 className="nacos-page__connect-title">连接到 Nacos 控制台</h3>
              <p className="nacos-page__connect-sub">填写你的 Nacos 服务地址，控制台会在应用内打开。</p>

              <div className="nacos-page__connect-row">
                <input
                  className="nacos-page__connect-input"
                  value={draft}
                  spellCheck={false}
                  autoFocus
                  placeholder="http://127.0.0.1:8848/nacos"
                  aria-label="Nacos 控制台地址"
                  onChange={(event) => setDraft(event.target.value)}
                />
                <button
                  type="submit"
                  className="nacos-page__connect-btn"
                  disabled={opening || draft.trim() === ''}
                >
                  {opening ? '打开中…' : '打开控制台'}
                </button>
              </div>

              <p className="nacos-page__connect-hint">可以省略协议，例如 192.168.1.9:8848/nacos</p>

              {state.error !== '' ? (
                <p className="nacos-page__connect-error" role="alert">
                  {state.error}
                </p>
              ) : null}
            </form>
          </div>
        )}
      </div>
    </div>
  )
}