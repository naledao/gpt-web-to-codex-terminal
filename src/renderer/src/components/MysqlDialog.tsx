import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import ConfirmDialog from './ConfirmDialog'
import type { AppTheme, MysqlConnection, MysqlConnectionDraft, MysqlConnectionsState } from '../../../shared/types'

interface MysqlDialogProps {
  open: boolean
  theme: AppTheme
  onClose: () => void
}

/** Editable shape of one connection. `port` stays a string while it is being typed. */
interface ConnectionForm {
  id: string
  name: string
  host: string
  port: string
  username: string
  password: string
  database: string
}

/** One open page. `key` is the row id, or a temporary one for a connection never saved. */
interface ConnectionTab {
  key: string
  form: ConnectionForm
}

const EMPTY_FORM: ConnectionForm = {
  id: '',
  name: '',
  host: '',
  port: '3306',
  username: '',
  password: '',
  database: ''
}

function formFromConnection(connection: MysqlConnection): ConnectionForm {
  return {
    id: connection.id,
    name: connection.name,
    host: connection.host,
    port: String(connection.port || 3306),
    username: connection.username,
    password: connection.password,
    database: connection.database
  }
}

function draftFromForm(form: ConnectionForm): MysqlConnectionDraft {
  const port = Number(form.port)
  return {
    id: form.id,
    name: form.name.trim(),
    host: form.host.trim(),
    port: Number.isFinite(port) && port > 0 ? Math.trunc(port) : 3306,
    username: form.username.trim(),
    password: form.password,
    database: form.database.trim()
  }
}

/** Caption of a tab: the user own name for it, else where it points, else a placeholder. */
function tabLabel(form: ConnectionForm): string {
  if (form.name.trim() !== '') return form.name.trim()
  if (form.host.trim() !== '') return form.host.trim()
  return form.id === '' ? '新建连接' : '未命名连接'
}

function connectionLabel(connection: MysqlConnection): string {
  if (connection.name.trim() !== '') return connection.name.trim()
  if (connection.host.trim() !== '') return connection.host.trim()
  return '未命名连接'
}

function connectionTarget(connection: MysqlConnection): string {
  const user = connection.username.trim()
  const host = connection.host.trim() || '未填写主机'
  const port = connection.port ? `:${connection.port}` : ''
  return `${user === '' ? '' : `${user}@`}${host}${port}`
}

/** True when the form still matches what is stored, password included. */
function matchesSaved(form: ConnectionForm, saved: MysqlConnection): boolean {
  const draft = draftFromForm(form)
  return (
    draft.name === saved.name &&
    draft.host === saved.host &&
    draft.port === saved.port &&
    draft.username === saved.username &&
    draft.database === saved.database &&
    form.password === saved.password
  )
}

/**
 * The MySQL connection page, opened from the toolbox.
 *
 * Full-screen rather than a small card, because it is the first thing a connection flow
 * needs and the fields (plus whatever a later "browse tables / run SQL" step adds) do not
 * belong in a 440px box. Same reasoning as the Git dialog next to it.
 *
 * A machine keeps a LIST of connections. One row per machine could not describe the
 * ordinary case of a local database next to a staging one, and it made this form
 * overwrite itself the moment a second connection was entered.
 *
 * The tabs are an in-memory convenience, not stored state: they exist so that comparing two
 * connections does not mean losing the first one, and losing them on restart costs nothing
 * because the connections themselves are in the database.
 *
 * Saving is the whole feature for now. Connecting, browsing tables and running SQL come
 * later; nothing here pretends to have tested the connection.
 */
export default function MysqlDialog({ open, theme, onClose }: MysqlDialogProps): ReactElement | null {
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [state, setState] = useState<MysqlConnectionsState | null>(null)
  const [tabs, setTabs] = useState<ConnectionTab[]>([])
  const [activeKey, setActiveKey] = useState('')
  const [reveal, setReveal] = useState(false)
  const newTabRef = useRef(0)
  /** Focused when saving is refused, so the missing field is the one on screen. */
  const databaseRef = useRef<HTMLInputElement>(null)
  /** The connection a delete is waiting on; non-null while the confirm dialog is up. */
  const [pendingDelete, setPendingDelete] = useState<MysqlConnection | null>(null)

  const connections = state?.connections ?? []
  const machineLabel = state?.machineLabel ?? ''
  const activeTab = tabs.find((tab) => tab.key === activeKey) ?? null
  const activeForm = activeTab?.form ?? null
  const activeSaved =
    activeForm !== null && activeForm.id !== ''
      ? connections.find((connection) => connection.id === activeForm.id) ?? null
      : null
  const savedNow = activeForm !== null && activeSaved !== null && matchesSaved(activeForm, activeSaved)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError('')
    void window.api
      .listMysqlConnections()
      .then((next) => {
        if (!cancelled) setState(next)
      })
      .catch(() => {
        if (!cancelled) setError('读取已保存的连接失败。')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open])

  // Another window, or a machine change, can rewrite the list underneath this one.
  useEffect(() => {
    if (!open) return
    return window.api.onMysqlConnectionChanged((next) => setState(next))
  }, [open])

  // Escape closes the page, like every other dialog on the platform.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  /** Open a saved connection in its own tab, or bring the tab it already has to the front. */
  const openConnectionTab = useCallback((connection: MysqlConnection) => {
    setTabs((current) =>
      current.some((tab) => tab.key === connection.id)
        ? current
        : [...current, { key: connection.id, form: formFromConnection(connection) }]
    )
    setActiveKey(connection.id)
    setReveal(false)
    setError('')
  }, [])

  const addTab = useCallback(() => {
    newTabRef.current += 1
    const key = `new:${newTabRef.current}`
    setTabs((current) => [...current, { key, form: { ...EMPTY_FORM } }])
    setActiveKey(key)
    setReveal(false)
    setError('')
  }, [])

  const closeTab = useCallback(
    (key: string) => {
      const index = tabs.findIndex((tab) => tab.key === key)
      if (index < 0) return
      const next = tabs.filter((tab) => tab.key !== key)
      setTabs(next)
      if (activeKey === key) {
        setActiveKey(next.length === 0 ? '' : next[Math.min(index, next.length - 1)].key)
      }
    },
    [tabs, activeKey]
  )

  const updateForm = useCallback(
    (patch: Partial<ConnectionForm>): void => {
      // The complaint refers to what was on screen a keystroke ago; keeping it up while the
      // user fixes the field reads as the fix not working.
      setError('')
      setTabs((current) =>
        current.map((tab) => (tab.key === activeKey ? { ...tab, form: { ...tab.form, ...patch } } : tab))
      )
    },
    [activeKey]
  )

  const save = useCallback(async (): Promise<void> => {
    if (saving || activeForm === null || activeTab === null) return
    // A connection with no database is not usable later, so it is refused here rather
    // than stored and discovered when someone tries to connect with it.
    if (activeForm.database.trim() === '') {
      setError('数据库为必填项，请填写后再保存。')
      databaseRef.current?.focus()
      return
    }
    setSaving(true)
    setError('')
    const key = activeTab.key
    try {
      const result = await window.api.saveMysqlConnection(draftFromForm(activeForm))
      setState({ machineLabel: result.machineLabel, connections: result.connections })
      const saved = result.connections.find((connection) => connection.id === result.id) ?? null
      // A brand-new connection is keyed by a temporary id until this moment; the row id
      // replaces it, so the tab it was opened in becomes the tab of the saved row.
      setTabs((current) =>
        current.map((tab) =>
          tab.key === key
            ? { key: result.id, form: saved ? formFromConnection(saved) : { ...tab.form, id: result.id } }
            : tab
        )
      )
      setActiveKey((active) => (active === key ? result.id : active))
    } catch {
      setError('保存失败，请重试。')
    } finally {
      setSaving(false)
    }
  }, [activeForm, activeTab, saving])

  /**
   * Delete the connection the confirm dialog is showing.
   *
   * Split from the click that opened it so the confirmation can be the project own
   * dialog instead of the browser one, which is unstyled, is not themed, and cannot say
   * what is about to be lost.
   */
  const confirmRemove = useCallback(async (): Promise<void> => {
    const connection = pendingDelete
    if (connection === null) return
    setError("")
    try {
      const next = await window.api.removeMysqlConnection(connection.id)
      setState(next)
      const index = tabs.findIndex((tab) => tab.key === connection.id)
      const remaining = tabs.filter((tab) => tab.key !== connection.id)
      setTabs(remaining)
      if (activeKey === connection.id) {
        setActiveKey(remaining.length === 0 ? "" : remaining[Math.min(index, remaining.length - 1)].key)
      }
    } catch {
      setError("删除失败，请重试。")
    } finally {
      setPendingDelete(null)
    }
  }, [pendingDelete, tabs, activeKey])
  if (!open) return null

  return (
    <div
      className={theme === 'dark' ? 'modal modal--mysql mysql-page--dark' : 'modal modal--mysql'}
      role="dialog"
      aria-modal="true"
      aria-label="MySQL 连接"
    >
      <div className="mysql-page">
        <header className="mysql-page__head">
          <button
            type="button"
            className="mysql-page__add"
            title="新建一个连接"
            onClick={addTab}
          >
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
              <path d="M8 3.2v9.6M3.2 8h9.6" />
            </svg>
            添加连接
          </button>

          <div className="mysql-page__tabs" role="tablist" aria-label="打开的连接">
            {tabs.length === 0 ? (
              <span className="mysql-page__tabs-empty">未打开任何连接</span>
            ) : (
              tabs.map((tab) => (
                <div
                  key={tab.key}
                  className={tab.key === activeKey ? 'mysql-page__tab mysql-page__tab--active' : 'mysql-page__tab'}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={tab.key === activeKey}
                    className="mysql-page__tab-label"
                    title={tabLabel(tab.form)}
                    onClick={() => {
                      setActiveKey(tab.key)
                      setReveal(false)
                      setError('')
                    }}
                  >
                    {tabLabel(tab.form)}
                  </button>
                  <button
                    type="button"
                    className="mysql-page__tab-close"
                    aria-label={`关闭 ${tabLabel(tab.form)}`}
                    title="关闭这个页面（连接仍保留在左侧列表）"
                    onClick={() => closeTab(tab.key)}
                  >
                    <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
                      <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
                    </svg>
                  </button>
                </div>
              ))
            )}
          </div>

          <span className="panel__spacer" />
          <span
            className={savedNow ? 'mysql-page__badge mysql-page__badge--ok' : 'mysql-page__badge'}
            title={activeForm === null ? '没有打开的连接' : savedNow ? '与已保存的内容一致' : '有改动尚未保存'}
          >
            <i />
            {activeForm === null ? '未打开' : savedNow ? '已保存' : '未保存'}
          </span>
          <button type="button" className="mysql-page__close" aria-label="关闭" onClick={onClose}>
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </header>

        <div className="mysql-page__body">
          <aside className="mysql-page__sidebar">
            <div className="mysql-page__sidebar-head">
              <span className="mysql-page__sidebar-title">已保存连接</span>
              <span className="mysql-page__sidebar-count">{connections.length}</span>
            </div>
            {loading ? (
              <p className="mysql-page__hint mysql-page__sidebar-hint">正在读取已保存的连接…</p>
            ) : connections.length === 0 ? (
              <p className="mysql-page__hint mysql-page__sidebar-hint">
                还没有保存的连接。点左上角「添加连接」新建一个。
              </p>
            ) : (
              <ul className="mysql-page__sidebar-list">
                {connections.map((connection) => (
                  <li key={connection.id}>
                    <div
                      className={
                        activeForm !== null && activeForm.id === connection.id
                          ? 'mysql-page__item mysql-page__item--active'
                          : 'mysql-page__item'
                      }
                    >
                      <button
                        type="button"
                        className="mysql-page__item-main"
                        title={`${connectionLabel(connection)} · ${connectionTarget(connection)}`}
                        onClick={() => openConnectionTab(connection)}
                      >
                        <span className="mysql-page__item-name">{connectionLabel(connection)}</span>
                        <span className="mysql-page__item-target">{connectionTarget(connection)}</span>
                      </button>
                      <button
                        type="button"
                        className="mysql-page__item-remove"
                        aria-label={`删除 ${connectionLabel(connection)}`}
                        title="从数据库删除"
                        onClick={() => setPendingDelete(connection)}
                      >
                        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                          <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
                        </svg>
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </aside>

          <section className="mysql-page__detail">
            {activeForm === null ? (
              <div className="mysql-page__empty">
                <span className="mysql-page__empty-mark" aria-hidden="true">
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <ellipse cx="12" cy="5.6" rx="7.2" ry="2.8" />
                    <path d="M4.8 5.6v12.8c0 1.55 3.22 2.8 7.2 2.8s7.2-1.25 7.2-2.8V5.6" />
                    <path d="M4.8 12c0 1.55 3.22 2.8 7.2 2.8s7.2-1.25 7.2-2.8" />
                  </svg>
                </span>
                <p className="mysql-page__empty-title">没有打开的连接</p>
                <p className="mysql-page__empty-sub">
                  点左上角「添加连接」新建，或在左侧列表里点一个已保存的连接把它打开。
                </p>
              </div>
            ) : (
              <div className="mysql-page__card">
                <div className="mysql-page__card-head">
                  <span className="mysql-page__card-title">连接信息</span>
                  <span className="mysql-page__card-note">
                    只对当前机器生效{machineLabel ? ` · ${machineLabel}` : ''}
                  </span>
                </div>

                <div className="mysql-page__grid">
                  <label className="mysql-page__field mysql-page__field--wide">
                    <span className="mysql-page__label">连接名称</span>
                    <input
                      className="mysql-page__input"
                      value={activeForm.name}
                      spellCheck={false}
                      placeholder="例如：本地开发库"
                      onChange={(event) => updateForm({ name: event.target.value })}
                    />
                  </label>

                  <label className="mysql-page__field mysql-page__field--host">
                    <span className="mysql-page__label">主机 / IP</span>
                    <input
                      className="mysql-page__input"
                      value={activeForm.host}
                      spellCheck={false}
                      placeholder="127.0.0.1"
                      onChange={(event) => updateForm({ host: event.target.value })}
                    />
                  </label>

                  <label className="mysql-page__field mysql-page__field--port">
                    <span className="mysql-page__label">端口</span>
                    <input
                      className="mysql-page__input"
                      type="number"
                      min={1}
                      max={65535}
                      value={activeForm.port}
                      onChange={(event) => updateForm({ port: event.target.value })}
                    />
                  </label>

                  <label className="mysql-page__field">
                    <span className="mysql-page__label">用户名</span>
                    <input
                      className="mysql-page__input"
                      value={activeForm.username}
                      spellCheck={false}
                      placeholder="root"
                      onChange={(event) => updateForm({ username: event.target.value })}
                    />
                  </label>

                  <label className="mysql-page__field">
                    <span className="mysql-page__label">密码</span>
                    <span className="mysql-page__password">
                      <input
                        className="mysql-page__input"
                        type={reveal ? 'text' : 'password'}
                        value={activeForm.password}
                        spellCheck={false}
                        autoComplete="off"
                        placeholder="留空则保留已保存的密码"
                        onChange={(event) => updateForm({ password: event.target.value })}
                      />
                      <button
                        type="button"
                        className="mysql-page__reveal"
                        aria-label={reveal ? '隐藏密码' : '显示密码'}
                        title={reveal ? '隐藏密码' : '显示密码'}
                        onClick={() => setReveal((value) => !value)}
                      >
                        {reveal ? '隐藏' : '显示'}
                      </button>
                    </span>
                  </label>

                  <label className="mysql-page__field mysql-page__field--wide">
                    <span className="mysql-page__label">
                      默认数据库
                      <span className="mysql-page__required">必填</span>
                    </span>
                    <input
                      className="mysql-page__input"
                      ref={databaseRef}
                      value={activeForm.database}
                      spellCheck={false}
                      required
                      placeholder="例如：myapp_dev（必填）"
                      onChange={(event) => updateForm({ database: event.target.value })}
                    />
                  </label>

                  <p className="mysql-page__hint mysql-page__hint--note mysql-page__field--wide">
                    密码会用系统加密后保存在本机数据库，不会明文写入。
                  </p>
                  {error ? (
                    <p className="mysql-page__hint mysql-page__hint--error mysql-page__field--wide" role="alert">
                      {error}
                    </p>
                  ) : null}
                </div>
              </div>
            )}
          </section>
        </div>

        <footer className="mysql-page__foot">
          <span className="mysql-page__foot-hint">
            MySQL 连接按机器分别保存，可以存多条；标签页只是本次打开，重启后从左侧列表重新打开。
          </span>
          <span className="panel__spacer" />
          <button type="button" className="mysql-page__btn" onClick={onClose}>
            关闭
          </button>
          <button
            type="button"
            className="mysql-page__btn mysql-page__btn--primary"
            disabled={activeForm === null || saving || savedNow || activeForm.database.trim() === ''}
            onClick={() => void save()}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </footer>
      {/*
        Deleting is irreversible, so it goes through the project own confirm dialog rather
        than window.confirm: same styling and theme as everything else, and it can name
        the connection and where it points before anything is lost.
      */}
      <ConfirmDialog
        open={pendingDelete !== null}
        danger
        icon='🗑'
        title='删除连接'
        description={pendingDelete === null ? undefined : '删除后无法恢复，需要重新填写连接信息。'}
        items={
          pendingDelete === null
            ? []
            : [
                {
                  icon: '🔌',
                  label: connectionLabel(pendingDelete),
                  value: connectionTarget(pendingDelete),
                  tone: 'danger' as const
                },
                ...(pendingDelete.database.trim() === ''
                  ? []
                  : [{ icon: '🗄', label: '默认数据库', value: pendingDelete.database, tone: 'neutral' as const }])
              ]
        }
        confirmLabel='确认删除'
        onConfirm={() => void confirmRemove()}
        onCancel={() => setPendingDelete(null)}
      />      </div>
    </div>
  )
}