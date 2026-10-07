import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import ConfirmDialog from './ConfirmDialog'
import type {
  AppTheme,
  NacosConnection,
  NacosConnectionDraft,
  NacosConnectionsState,
  NacosViewState
} from '../../../shared/types'
import { EMPTY_NACOS_VIEW_STATE } from '../../../shared/types'
import NacosIcon from './NacosIcon'

interface NacosDialogProps {
  open: boolean
  theme: AppTheme
  onClose: () => void
}

/** Editable shape of one saved console. */
interface ConsoleForm {
  id: string
  name: string
  url: string
  namespace: string
}

/** A saved console being edited. Its page never shows the live site. */
interface ConnectionTab {
  kind: 'connection'
  key: string
  form: ConsoleForm
  saved: boolean
}

/**
 * A console that is actually on screen.
 *
 * Separate from the connection page on purpose. Editing an address and LOOKING at the site
 * are different jobs, and one page cannot honestly be both: a tab whose fields stay
 * editable while a live page is loaded underneath leaves it unclear which one is in charge.
 * Opening the console therefore opens its OWN tab, and closing that tab is what takes the
 * page down.
 */
interface ConsoleTab {
  kind: 'console'
  key: string
  /** The saved row this page was opened from. */
  connectionId: string
  name: string
  url: string
  view: NacosViewState
}

type NacosTab = ConnectionTab | ConsoleTab

/** Key of the console page for one saved row; one page per connection, never two. */
function consoleKeyFor(connectionId: string): string {
  return 'console:' + connectionId
}

const EMPTY_FORM: ConsoleForm = { id: '', name: '', url: '', namespace: '' }

function formFromConnection(connection: NacosConnection): ConsoleForm {
  return {
    id: connection.id,
    name: connection.name,
    url: connection.url,
    namespace: connection.namespace
  }
}

function draftFromForm(form: ConsoleForm): NacosConnectionDraft {
  return {
    id: form.id,
    name: form.name.trim(),
    url: form.url.trim(),
    namespace: form.namespace.trim()
  }
}

/** What a tab says: the given name, else the host, else a placeholder. */
function tabTitle(tab: NacosTab): string {
  const name = tab.kind === 'connection' ? tab.form.name.trim() : tab.name.trim()
  if (name !== '') return name
  const url = tab.kind === 'connection' ? tab.form.url.trim() : tab.url
  if (url === '') return '新的连接'
  try {
    return new URL(url.includes('://') ? url : 'http://' + url).host
  } catch {
    return url
  }
}

/**
 * Whether the live view is already pointed at this console.
 *
 * Compared by ORIGIN, not full URL: a Nacos console routes internally (#/login, #/config)
 * and reloading on every in-page hop would throw away the session the user just signed into.
 */
function sameConsole(view: NacosViewState, url: string): boolean {
  if (!view.active || view.url === '') return false
  try {
    const target = new URL(url.includes('://') ? url : 'http://' + url)
    return new URL(view.url).origin === target.origin
  } catch {
    return false
  }
}

/**
 * The Nacos console, opened from the toolbox.
 *
 * Shaped after the MySQL dialog on purpose, because the two answer the same kind of
 * question — "which server am I looking at?" — and a user who has learned one should not
 * have to learn the other. So: a saved list down the left, an editable form in the middle,
 * and the live thing itself on the right.
 *
 * WHAT THIS DIALOG IS NOT. It is not a Nacos client. The console is the server OWN web UI,
 * so there is no API call here, no namespace enumeration and no config reading — the page
 * does all of that, with its own login. The app contributes an address, a rectangle to put
 * the page in, and the saved list of addresses.
 *
 * WHY THE PAGE CANNOT BE AN IFRAME: Nacos sends X-Frame-Options/CSP headers that refuse
 * framing, so the page lives in its own out-of-process view. See src/main/nacos-view.ts.
 */
export default function NacosDialog({ open, theme, onClose }: NacosDialogProps): ReactElement | null {
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [state, setState] = useState<NacosConnectionsState | null>(null)
  const [tabs, setTabs] = useState<NacosTab[]>([])
  const [activeKey, setActiveKey] = useState('')
  const [opening, setOpening] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<NacosConnection | null>(null)
  const newTabRef = useRef(0)
  /** Focused when saving is refused, so the missing field is the one on screen. */
  const urlRef = useRef<HTMLInputElement>(null)
  /** Read by the activation effect, which must not re-run every time a view state lands. */
  const tabsRef = useRef<NacosTab[]>([])

  tabsRef.current = tabs
  const activeTab = tabs.find((tab) => tab.key === activeKey) ?? null

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      setState(await window.api.listNacosConnections())
      setError('')
    } catch {
      setError('读取连接列表失败，请重试。')
    } finally {
      setLoading(false)
    }
  }, [])

  // Load the list on open, and follow it while the dialog is up: another window (or a
  // machine switch) can change which consoles belong to this machine.
  useEffect(() => {
    if (!open) return
    void refresh()
    return window.api.onNacosConnectionChanged(setState)
  }, [open, refresh])

  /*
   * Mirror the live view into the console page that is showing it. A state arriving while a
   * connection page is active belongs to no visible page, and is dropped rather than written
   * into a tab that would then describe a page it is not showing.
   */
  useEffect(() => {
    if (!open) return
    return window.api.onNacosState((view) => {
      setTabs((current) =>
        current.map((tab) =>
          tab.kind === 'console' && tab.key === activeKey ? { ...tab, view } : tab
        )
      )
    })
  }, [open, activeKey])

  /*
   * Activating a console page brings its site back on screen.
   *
   * Done here rather than in the click handler so that every route into a console page — the
   * tab strip, a freshly opened one, the one left active after a delete — goes through the
   * same check. Reloading is skipped when the view already sits on that origin, which is what
   * keeps a signed-in console signed in while the user moves between tabs.
   */
  useEffect(() => {
    if (!open || activeKey === '') return
    const tab = tabsRef.current.find((item) => item.key === activeKey)
    if (!tab || tab.kind !== 'console') return

    let cancelled = false
    void (async () => {
      const current = await window.api.getNacosState()
      if (cancelled) return
      if (sameConsole(current, tab.url)) {
        setTabs((now) =>
          now.map((item) =>
            item.kind === 'console' && item.key === tab.key ? { ...item, view: current } : item
          )
        )
        return
      }
      const view = await window.api.openNacosView(tab.url)
      if (cancelled) return
      setTabs((now) =>
        now.map((item) => (item.kind === 'console' && item.key === tab.key ? { ...item, view } : item))
      )
    })()

    return () => {
      cancelled = true
    }
  }, [open, activeKey])

  // Leaving the dialog takes the page down; the tabs must not claim otherwise next time.
  useEffect(() => {
    if (open) return
    setTabs((current) =>
      current.map((item) => (item.kind === 'console' ? { ...item, view: EMPTY_NACOS_VIEW_STATE } : item))
    )
    void window.api.closeNacosView()
  }, [open])

  const addTab = useCallback((): void => {
    newTabRef.current += 1
    const key = 'new:' + String(newTabRef.current)
    setTabs((current) => [
      ...current,
      { kind: 'connection', key, form: { ...EMPTY_FORM }, saved: false }
    ])
    setActiveKey(key)
    setError('')
  }, [])

  /** Open the saved console in a tab, reusing the one already open for it. */
  const openConnectionTab = useCallback((connection: NacosConnection): void => {
    setTabs((current) => {
      if (current.some((tab) => tab.key === connection.id)) return current
      return [
        ...current,
        { kind: 'connection', key: connection.id, form: formFromConnection(connection), saved: true }
      ]
    })
    setActiveKey(connection.id)
    setError('')
  }, [])

  const closeTab = useCallback(
    (key: string): void => {
      setTabs((current) => {
        const index = current.findIndex((tab) => tab.key === key)
        if (index === -1) return current
        const remaining = current.filter((tab) => tab.key !== key)
        if (key === activeKey) {
          setActiveKey(remaining.length === 0 ? '' : remaining[Math.min(index, remaining.length - 1)].key)
        }
        return remaining
      })
    },
    [activeKey]
  )

  const updateForm = useCallback(
    (patch: Partial<ConsoleForm>): void => {
      setTabs((current) =>
        current.map((tab) =>
          tab.kind === 'connection' && tab.key === activeKey ? { ...tab, form: { ...tab.form, ...patch } } : tab
        )
      )
    },
    [activeKey]
  )

  const saveActive = useCallback(async (): Promise<void> => {
    const tab = tabs.find((item) => item.key === activeKey)
    if (!tab || tab.kind !== 'connection' || saving) return
    if (tab.form.url.trim() === '') {
      setError('请填写 Nacos 控制台地址。')
      urlRef.current?.focus()
      return
    }

    setSaving(true)
    try {
      const result = await window.api.saveNacosConnection(draftFromForm(tab.form))
      setState(result)
      // The temporary key has to become the real row id, or the tab is orphaned the moment
      // the list refreshes and the sidebar highlights a row that no longer matches it.
      setTabs((current) =>
        current.map((item) =>
          item.kind === 'connection' && item.key === activeKey
            ? { ...item, key: result.id, form: { ...item.form, id: result.id }, saved: true }
            : item
        )
      )
      setActiveKey(result.id)
      setError('')
    } catch {
      setError('保存失败，请重试。')
    } finally {
      setSaving(false)
    }
  }, [tabs, activeKey, saving])

  /**
   * Open the console shown on this page, in its own tab.
   *
   * An unsaved console is saved first rather than refused: opening it is the whole point, and
   * making the user press Save before they may look at their own server would be ceremony.
   */
  const openConsoleTab = useCallback(async (): Promise<void> => {
    const tab = tabs.find((item) => item.key === activeKey)
    if (!tab || tab.kind !== 'connection' || opening) return

    const url = tab.form.url.trim()
    if (url === '') {
      setError('请填写 Nacos 控制台地址。')
      urlRef.current?.focus()
      return
    }

    setOpening(true)
    try {
      let id = tab.form.id
      if (!tab.saved) {
        const result = await window.api.saveNacosConnection(draftFromForm(tab.form))
        setState(result)
        id = result.id
        setTabs((current) =>
          current.map((item) =>
            item.kind === 'connection' && item.key === tab.key
              ? { ...item, key: result.id, form: { ...item.form, id: result.id }, saved: true }
              : item
          )
        )
      }

      const key = consoleKeyFor(id)
      const name = tab.form.name.trim() !== '' ? tab.form.name.trim() : url
      setTabs((current) =>
        current.some((item) => item.key === key)
          ? current
          : [...current, { kind: 'console', key, connectionId: id, name, url, view: EMPTY_NACOS_VIEW_STATE }]
      )
      setActiveKey(key)
      setError('')
    } catch {
      setError('打开控制台失败，请检查地址。')
    } finally {
      setOpening(false)
    }
  }, [tabs, activeKey, opening])

  const confirmDelete = useCallback(async (): Promise<void> => {
    if (!pendingDelete) return
    try {
      const next = await window.api.removeNacosConnection(pendingDelete.id)
      setState(next)
      // The console page for a deleted row has nothing left to point at, so it goes too.
      const consoleKey = consoleKeyFor(pendingDelete.id)
      const remaining = tabs.filter((tab) => tab.key !== pendingDelete.id && tab.key !== consoleKey)
      setTabs(remaining)
      if (activeKey === pendingDelete.id || activeKey === consoleKey) {
        setActiveKey(remaining.length === 0 ? '' : remaining[remaining.length - 1].key)
      }
      setError('')
    } catch {
      setError('删除失败，请重试。')
    } finally {
      setPendingDelete(null)
    }
  }, [pendingDelete, tabs, activeKey])

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
            <p className="nacos-page__sub">{state ? state.machineLabel : '配置管理与服务发现'}</p>
          </div>

          <div className="nacos-page__tabs">
            {tabs.length === 0 ? (
              <span className="nacos-page__tabs-empty">未打开任何页面</span>
            ) : (
              tabs.map((tab) => (
                <div
                  key={tab.key}
                  className={tab.key === activeKey ? 'nacos-page__tab nacos-page__tab--active' : 'nacos-page__tab'}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={tab.key === activeKey}
                    className="nacos-page__tab-label"
                    title={tabTitle(tab)}
                    onClick={() => setActiveKey(tab.key)}
                  >
                    {tab.kind === 'console' ? <span className="nacos-page__tab-dot" aria-hidden="true" /> : null}
                    {tabTitle(tab)}
                  </button>
                  <button
                    type="button"
                    className="nacos-page__tab-close"
                    aria-label="关闭标签页"
                    onClick={() => closeTab(tab.key)}
                  >
                    <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
                      <path d="M4 4l8 8M12 4l-8 8" />
                    </svg>
                  </button>
                </div>
              ))
            )}
            <button type="button" className="nacos-page__add" onClick={addTab}>
              <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
                <path d="M8 3.2v9.6M3.2 8h9.6" />
              </svg>
              添加连接
            </button>
          </div>

          <button type="button" className="nacos-page__close" aria-label="关闭" onClick={onClose}>
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </header>

        <div className="nacos-page__body">
          <aside className="nacos-page__sidebar">
            <div className="nacos-page__sidebar-head">
              <span className="nacos-page__sidebar-title">已保存</span>
              <span className="nacos-page__sidebar-count">{state ? state.connections.length : 0}</span>
            </div>

            {loading && state === null ? (
              <p className="nacos-page__hint nacos-page__sidebar-hint">正在读取…</p>
            ) : state !== null && state.connections.length === 0 ? (
              <p className="nacos-page__hint nacos-page__sidebar-hint">还没有保存的控制台，点“添加连接”新建一个。</p>
            ) : (
              <ul className="nacos-page__sidebar-list">
                {(state?.connections ?? []).map((connection) => (
                  <li key={connection.id}>
                    <button
                      type="button"
                      className={connection.id === activeKey ? 'nacos-page__item nacos-page__item--active' : 'nacos-page__item'}
                      onClick={() => openConnectionTab(connection)}
                    >
                      <span className="nacos-page__item-main">
                        <span className="nacos-page__item-name">
                          {connection.name.trim() === '' ? connection.url : connection.name}
                        </span>
                        <span className="nacos-page__item-target">{connection.url}</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="nacos-page__item-remove"
                      title="删除"
                      aria-label={'删除 ' + connection.url}
                      onClick={() => setPendingDelete(connection)}
                    >
                      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                        <path d="M4 4l8 8M12 4l-8 8" />
                      </svg>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>

          <section className="nacos-page__detail">
            {error !== '' ? <p className="nacos-page__hint nacos-page__hint--error">{error}</p> : null}

            {activeTab === null ? (
              <div className="nacos-page__empty">
                <span className="nacos-page__empty-mark" aria-hidden="true">
                  <NacosIcon size={40} />
                </span>
                <p className="nacos-page__empty-title">没有打开的页面</p>
                <p className="nacos-page__empty-sub">从左侧选择已保存的连接，或点“添加连接”填写新的地址。</p>
              </div>
            ) : activeTab.kind === 'console' ? (
              <NacosConsoleView tab={activeTab} />
            ) : (
              <div className="nacos-page__card">
                <div className="nacos-page__card-head">
                  <h3 className="nacos-page__card-title">{activeTab.saved ? '连接信息' : '新建连接'}</h3>
                  <div className="nacos-page__card-actions">
                    <button
                      type="button"
                      className="nacos-page__btn"
                      disabled={saving}
                      onClick={() => void saveActive()}
                    >
                      {saving ? '保存中…' : '保存'}
                    </button>
                    <button
                      type="button"
                      className="nacos-page__btn nacos-page__btn--primary"
                      disabled={opening}
                      onClick={() => void openConsoleTab()}
                    >
                      {opening ? '打开中…' : '打开控制台'}
                    </button>
                  </div>
                </div>

                <div className="nacos-page__grid">
                  <label className="nacos-page__field">
                    <span className="nacos-page__label">名称</span>
                    <input
                      className="nacos-page__input"
                      value={activeTab.form.name}
                      spellCheck={false}
                      placeholder="例如 本地开发"
                      onChange={(event) => updateForm({ name: event.target.value })}
                    />
                  </label>

                  <label className="nacos-page__field">
                    <span className="nacos-page__label">命名空间（可选）</span>
                    <input
                      className="nacos-page__input"
                      value={activeTab.form.namespace}
                      spellCheck={false}
                      placeholder="public"
                      onChange={(event) => updateForm({ namespace: event.target.value })}
                    />
                  </label>

                  <label className="nacos-page__field nacos-page__field--wide">
                    <span className="nacos-page__label">控制台地址</span>
                    <input
                      ref={urlRef}
                      className="nacos-page__input"
                      value={activeTab.form.url}
                      spellCheck={false}
                      placeholder="http://127.0.0.1:8848/nacos"
                      onChange={(event) => updateForm({ url: event.target.value })}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void openConsoleTab()
                      }}
                    />
                    <span className="nacos-page__field-note">可以省略协议，例如 192.168.1.9:8848/nacos</span>
                  </label>
                </div>
              </div>
            )}
          </section>
        </div>
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除连接"
        description={
          pendingDelete
            ? '确定删除“' + (pendingDelete.name.trim() === '' ? pendingDelete.url : pendingDelete.name) + '”？'
            : ''
        }
        confirmLabel="删除"
        danger
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  )
}

/**
 * The live console page: the toolbar plus the slot the native view is positioned over.
 *
 * Split out so the measuring effect lives and dies with the page. The view is a single native
 * rectangle shared by the whole dialog, so it must be measured only while a console page is
 * on screen — and hidden the moment this page goes away, which is what unmounting does here.
 */
function NacosConsoleView({ tab }: { tab: ConsoleTab }): ReactElement {
  const slotRef = useRef<HTMLDivElement>(null)
  const [editing, setEditing] = useState(false)
  const [address, setAddress] = useState(tab.view.url)

  useEffect(() => {
    if (!editing) setAddress(tab.view.url)
  }, [tab.view.url, editing])

  useEffect(() => {
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
  }, [])

  return (
    <div className="nacos-page__console">
      <div className="nacos-page__toolbar">
        <button
          type="button"
          className="nacos-page__nav"
          title="后退"
          aria-label="后退"
          disabled={!tab.view.canGoBack}
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
          disabled={!tab.view.canGoForward}
          onClick={() => window.api.sendNacosCommand('forward')}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 3l5 5-5 5" />
          </svg>
        </button>
        <button
          type="button"
          className="nacos-page__nav"
          title={tab.view.isLoading ? '停止加载' : '刷新'}
          aria-label={tab.view.isLoading ? '停止加载' : '刷新'}
          onClick={() => window.api.sendNacosCommand(tab.view.isLoading ? 'stop' : 'reload')}
        >
          {tab.view.isLoading ? (
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

        <form
          className="nacos-page__address"
          onSubmit={(event) => {
            event.preventDefault()
            setEditing(false)
            const url = address.trim()
            if (url === '' || url === tab.view.url) return
            void window.api.navigateNacos(url)
          }}
        >
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

      {tab.view.error !== '' ? (
        <p className="nacos-page__error" role="alert">
          {tab.view.error}
        </p>
      ) : null}

      {tab.view.isLoading ? <div className="nacos-page__progress" aria-hidden="true" /> : null}

      {/* The native console is positioned over this slot; it stays empty by design. */}
      <div className="nacos-page__slot" ref={slotRef} />
    </div>
  )
}