import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Tooltip } from '@base-ui/react/tooltip'
import MysqlIcon from './MysqlIcon'
import ConfirmDialog from './ConfirmDialog'
import './MysqlTableView.css'
import type {
  AppTheme,
  MysqlConnection,
  MysqlConnectionDraft,
  MysqlConnectionsState,
  MysqlDatabaseList,
  MysqlTableData,
  MysqlTableDdl,
  MysqlTableList
} from '../../../shared/types'

const SqlViewer = lazy(() => import('./SqlViewer'))

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

/**
 * One open page.
 *
 * Connection pages hold the editable connection and table list. Table pages show rows;
 * DDL pages show the server's CREATE statement.
 * They share the tab strip and nothing else, so the kind is carried on the tab rather
 * than inferred from which fields happen to be set.
 *
 * The tabs are in-memory only, like before: closing one costs nothing because the
 * connections themselves are in the database.
 */
interface ConnectionTab {
  kind: 'connection'
  /** The row id, or a temporary one for a connection never saved. */
  key: string
  form: ConnectionForm
  /** The tables inside this connection, and the state of the fetch that lists them. */
  tablesLoading: boolean
  tables: MysqlTableList | null
  tableSearch: string
}

interface TableTab {
  kind: 'table'
  /** Stable key: connection + database + table, so one table never opens twice. */
  key: string
  /** Which connection it came from, for the sidebar highlight. */
  connectionId: string
  database: string
  table: string
  /** The connection it was opened with. Carries the password, so it stays in memory. */
  draft: MysqlConnectionDraft
  loading: boolean
  data: MysqlTableData | null
  error: string
}

interface DdlTab extends Omit<TableTab, 'kind' | 'data'> {
  kind: 'ddl'
  data: MysqlTableDdl | null
  requestId: number
  copied: boolean
  copyError: string
}

type MysqlTab = ConnectionTab | TableTab | DdlTab

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

/** The caption of a connection page's tab. */
function tabCaption(form: ConnectionForm): string {
  if (form.name.trim() !== '') return form.name.trim()
  if (form.host.trim() !== '') return form.host.trim()
  return form.id === '' ? '新建连接' : '未命名连接'
}

/** What a tab is called, whichever kind it is. */
function tabTitle(tab: MysqlTab): string {
  return tab.kind === 'connection' ? tabCaption(tab.form) : `${tab.database}.${tab.table}${tab.kind === 'ddl' ? ' · DDL' : ''}`
}

/**
 * The connection as one paste-able URI, password included.
 *
 * `mysql://user:pass@host:port/database` is what every client accepts, and it is the one
 * form that carries all five values without the user reassembling them. User and password
 * are percent-encoded because a password containing @ : or / would otherwise split the URI
 * in the wrong place and hand the client a different host than the one that was copied.
 */
function connectionUri(connection: MysqlConnection): string {
  const user = encodeURIComponent(connection.username.trim())
  const password = connection.password === '' ? '' : ':' + encodeURIComponent(connection.password)
  const host = connection.host.trim() || '127.0.0.1'
  const port = connection.port ? ':' + connection.port : ''
  const database = encodeURIComponent(connection.database.trim())
  return 'mysql://' + user + password + '@' + host + port + (database === '' ? '' : '/' + database)
}

function connectionLabel(connection: MysqlConnection): string {
  if (connection.name.trim() !== '') return connection.name.trim()
  if (connection.host.trim() !== '') return connection.host.trim()
  return '未命名连接'
}

/**
 * Where a connection points, in the usual MySQL spelling: user@host:port/database.
 *
 * The database is part of the line rather than a separate badge because a list of
 * connections to the same server is common, and it is the database that tells them
 * apart — two rows reading `root@127.0.0.1:3306` would otherwise be identical.
 */
function connectionTarget(connection: MysqlConnection): string {
  const user = connection.username.trim()
  const host = connection.host.trim() || '未填写主机'
  const port = connection.port ? `:${connection.port}` : ''
  const database = connection.database.trim()
  return `${user === '' ? '' : `${user}@`}${host}${port}${database === '' ? '' : `/${database}`}`
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
  const [tabs, setTabs] = useState<MysqlTab[]>([])
  const [activeKey, setActiveKey] = useState('')
  const [reveal, setReveal] = useState(false)
  const newTabRef = useRef(0)
  const ddlRequestRef = useRef(0)
  /** Focused when saving is refused, so the missing field is the one on screen. */
  const databaseRef = useRef<HTMLInputElement>(null)
  /** Id of the connection whose info was just copied, for the transient 已复制 mark. */
  const [copiedId, setCopiedId] = useState('')
  const copyTimerRef = useRef<number | null>(null)
  /** The connection a delete is waiting on; non-null while the confirm dialog is up. */
  const [pendingDelete, setPendingDelete] = useState<MysqlConnection | null>(null)
  /** The database picker: whether it is open, what it is fetching, and what came back. */
  const [dbPickerOpen, setDbPickerOpen] = useState(false)
  const [dbLoading, setDbLoading] = useState(false)
  const [dbResult, setDbResult] = useState<MysqlDatabaseList | null>(null)
  const dbBoxRef = useRef<HTMLSpanElement>(null)

  const connections = state?.connections ?? []
  const machineLabel = state?.machineLabel ?? ''
  const activeTab = tabs.find((tab) => tab.key === activeKey) ?? null
  const activeConnection = activeTab !== null && activeTab.kind === 'connection' ? activeTab : null
  const activeForm = activeConnection?.form ?? null
  const activeConnectionId = activeTab === null ? '' : activeTab.kind === 'connection' ? activeTab.form.id : activeTab.connectionId
  const activeSaved =
    activeForm !== null && activeForm.id !== ''
      ? connections.find((connection) => connection.id === activeForm.id) ?? null
      : null
  const savedNow = activeForm !== null && activeSaved !== null && matchesSaved(activeForm, activeSaved)
  const tableSearch = activeConnection?.tableSearch.trim().toLowerCase() ?? ''
  const visibleTables = (activeConnection?.tables?.tables ?? []).filter(
    (table) => tableSearch === '' || table.name.toLowerCase().includes(tableSearch) || table.comment.toLowerCase().includes(tableSearch)
  )

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
      if (event.key === 'Escape' && !event.defaultPrevented) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  /**
   * Open a saved connection in its own tab, or bring the tab it already has to the front.
   *
   * The table list is fetched by the effect below rather than here, so opening a tab that
   * was merely brought to the front does not run the query again.
   */
  const openConnectionTab = useCallback((connection: MysqlConnection) => {
    setTabs((current) =>
      current.some((tab) => tab.key === connection.id)
        ? current
        : [
            ...current,
            {
              kind: 'connection',
              key: connection.id,
              form: formFromConnection(connection),
              tablesLoading: false,
              tables: null,
              tableSearch: ''
            }
          ]
    )
    setActiveKey(connection.id)
    setReveal(false)
    setError('')
  }, [])

  const addTab = useCallback(() => {
    newTabRef.current += 1
    const key = `new:${newTabRef.current}`
    setTabs((current) => [
      ...current,
      { kind: 'connection', key, form: { ...EMPTY_FORM }, tablesLoading: false, tables: null, tableSearch: '' }
    ])
    setActiveKey(key)
    setReveal(false)
    setError('')
  }, [])

  /**
   * Copy one connection to the clipboard as a mysql:// URI.
   *
   * The password goes with it, which is the whole point: the URI is meant to be pasted into
   * a client and used, and a URI missing its password is only half a connection. The mark
   * on the row is what tells the user it worked, since a clipboard write has no other
   * visible effect.
   */
  const copyConnection = useCallback(async (connection: MysqlConnection): Promise<void> => {
    try {
      await navigator.clipboard.writeText(connectionUri(connection))
    } catch {
      setError('复制失败，请检查剪贴板权限。')
      return
    }
    setCopiedId(connection.id)
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current)
    copyTimerRef.current = window.setTimeout(() => {
      setCopiedId('')
      copyTimerRef.current = null
    }, 1600)
  }, [])

  // A pending copy timer must not fire after the dialog is gone.
  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current)
    }
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
        current.map((tab) =>
          tab.kind === 'connection' && tab.key === activeKey
            ? { ...tab, form: { ...tab.form, ...patch } }
            : tab
        )
      )
    },
    [activeKey]
  )

  /**
   * Load the table list for one connection page.
   *
   * Called when the page is opened and by its own 刷新 button. The result is stored on the
   * tab, so switching to another tab and back does not re-query the server.
   */
  const refreshTables = useCallback(async (key: string, form: ConnectionForm): Promise<void> => {
    setTabs((current) =>
      current.map((tab) =>
        tab.kind === 'connection' && tab.key === key ? { ...tab, tablesLoading: true } : tab
      )
    )
    let result: MysqlTableList
    try {
      result = await window.api.listMysqlTables(draftFromForm(form), form.database.trim())
    } catch {
      result = { ok: false, tables: [], message: '连接失败，请检查连接信息。' }
    }
    setTabs((current) =>
      current.map((tab) =>
        tab.kind === 'connection' && tab.key === key
          ? { ...tab, tablesLoading: false, tables: result }
          : tab
      )
    )
  }, [])

  /**
   * Open one table in its own tab and read its first page.
   *
   * Keyed by connection + database + table so the same table cannot end up open twice;
   * clicking it again just brings its tab forward.
   */
  const openTableTab = useCallback(
    async (connectionId: string, form: ConnectionForm, table: string): Promise<void> => {
      const database = form.database.trim()
      const key = `table:${connectionId}:${database}:${table}`
      const alreadyOpen = tabs.some((tab) => tab.key === key)
      const draft = draftFromForm(form)
      if (!alreadyOpen) {
        setTabs((current) => [
          ...current,
          { kind: 'table', key, connectionId, database, table, draft, loading: true, data: null, error: '' }
        ])
      }
      setActiveKey(key)
      let result: MysqlTableData
      try {
        result = await window.api.queryMysqlTable(draft, database, table)
      } catch {
        result = { ok: false, sql: '', columns: [], columnComments: [], columnCommentsMessage: '', rows: [], truncated: false, message: '读取失败，请重试。' }
      }
      setTabs((current) =>
        current.map((tab) =>
          tab.kind === 'table' && tab.key === key
            ? { ...tab, loading: false, data: result, error: result.ok ? '' : result.message }
            : tab
        )
      )
    },
    [tabs]
  )

  const loadDdl = useCallback(
    async (key: string, draft: MysqlConnectionDraft, database: string, table: string): Promise<void> => {
      const requestId = ++ddlRequestRef.current
      setTabs((current) =>
        current.map((tab) =>
          tab.kind === 'ddl' && tab.key === key
            ? { ...tab, loading: true, data: null, error: '', copied: false, copyError: '', requestId }
            : tab
        )
      )
      let result: MysqlTableDdl
      try {
        result = await window.api.getMysqlTableDdl(draft, database, table)
      } catch {
        result = { ok: false, ddl: '', message: '读取 DDL 失败，请重试。' }
      }
      // A closed/reopened tab or a newer refresh must not receive an older response.
      setTabs((current) =>
        current.map((tab) =>
          tab.kind === 'ddl' && tab.key === key && tab.requestId === requestId
            ? { ...tab, loading: false, data: result, error: result.ok ? '' : result.message }
            : tab
        )
      )
    },
    []
  )

  const openDdlTab = useCallback(
    async (connectionId: string, form: ConnectionForm, table: string): Promise<void> => {
      const database = form.database.trim()
      const draft = draftFromForm(form)
      const key = `ddl:${JSON.stringify([connectionId, database, table])}`
      setTabs((current) =>
        current.some((tab) => tab.key === key)
          ? current
          : [
              ...current,
              {
                kind: 'ddl', key, connectionId, database, table, draft, loading: true,
                data: null, error: '', requestId: 0, copied: false, copyError: ''
              }
            ]
      )
      setActiveKey(key)
      await loadDdl(key, draft, database, table)
    },
    [loadDdl]
  )

  const copyDdl = useCallback(async (tab: DdlTab): Promise<void> => {
    if (tab.loading || !tab.data?.ok) return
    let copyError = ''
    try {
      await navigator.clipboard.writeText(tab.data.ddl)
    } catch {
      copyError = '复制失败，请重试或手动选择建表语句复制。'
    }
    setTabs((current) =>
      current.map((item) =>
        item.kind === 'ddl' && item.key === tab.key && item.requestId === tab.requestId
          ? { ...item, copied: copyError === '', copyError }
          : item
      )
    )
  }, [])

  /**
   * Open the database dropdown, fetching the list on the way in.
   *
   * The fetch is done on open rather than on mount because it is a real network
   * round trip: a page with three saved connections would otherwise make three
   * connections nobody asked for. The result stays until the form is closed, so
   * reopening the dropdown does not hit the server again.
   */
  const openDatabasePicker = useCallback(async (): Promise<void> => {
    if (activeForm === null || dbLoading) return
    if (dbPickerOpen) {
      setDbPickerOpen(false)
      return
    }
    setDbPickerOpen(true)
    if (dbResult !== null) return
    setDbLoading(true)
    try {
      setDbResult(await window.api.listMysqlDatabases(draftFromForm(activeForm)))
    } catch {
      setDbResult({ ok: false, databases: [], message: '连接失败，请检查连接信息。' })
    } finally {
      setDbLoading(false)
    }
  }, [activeForm, dbLoading, dbPickerOpen, dbResult])

  const save = useCallback(async (): Promise<void> => {
    if (saving || activeForm === null || activeConnection === null) return
    // A connection with no database is not usable later, so it is refused here rather
    // than stored and discovered when someone tries to connect with it.
    if (activeForm.database.trim() === '') {
      setError('数据库为必填项，请填写后再保存。')
      databaseRef.current?.focus()
      return
    }
    setSaving(true)
    setError('')
    const key = activeConnection.key
    try {
      const result = await window.api.saveMysqlConnection(draftFromForm(activeForm))
      setState({ machineLabel: result.machineLabel, connections: result.connections })
      const saved = result.connections.find((connection) => connection.id === result.id) ?? null
      const nextForm = saved ? formFromConnection(saved) : { ...activeForm, id: result.id }
      // A brand-new connection is keyed by a temporary id until this moment; the row id
      // replaces it, so the tab it was opened in becomes the tab of the saved row.
      setTabs((current) =>
        current.map((tab) =>
          tab.kind === 'connection' && tab.key === key ? { ...tab, key: result.id, form: nextForm } : tab
        )
      )
      setActiveKey((active) => (active === key ? result.id : active))
      // The table list belongs to the saved row now, so it is worth having.
      void refreshTables(result.id, nextForm)
    } catch {
      setError('保存失败，请重试。')
    } finally {
      setSaving(false)
    }
  }, [activeForm, activeConnection, saving, refreshTables])

  /**
   * Load a connection page's table list the first time it is shown.
   *
   * Deliberately keyed on the tab that is being shown, not on every tab: a session with
   * four connections open would otherwise make four connections at once on open, and most
   * of them are never looked at. Once loaded the list stays on the tab until 刷新.
   */
  useEffect(() => {
    const tab = tabs.find((candidate) => candidate.key === activeKey)
    if (!tab || tab.kind !== 'connection') return
    if (tab.tables !== null || tab.tablesLoading) return
    if (tab.form.id === '' || tab.form.host.trim() === '' || tab.form.database.trim() === '') return
    void refreshTables(tab.key, tab.form)
  }, [activeKey, tabs, refreshTables])
  // A new page starts with the picker closed and nothing fetched: the list belongs to
  // the connection that was open when it arrived.
  useEffect(() => {
    setDbPickerOpen(false)
    setDbResult(null)
    setDbLoading(false)
  }, [activeKey])

  // Clicking anywhere else closes the dropdown, the way a select behaves.
  useEffect(() => {
    if (!dbPickerOpen) return
    const onPointerDown = (event: PointerEvent): void => {
      if (dbBoxRef.current && !dbBoxRef.current.contains(event.target as Node)) setDbPickerOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [dbPickerOpen])
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
                    title={tabTitle(tab)}
                    onClick={() => {
                      setActiveKey(tab.key)
                      setReveal(false)
                      setError('')
                    }}
                  >
                    {tab.kind !== 'connection' ? (
                      <span className="mysql-page__tab-icon" aria-hidden="true">
                        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
                          <path d="M3.5 9.5h17M9 9.5v10" />
                        </svg>
                      </span>
                    ) : null}
                    {tabTitle(tab)}
                  </button>
                  <button
                    type="button"
                    className="mysql-page__tab-close"
                    aria-label={`关闭 ${tabTitle(tab)}`}
                    title={tab.kind === 'connection' ? '关闭这个页面（连接仍保留在左侧列表）' : tab.kind === 'ddl' ? '关闭这个 DDL 页' : '关闭这个表页'}
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
            title={activeTab?.kind === 'ddl' ? '正在查看建表语句' : activeForm === null ? '没有打开的连接' : savedNow ? '与已保存的内容一致' : '有改动尚未保存'}
          >
            <i />
            {activeTab?.kind === 'ddl' ? 'DDL' : activeForm === null ? '未打开' : savedNow ? '已保存' : '未保存'}
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
                        activeConnectionId === connection.id
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
                        className={copiedId === connection.id ? 'mysql-page__item-copy mysql-page__item-copy--done' : 'mysql-page__item-copy'}
                        aria-label={copiedId === connection.id ? '已复制连接信息' : '复制连接信息（含密码）'}
                        title={copiedId === connection.id ? '已复制到剪贴板（含密码）' : '复制连接信息（含密码）'}
                        onClick={() => void copyConnection(connection)}
                      >
                        {copiedId === connection.id ? (
                          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M3 8.5l3.2 3.2L13 4.8" />
                          </svg>
                        ) : (
                          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <rect x="5.5" y="5.5" width="8" height="8" rx="1.6" />
                            <path d="M10.5 5.5V4.1A1.6 1.6 0 0 0 8.9 2.5H4.1A1.6 1.6 0 0 0 2.5 4.1v4.8a1.6 1.6 0 0 0 1.6 1.6h1.4" />
                          </svg>
                        )}
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
            {activeTab === null ? (
              <div className="mysql-page__empty">
                <span className="mysql-page__empty-mark" aria-hidden="true">
                  <MysqlIcon size={40} />
                </span>
                <p className="mysql-page__empty-title">没有打开的连接</p>
                <p className="mysql-page__empty-sub">
                  点左上角「添加连接」新建，或在左侧列表里点一个已保存的连接把它打开。
                </p>
              </div>
            ) : activeTab.kind === 'ddl' ? (
              <div className="mysql-page__table">
                <div className="mysql-page__card-head mysql-page__ddl-head">
                  <span className="mysql-page__card-title">{activeTab.table} · DDL</span>
                  <span className="mysql-page__card-note">{activeTab.database}</span>
                  <span className="panel__spacer" />
                  <button
                    type="button"
                    className="mysql-page__btn"
                    disabled={activeTab.loading}
                    onClick={() => void loadDdl(activeTab.key, activeTab.draft, activeTab.database, activeTab.table)}
                  >
                    {activeTab.loading ? '读取中…' : '刷新'}
                  </button>
                  <button
                    type="button"
                    className="mysql-page__btn"
                    disabled={activeTab.loading || !activeTab.data?.ok}
                    onClick={() => void copyDdl(activeTab)}
                  >
                    {activeTab.copied ? '已复制' : '复制 DDL'}
                  </button>
                </div>
                {activeTab.loading ? (
                  <p className="mysql-page__hint" role="status">正在读取 DDL…</p>
                ) : activeTab.error ? (
                  <p className="mysql-page__hint mysql-page__hint--error" role="alert">{activeTab.error}</p>
                ) : activeTab.data?.ok ? (
                  <Suspense fallback={<p className="mysql-page__hint" role="status">正在加载 SQL 查看器…</p>}>
                    <SqlViewer
                      key={activeTab.key}
                      value={activeTab.data.ddl}
                      theme={theme}
                      label={`${activeTab.database}.${activeTab.table} 的建表语句`}
                    />
                  </Suspense>
                ) : null}
                {activeTab.copyError ? <p className="mysql-page__hint mysql-page__hint--error" role="alert">{activeTab.copyError}</p> : null}
              </div>
            ) : activeTab.kind === 'table' ? (
              <div className="mysql-page__table">
                <div className="mysql-page__card-head mysql-page__table-head">
                  <span className="mysql-page__card-title">{activeTab.table}</span>
                  <span className="mysql-page__card-note">{activeTab.database}</span>
                  <div className="mysql-page__query">
                    {activeTab.data?.sql ? (
                      <Suspense fallback={<span className="mysql-page__hint" role="status">正在加载 SQL…</span>}>
                        <SqlViewer compact value={activeTab.data.sql} theme={theme} label="实际执行的 SQL" />
                      </Suspense>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className="mysql-page__btn"
                    disabled={activeTab.loading}
                    title="重新读取这张表"
                    onClick={() => {
                      const key = activeTab.key
                      setTabs((current) =>
                        current.map((item) =>
                          item.kind === 'table' && item.key === key ? { ...item, loading: true } : item
                        )
                      )
                      void window.api
                        .queryMysqlTable(activeTab.draft, activeTab.database, activeTab.table)
                        .then((result) => {
                          setTabs((current) =>
                            current.map((item) =>
                              item.kind === 'table' && item.key === key
                                ? { ...item, loading: false, data: result, error: result.ok ? '' : result.message }
                                : item
                            )
                          )
                        })
                        .catch(() => {
                          setTabs((current) =>
                            current.map((item) =>
                              item.kind === 'table' && item.key === key
                                ? { ...item, loading: false, error: '读取失败，请重试。' }
                                : item
                            )
                          )
                        })
                    }}
                  >
                    {activeTab.loading ? '读取中…' : '刷新'}
                  </button>
                </div>
                {activeTab.loading ? (
                  <p className="mysql-page__hint">正在读取表数据…</p>
                ) : activeTab.error ? (
                  <p className="mysql-page__hint mysql-page__hint--error" role="alert">{activeTab.error}</p>
                ) : activeTab.data === null || activeTab.data.columns.length === 0 ? (
                  <p className="mysql-page__hint">这张表没有数据。</p>
                ) : (
                  <>
                    <Tooltip.Provider delay={200}>
                      <div className="mysql-page__table-scroll">
                        <table className="mysql-page__grid-table">
                          <thead>
                            <tr>
                              {activeTab.data.columns.map((column, columnIndex) => (
                                <th key={column} scope="col">
                                  <Tooltip.Root>
                                    <Tooltip.Trigger render={<span tabIndex={0} className="mysql-page__column-trigger" />}>
                                      {column}
                                    </Tooltip.Trigger>
                                    <Tooltip.Portal>
                                      <Tooltip.Positioner side="bottom" align="start" sideOffset={8} className="mysql-page__column-positioner">
                                        <Tooltip.Popup className="mysql-page__column-tooltip" data-theme={theme}>
                                          <strong>{column}</strong>
                                          <p>{activeTab.data?.columnCommentsMessage || activeTab.data?.columnComments[columnIndex] || '暂无字段注释'}</p>
                                        </Tooltip.Popup>
                                      </Tooltip.Positioner>
                                    </Tooltip.Portal>
                                  </Tooltip.Root>
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {activeTab.data.rows.length === 0 ? (
                              <tr><td colSpan={activeTab.data.columns.length} className="mysql-page__empty-cell">这张表没有数据。</td></tr>
                            ) : null}
                            {activeTab.data.rows.map((row, rowIndex) => (
                              <tr key={rowIndex}>
                                {row.map((cell, cellIndex) => (
                                  <td key={cellIndex}>
                                    {cell === null ? <span className="mysql-page__null">NULL</span> : cell}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </Tooltip.Provider>
                    <p className="mysql-page__hint mysql-page__table-note">
                      共 {activeTab.data.rows.length} 行{activeTab.data.truncated ? '（只显示前 200 行）' : ''}
                    </p>
                    {activeTab.data.columnCommentsMessage ? (
                      <p className="mysql-page__hint" role="status">{activeTab.data.columnCommentsMessage}</p>
                    ) : null}
                  </>
                )}
              </div>
            ) : activeForm !== null ? (
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

                  <div className="mysql-page__field mysql-page__field--wide">
                    <span className="mysql-page__label">
                      默认数据库
                      <span className="mysql-page__required">必填</span>
                    </span>
                    <span className="mysql-page__db" ref={dbBoxRef}>
                      <input
                        className="mysql-page__input"
                        ref={databaseRef}
                        value={activeForm.database}
                        spellCheck={false}
                        required
                        placeholder="例如：myapp_dev（必填），或点右侧查看"
                        onChange={(event) => {
                          setDbResult(null)
                          updateForm({ database: event.target.value })
                        }}
                      />
                      <button
                        type="button"
                        className={dbPickerOpen ? 'mysql-page__db-btn mysql-page__db-btn--on' : 'mysql-page__db-btn'}
                        aria-haspopup="listbox"
                        aria-expanded={dbPickerOpen}
                        title="连接这台服务器并列出可选的数据库"
                        onClick={() => void openDatabasePicker()}
                      >
                        {dbLoading ? '查询中…' : dbPickerOpen ? '收起' : '查看数据库'}
                      </button>
                      {dbPickerOpen ? (
                        <div className="mysql-page__db-menu" role="listbox" aria-label="数据库列表">
                          {dbLoading ? (
                            <p className="mysql-page__db-note">正在连接服务器并读取数据库列表…</p>
                          ) : dbResult === null ? null : !dbResult.ok ? (
                            <p className="mysql-page__db-note mysql-page__db-note--error">{dbResult.message}</p>
                          ) : dbResult.databases.length === 0 ? (
                            <p className="mysql-page__db-note">这个账号看不到任何数据库。</p>
                          ) : (
                            <>
                              <div className="mysql-page__db-head">
                                <span>共 {dbResult.databases.length} 个</span>
                                <button
                                  type="button"
                                  className="mysql-page__db-refresh"
                                  title="重新连接并刷新列表"
                                  onClick={() => {
                                    setDbResult(null)
                                    void openDatabasePicker()
                                  }}
                                >
                                  刷新
                                </button>
                              </div>
                              <ul className="mysql-page__db-list">
                                {dbResult.databases.map((name) => (
                                  <li key={name}>
                                    <button
                                      type="button"
                                      role="option"
                                      aria-selected={activeForm.database === name}
                                      className={
                                        activeForm.database === name
                                          ? 'mysql-page__db-item mysql-page__db-item--active'
                                          : 'mysql-page__db-item'
                                      }
                                      onClick={() => {
                                        updateForm({ database: name })
                                        setDbPickerOpen(false)
                                      }}
                                    >
                                      <span className="mysql-page__db-icon" aria-hidden="true">
                                        <MysqlIcon size={14} />
                                      </span>
                                      <span className="mysql-page__db-name">{name}</span>
                                    </button>
                                  </li>
                                ))}
                              </ul>
                            </>
                          )}
                        </div>
                      ) : null}
                    </span>
                  </div>

                  <p className="mysql-page__hint mysql-page__hint--note mysql-page__field--wide">
                    密码会用系统加密后保存在本机数据库，不会明文写入。
                  </p>
                  {error ? (
                    <p className="mysql-page__hint mysql-page__hint--error mysql-page__field--wide" role="alert">
                      {error}
                    </p>
                  ) : null}
                </div>
                <div className="mysql-page__tables">
                  <div className="mysql-page__tables-head">
                    <div className="mysql-page__tables-summary">
                      <span className="mysql-page__card-title">数据表</span>
                      {activeConnection !== null && activeConnection.tables !== null && activeConnection.tables.ok ? (
                        <span className="mysql-page__card-note" role="status">
                          {tableSearch === '' ? `共 ${activeConnection.tables.tables.length} 张` : `匹配 ${visibleTables.length} / 共 ${activeConnection.tables.tables.length} 张`}
                        </span>
                      ) : null}
                    </div>
                    <div className="mysql-page__tables-actions">
                      <input
                        type="search"
                        className="mysql-page__input mysql-page__table-search"
                        placeholder="搜索表名或表注释"
                        aria-label="搜索表名或表注释"
                        value={activeConnection?.tableSearch ?? ''}
                        onChange={(event) => {
                          const tableSearch = event.currentTarget.value
                          setTabs((current) => current.map((tab) =>
                            tab.kind === 'connection' && tab.key === activeKey ? { ...tab, tableSearch } : tab
                          ))
                        }}
                      />
                      <button
                        type="button"
                        className="mysql-page__btn"
                        disabled={activeConnection === null || activeConnection.tablesLoading || activeForm.host.trim() === '' || activeForm.database.trim() === ''}
                        title="重新连接并读取表列表"
                        onClick={() => {
                          if (activeConnection !== null && activeForm !== null) void refreshTables(activeConnection.key, activeForm)
                        }}
                      >
                        {activeConnection?.tablesLoading ? '读取中…' : '刷新'}
                      </button>
                    </div>
                  </div>
                  {activeConnection === null || activeConnection.tablesLoading ? (
                    <p className="mysql-page__hint">正在读取数据表…</p>
                  ) : activeConnection.tables === null ? (
                    <p className="mysql-page__hint">点「刷新」读取这张连接里的表。</p>
                  ) : !activeConnection.tables.ok ? (
                    <p className="mysql-page__hint mysql-page__hint--error" role="alert">{activeConnection.tables.message}</p>
                  ) : activeConnection.tables.tables.length === 0 ? (
                    <p className="mysql-page__hint">这个数据库里还没有表。</p>
                  ) : visibleTables.length === 0 ? (
                    <p className="mysql-page__hint" role="status">没有匹配的表，请修改或清空搜索关键词。</p>
                  ) : (
                    <ul className="mysql-page__table-list">
                      {visibleTables.map((table) => (
                        <li key={table.name} className="mysql-page__table-row">
                          <button
                            type="button"
                            className="mysql-page__table-item"
                            title={table.comment === '' ? table.name : table.name + ' · ' + table.comment}
                            onClick={() => {
                              if (activeForm !== null && activeConnection !== null) void openTableTab(activeConnection.key, activeForm, table.name)
                            }}
                          >
                            <span className="mysql-page__table-name" title={table.name}>{table.name}</span>
                            <span className={table.type === 'VIEW' ? 'mysql-page__table-type mysql-page__table-type--view' : 'mysql-page__table-type'}>{table.type === 'VIEW' ? '视图' : '表'}</span>
                            {table.comment.trim() !== '' ? <span className="mysql-page__table-comment">{table.comment}</span> : null}
                          </button>
                          <button
                            type="button"
                            className="mysql-page__btn mysql-page__table-ddl"
                            aria-label={`查看 ${table.name} 的 DDL`}
                            onClick={() => {
                              if (activeForm !== null && activeConnection !== null) void openDdlTab(activeConnection.key, activeForm, table.name)
                            }}
                          >
                            查看 DDL
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="mysql-page__card-foot">                   <span className="mysql-page__card-foot-hint">                     {savedNow ? '已保存到本机' : '有改动尚未保存'}                   </span>                   <span className="panel__spacer" />                   <button                     type="button"                     className="mysql-page__btn"                     title="关闭这个页面，连接仍保留在左侧列表"                     onClick={() => {                       if (activeTab !== null) closeTab(activeTab.key)                     }}                   >                     关闭                   </button>                   <button                     type="button"                     className="mysql-page__btn mysql-page__btn--primary"                     disabled={saving || savedNow || activeForm.database.trim() === ''}                     onClick={() => void save()}                   >                     {saving ? '保存中…' : '保存'}                   </button>                 </div>
              </div>
            ) : null}
          </section>
        </div>
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
