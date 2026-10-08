import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type {
  AppTheme, RedisConnection, RedisConnectionDraft, RedisConnectionsState,
  RedisConnectionResult, RedisKeyData, RedisKeyInfo, RedisKeyPage, RedisValueCell
} from '../../../shared/types'
import { formatRedisJson, mergeRedisEntries } from '../../../shared/redis-display'
import ConfirmDialog from './ConfirmDialog'
import RedisIcon from './RedisIcon'
import './RedisDialog.css'

interface ConnectionForm extends Omit<RedisConnectionDraft, 'port' | 'database'> {
  port: string
  database: string
}

interface ConnectionTab {
  key: string
  form: ConnectionForm
  view: 'connection' | 'data'
  database: string
  search: string
  appliedSearch: string
  page: RedisKeyPage | null
  keysLoading: boolean
  keysRequest: number
  keysError: string
  selected: RedisKeyInfo | null
  value: RedisKeyData | null
  valueLoading: boolean
  valueRequest: number
  valueError: string
  testing: boolean
  testRequest: number
  testResult: RedisConnectionResult | null
}

const EMPTY_FORM: ConnectionForm = {
  id: '', name: '', host: '', port: '6379', username: '', password: '', database: '0', tls: false
}
const EMPTY_BROWSER = {
  page: null, keysLoading: false, keysRequest: 0, keysError: '', selected: null,
  value: null, valueLoading: false, valueRequest: 0, valueError: ''
}

function makeTab(key: string, form: ConnectionForm, view: ConnectionTab['view']): ConnectionTab {
  return { key, form, view, database: form.database, search: '', appliedSearch: '', ...EMPTY_BROWSER,
    testing: false, testRequest: 0, testResult: null }
}

function draftFromForm(form: ConnectionForm, database = form.database): RedisConnectionDraft {
  return { ...form, name: form.name.trim(), host: form.host.trim(), username: form.username.trim(),
    port: form.port.trim() === '' ? NaN : Number(form.port), database: database.trim() === '' ? NaN : Number(database) }
}

function connectionTitle(form: ConnectionForm): string {
  return form.name.trim() || form.host.trim() || '新建连接'
}

function formFromConnection(connection: RedisConnection): ConnectionForm {
  return { id: connection.id, name: connection.name, host: connection.host, port: String(connection.port),
    username: connection.username, password: connection.password, database: String(connection.database), tls: connection.tls }
}

function ttlLabel(ttl: number | null): string {
  if (ttl === null) return 'TTL 未知'
  if (ttl === -1) return '永不过期'
  if (ttl === -2) return '已过期'
  if (ttl < 1000) return `${ttl} ms`
  if (ttl < 60000) return `${Math.ceil(ttl / 1000)} 秒`
  if (ttl < 3600000) return `${Math.ceil(ttl / 60000)} 分钟`
  return `${(ttl / 3600000).toFixed(1)} 小时`
}

function bytesLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

function Cell({ value }: { value: RedisValueCell }): ReactElement {
  return <span className="redis-page__cell">
    {value.encoding === 'hex' ? <small className="redis-page__encoding">HEX</small> : null}
    {value.text === '' ? <span className="redis-page__muted">（空字符串）</span> : value.text}
    {value.truncated ? <small className="redis-page__muted"> …（已截断，原始 {bytesLabel(value.bytes)}）</small> : null}
  </span>
}

function stringPreview(value: RedisValueCell, format: 'text' | 'json'): string {
  if (format === 'json' && value.encoding === 'text' && !value.truncated) {
    return formatRedisJson(value.text) ?? value.text
  }
  return value.text
}

export default function RedisDialog({ open, theme, onClose }: {
  open: boolean; theme: AppTheme; onClose: () => void
}): ReactElement | null {
  const [state, setState] = useState<RedisConnectionsState | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [tabs, setTabs] = useState<ConnectionTab[]>([])
  const [activeKey, setActiveKey] = useState('')
  const [reveal, setReveal] = useState(false)
  const [format, setFormat] = useState<'text' | 'json'>('text')
  const [pendingDelete, setPendingDelete] = useState<RedisConnection | null>(null)
  const [removing, setRemoving] = useState(false)
  const requestRef = useRef(0)
  const newTabRef = useRef(0)
  const ownerRef = useRef('')
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const activeTab = tabs.find((tab) => tab.key === activeKey) ?? null
  const connections = state?.connections ?? []
  const activeSaved = connections.find((connection) => connection.id === activeTab?.form.id)
  const savedNow = activeTab !== null && activeSaved !== undefined &&
    JSON.stringify(draftFromForm(activeTab.form)) === JSON.stringify(draftFromForm(formFromConnection(activeSaved)))

  const applyState = useCallback((next: RedisConnectionsState): void => {
    if (ownerRef.current && ownerRef.current !== next.ownerKey) {
      setTabs([])
      setActiveKey('')
      setPendingDelete(null)
      setError('')
    }
    ownerRef.current = next.ownerKey
    setState(next)
  }, [])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    let receivedEvent = false
    setLoading(true)
    setError('')
    const unsubscribe = window.api.onRedisConnectionChanged((next) => {
      receivedEvent = true
      applyState(next)
    })
    void window.api.listRedisConnections().then((next) => {
      if (!cancelled && !receivedEvent) applyState(next)
    }).catch(() => {
      if (!cancelled) setError('读取已保存连接失败，请检查系统密码加密服务后重试。')
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true; unsubscribe() }
  }, [open, applyState])

  useEffect(() => {
    if (!open) return
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented && !pendingDelete) onClose()
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [open, onClose, pendingDelete])

  const loadKeys = useCallback(async (tab: ConnectionTab, append = false): Promise<void> => {
    const request = ++requestRef.current
    const search = append ? tab.appliedSearch : tab.search.trim()
    const cursor = append ? tab.page?.cursor ?? '0' : '0'
    setTabs((current) => current.map((item) => item.key === tab.key ? {
      ...item, ...(append ? {} : EMPTY_BROWSER), view: 'data', keysLoading: true,
      keysRequest: request, keysError: '', appliedSearch: search
    } : item))
    let result: RedisKeyPage
    try { result = await window.api.scanRedisKeys(draftFromForm(tab.form, tab.database), cursor, search) }
    catch { result = { ok: false, keys: [], cursor: '0', complete: true, total: null, message: '读取失败，请重试。', notice: '' } }
    setTabs((current) => current.map((item) => {
      if (item.key !== tab.key || item.keysRequest !== request) return item
      if (!result.ok) return { ...item, keysLoading: false, keysError: result.message }
      const keys = mergeRedisEntries(append ? item.page?.keys ?? [] : [], result.keys)
      return { ...item, keysLoading: false, page: { ...result, keys } }
    }))
  }, [])

  const loadValue = useCallback(async (tab: ConnectionTab, key: RedisKeyInfo, append = false): Promise<void> => {
    const request = ++requestRef.current
    setFormat('text')
    setTabs((current) => current.map((item) => item.key === tab.key ? {
      ...item, selected: key, value: append ? item.value : null, valueLoading: true, valueRequest: request, valueError: ''
    } : item))
    let result: RedisKeyData
    try { result = await window.api.readRedisKey(draftFromForm(tab.form, tab.database), key.id, append ? tab.value?.nextCursor ?? '0' : '0') }
    catch { result = { ok: false, key: null, columns: [], rows: [], value: null, total: null, nextCursor: null, message: '读取失败，请重试。', notice: '' } }
    setTabs((current) => current.map((item) => {
      if (item.key !== tab.key || item.valueRequest !== request) return item
      if (!result.ok) return { ...item, valueLoading: false, valueError: result.message }
      const sameType = item.value?.key?.type === result.key?.type
      if (append && !sameType) return {
        ...item, valueLoading: false, selected: result.key ?? key, value: null,
        valueError: '键的数据类型已改变，请刷新详情后重新读取。'
      }
      const rows = mergeRedisEntries(append && sameType ? item.value?.rows ?? [] : [], result.rows)
      return { ...item, valueLoading: false, selected: result.key ?? key, value: { ...result, rows } }
    }))
  }, [])

  // Saved connections load only when explicitly opened. Tab switches reuse loaded data.
  useEffect(() => {
    if (!open) return
    const tab = tabsRef.current.find((item) => item.key === activeKey)
    if (tab?.view === 'data' && tab.page === null && !tab.keysLoading && !tab.keysError) void loadKeys(tab)
  }, [open, activeKey, loadKeys])

  const updateForm = (patch: Partial<ConnectionForm>): void => {
    setError('')
    setTabs((current) => current.map((tab) => tab.key === activeKey ? {
      ...tab, form: { ...tab.form, ...patch }, ...EMPTY_BROWSER,
      database: patch.database ?? tab.database, testing: false, testRequest: 0, testResult: null
    } : tab))
  }

  const save = async (tab: ConnectionTab): Promise<void> => {
    setSaving(true)
    setError('')
    const owner = ownerRef.current
    try {
      const result = await window.api.saveRedisConnection(draftFromForm(tab.form))
      if (ownerRef.current !== owner || result.ownerKey !== owner) return
      applyState(result)
      const saved = result.connections.find((connection) => connection.id === result.id)
      if (!saved) return
      setTabs((current) => current.map((item) => item.key === tab.key ? { ...item, form: formFromConnection(saved) } : item))
    } catch (reason) {
      if (ownerRef.current === owner) setError(reason instanceof Error ? reason.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : '保存失败，请重试。')
    } finally { setSaving(false) }
  }

  const testConnection = async (tab: ConnectionTab): Promise<void> => {
    const request = ++requestRef.current
    setTabs((current) => current.map((item) => item.key === tab.key ? { ...item, testing: true, testRequest: request, testResult: null } : item))
    let result: RedisConnectionResult
    try { result = await window.api.testRedisConnection(draftFromForm(tab.form)) }
    catch { result = { ok: false, message: '连接失败，请重试。' } }
    setTabs((current) => current.map((item) => item.key === tab.key && item.testRequest === request ? { ...item, testing: false, testResult: result } : item))
  }

  const closeTab = (key: string): void => {
    const index = tabs.findIndex((tab) => tab.key === key)
    const remaining = tabs.filter((tab) => tab.key !== key)
    setTabs(remaining)
    if (activeKey === key) setActiveKey(remaining[Math.min(index, remaining.length - 1)]?.key ?? '')
  }

  const removeConnection = async (): Promise<void> => {
    if (!pendingDelete) return
    const id = pendingDelete.id
    const owner = ownerRef.current
    setRemoving(true)
    try {
      const next = await window.api.removeRedisConnection(id)
      if (ownerRef.current !== owner) return
      applyState(next)
      const remaining = tabsRef.current.filter((tab) => tab.form.id !== id)
      setTabs(remaining)
      if (tabsRef.current.some((tab) => tab.key === activeKey && tab.form.id === id)) setActiveKey(remaining[0]?.key ?? '')
      setPendingDelete(null)
    } catch { setError('移除连接失败，请重试。'); setPendingDelete(null) }
    finally { setRemoving(false) }
  }

  if (!open) return null
  return <div className="modal modal--mysql" role="dialog" aria-modal="true" aria-label="Redis 连接">
    <div className="mysql-page redis-page" data-theme={theme}>
      <header className="mysql-page__head">
        <button type="button" className="mysql-page__add" disabled={loading || state === null} onClick={() => {
          const key = `new:${++newTabRef.current}`
          setTabs((current) => [...current, makeTab(key, { ...EMPTY_FORM }, 'connection')])
          setActiveKey(key); setError(''); setReveal(false)
        }}>＋ 添加连接</button>
        <div className="mysql-page__tabs" role="tablist" aria-label="Redis 连接页">
          {tabs.length === 0 ? <span className="mysql-page__tabs-empty">未打开任何连接</span> : tabs.map((tab) =>
            <div key={tab.key} className={`mysql-page__tab${tab.key === activeKey ? ' mysql-page__tab--active' : ''}`}>
              <button type="button" role="tab" aria-selected={tab.key === activeKey} className="mysql-page__tab-label"
                onClick={() => { setActiveKey(tab.key); setReveal(false); setError('') }}>
                <RedisIcon size={14} /> {connectionTitle(tab.form)}
              </button>
              <button type="button" className="mysql-page__tab-close" aria-label={`关闭 ${connectionTitle(tab.form)}`} onClick={() => closeTab(tab.key)}>×</button>
            </div>
          )}
        </div>
        <span className="panel__spacer" />
        <span className="redis-page__readonly">只读</span>
        <button type="button" className="mysql-page__close" aria-label="关闭 Redis 工具页" onClick={onClose}>×</button>
      </header>
      <div className="mysql-page__body">
        <aside className="mysql-page__sidebar">
          <div className="mysql-page__sidebar-head"><span className="mysql-page__sidebar-title">已保存连接</span><span className="mysql-page__sidebar-count">{connections.length}</span></div>
          {loading ? <p className="mysql-page__hint mysql-page__sidebar-hint">正在读取连接…</p> : connections.length === 0 ?
            <p className="mysql-page__hint mysql-page__sidebar-hint">添加一个 Redis 连接，开始浏览数据。</p> :
            <ul className="mysql-page__sidebar-list">{connections.map((connection) => <li key={connection.id}
              className={`mysql-page__item${activeTab?.form.id === connection.id ? ' mysql-page__item--active' : ''}`}>
              <button type="button" className="mysql-page__item-main" onClick={() => {
                const existing = tabs.find((tab) => tab.form.id === connection.id)
                const key = existing?.key ?? connection.id
                if (!existing) setTabs((current) => [...current, makeTab(key, formFromConnection(connection), 'data')])
                setActiveKey(key); setReveal(false); setError('')
              }}><span className="mysql-page__item-name">{connection.name || connection.host}</span>
                <span className="mysql-page__item-target">{connection.host}:{connection.port} / DB {connection.database}{connection.tls ? ' · TLS' : ''}</span></button>
              <button type="button" className="mysql-page__item-remove" aria-label={`移除连接 ${connection.name || connection.host}`} title="移除保存的连接配置" onClick={() => setPendingDelete(connection)}>×</button>
            </li>)}</ul>}
        </aside>
        <section className="mysql-page__detail">
          {error ? <p className="mysql-page__hint mysql-page__hint--error redis-page__error" role="alert">{error}</p> : null}
          {!activeTab ? <div className="mysql-page__empty"><RedisIcon size={52} /><p className="mysql-page__empty-title">Redis 连接</p>
            <p className="mysql-page__empty-sub">从左侧选择连接，或添加连接。支持查看键和值、搜索键名及过期时间。</p></div> : <>
            <div className="redis-page__navigation">
              <button type="button" className={`mysql-page__btn${activeTab.view === 'connection' ? ' redis-page__nav--active' : ''}`} onClick={() => setTabs((current) => current.map((tab) => tab.key === activeKey ? { ...tab, view: 'connection' } : tab))}>连接设置</button>
              <button type="button" className={`mysql-page__btn${activeTab.view === 'data' ? ' redis-page__nav--active' : ''}`} onClick={() => {
                setTabs((current) => current.map((tab) => tab.key === activeKey ? { ...tab, view: 'data' } : tab))
                if (!activeTab.page && !activeTab.keysLoading) void loadKeys(activeTab)
              }}>浏览数据</button>
              <span className="mysql-page__card-note">{state?.machineLabel || '本机'} · {savedNow ? '已保存' : '连接设置未保存'}</span>
            </div>
            {activeTab.view === 'connection' ? <div className="mysql-page__card">
              <div className="mysql-page__card-head"><span className="mysql-page__card-title">Redis 连接信息</span><span className="mysql-page__card-note">由本机直连单机 Redis</span></div>
              <fieldset className="mysql-page__grid redis-page__fields" disabled={saving}>
                <label className="mysql-page__field mysql-page__field--wide"><span className="mysql-page__label">连接名称</span>
                  <input className="mysql-page__input" value={activeTab.form.name} onChange={(event) => updateForm({ name: event.currentTarget.value })} /></label>
                <label className="mysql-page__field"><span className="mysql-page__label">主机 / IP</span>
                  <input className="mysql-page__input" placeholder="127.0.0.1" value={activeTab.form.host} onChange={(event) => updateForm({ host: event.currentTarget.value })} /></label>
                <label className="mysql-page__field"><span className="mysql-page__label">端口</span>
                  <input className="mysql-page__input" type="number" min={1} max={65535} value={activeTab.form.port} onChange={(event) => updateForm({ port: event.currentTarget.value })} /></label>
                <label className="mysql-page__field"><span className="mysql-page__label">用户名（ACL，可选）</span>
                  <input className="mysql-page__input" placeholder="留空使用默认用户" autoComplete="off" value={activeTab.form.username} onChange={(event) => updateForm({ username: event.currentTarget.value })} /></label>
                <label className="mysql-page__field"><span className="mysql-page__label">密码</span><span className="mysql-page__password">
                  <input className="mysql-page__input" type={reveal ? 'text' : 'password'} autoComplete="new-password" value={activeTab.form.password} onChange={(event) => updateForm({ password: event.currentTarget.value })} />
                  <button type="button" className="mysql-page__reveal" onClick={() => setReveal((value) => !value)}>{reveal ? '隐藏' : '显示'}</button></span></label>
                <label className="mysql-page__field"><span className="mysql-page__label">默认数据库编号</span>
                  <input className="mysql-page__input" type="number" min={0} step={1} value={activeTab.form.database} onChange={(event) => updateForm({ database: event.currentTarget.value })} /></label>
                <label className="redis-page__tls"><input type="checkbox" checked={activeTab.form.tls} onChange={(event) => updateForm({ tls: event.currentTarget.checked })} />启用 TLS</label>
                <p className="mysql-page__hint mysql-page__hint--note mysql-page__field--wide">密码用系统加密后保存在本机。数据库内容仅供查看。</p>
                {activeTab.testResult ? <p role="status" className={`mysql-page__hint mysql-page__field--wide${activeTab.testResult.ok ? ' redis-page__success' : ' mysql-page__hint--error'}`}>{activeTab.testResult.message}</p> : null}
              </fieldset>
              <div className="mysql-page__card-foot">
                <button type="button" className="mysql-page__btn" disabled={activeTab.testing} onClick={() => void testConnection(activeTab)}>{activeTab.testing ? '连接中…' : '测试连接'}</button>
                <span className="panel__spacer" />
                <button type="button" className="mysql-page__btn" disabled={saving || savedNow} onClick={() => void save(activeTab)}>{saving ? '保存中…' : '保存连接'}</button>
                <button type="button" className="mysql-page__btn mysql-page__btn--primary" disabled={activeTab.keysLoading} onClick={() => void loadKeys(activeTab)}>浏览数据</button>
              </div>
            </div> : <div className="redis-page__browser">
              <div className="redis-page__toolbar">
                <label className="redis-page__database"><span>数据库 DB</span><input type="number" min={0} step={1} aria-label="当前数据库编号" className="mysql-page__input" value={activeTab.database}
                  onChange={(event) => { const database = event.currentTarget.value; setTabs((current) => current.map((tab) => tab.key === activeKey ? { ...tab, database, ...EMPTY_BROWSER } : tab)) }} /></label>
                <form className="redis-page__search" onSubmit={(event) => { event.preventDefault(); void loadKeys(activeTab) }}>
                  <input type="search" className="mysql-page__input" placeholder="搜索键名，按 Enter 搜索" aria-label="搜索 Redis 键名" maxLength={1024} value={activeTab.search}
                    onChange={(event) => { const search = event.currentTarget.value; setTabs((current) => current.map((tab) => tab.key === activeKey ? { ...tab, search } : tab)) }} />
                  <button type="submit" className="mysql-page__btn" disabled={activeTab.keysLoading}>搜索</button>
                </form>
                <button type="button" className="mysql-page__btn" disabled={activeTab.keysLoading} onClick={() => void loadKeys(activeTab)}>{activeTab.keysLoading ? '读取中…' : '刷新'}</button>
              </div>
              <div className="redis-page__panes">
                <section className="redis-page__keys" aria-label="Redis 键列表">
                  <div className="redis-page__section-head"><strong>键列表</strong><span className="mysql-page__card-note" role="status">已加载 {activeTab.page?.keys.length ?? 0}{activeTab.page?.total != null ? ` / DB 共 ${activeTab.page.total}` : ''}</span></div>
                  {activeTab.appliedSearch ? <p className="mysql-page__hint redis-page__search-note">搜索：{activeTab.appliedSearch}</p> : null}
                  {activeTab.keysError ? <p className="mysql-page__hint mysql-page__hint--error" role="alert">{activeTab.keysError}</p> : null}
                  {activeTab.page?.notice ? <p className="mysql-page__hint">{activeTab.page.notice}</p> : null}
                  {activeTab.keysLoading && !activeTab.page ? <p className="mysql-page__hint" role="status">正在扫描键…</p> : !activeTab.page ? <p className="mysql-page__hint">点击搜索或刷新，读取这个数据库。</p> :
                    activeTab.page.keys.length === 0 ? <p className="mysql-page__hint">{activeTab.page.complete ? '没有匹配的键。' : '当前批次没有匹配结果，可以继续扫描。'}</p> : null}
                  <ul className="redis-page__key-list">{activeTab.page?.keys.map((key) => <li key={key.id}>
                    <button type="button" className={`redis-page__key${activeTab.selected?.id === key.id ? ' redis-page__key--active' : ''}`} title={key.name} onClick={() => void loadValue(activeTab, key)}>
                      <span className="redis-page__key-name">{key.name || '（空键名）'}</span><span className="redis-page__key-meta"><span className="redis-page__type">{key.type}</span><span>{ttlLabel(key.ttl)}</span></span>
                    </button></li>)}</ul>
                  {activeTab.page && !activeTab.page.complete ? <button type="button" className="mysql-page__btn redis-page__load" disabled={activeTab.keysLoading || activeTab.search.trim() !== activeTab.appliedSearch} onClick={() => void loadKeys(activeTab, true)}>{activeTab.keysLoading ? '读取中…' : '加载更多键'}</button> : null}
                </section>
                <section className="redis-page__value" aria-label="Redis 数据详情">
                  {!activeTab.selected ? <div className="redis-page__value-empty"><RedisIcon size={42} /><p>选择一个键查看数据</p></div> : <>
                    <div className="redis-page__section-head"><strong className="redis-page__value-name">{activeTab.selected.name || '（空键名）'}</strong>
                      <button type="button" className="mysql-page__btn" disabled={activeTab.valueLoading} onClick={() => void loadValue(activeTab, activeTab.selected!)}>刷新</button></div>
                    <div className="redis-page__value-meta"><span className="redis-page__type">{activeTab.selected.type}</span><span>TTL：{ttlLabel(activeTab.selected.ttl)}</span>
                      {activeTab.value?.total != null ? <span>{activeTab.selected.type === 'string' ? `大小：${bytesLabel(activeTab.value.total)}` : `总数：${activeTab.value.total}`}</span> : null}</div>
                    <p className="mysql-page__hint">过期时间为最近一次读取时的值。</p>
                    {activeTab.valueError ? <p className="mysql-page__hint mysql-page__hint--error" role="alert">{activeTab.valueError}</p> : null}
                    {activeTab.valueLoading && !activeTab.value ? <p className="mysql-page__hint" role="status">正在读取数据…</p> : null}
                    {activeTab.value?.notice ? <p className="mysql-page__hint redis-page__notice">{activeTab.value.notice}</p> : null}
                    {activeTab.value?.value ? <>
                      <div className="redis-page__format"><span className="mysql-page__card-note">{activeTab.value.value.encoding === 'hex' ? '十六进制预览' : '字符串内容'}</span>
                        {activeTab.value.value.encoding === 'text' && !activeTab.value.value.truncated ? <label>显示格式 <select value={format} onChange={(event) => setFormat(event.currentTarget.value as 'text' | 'json')}><option value="text">原始文本</option><option value="json">JSON 格式化</option></select></label> : null}</div>
                      <pre className="redis-page__string">{stringPreview(activeTab.value.value, format) || '（空字符串）'}</pre>
                    </> : null}
                    {activeTab.value && activeTab.value.columns.length > 0 ? <div className="redis-page__table-scroll"><table className="redis-page__table">
                      <thead><tr>{activeTab.value.columns.map((column) => <th key={column} scope="col">{column}</th>)}</tr></thead>
                      <tbody>{activeTab.value.rows.length === 0 ? <tr><td colSpan={activeTab.value.columns.length}>本批次没有数据。</td></tr> : activeTab.value.rows.map((row) => <tr key={row.id}>{row.cells.map((value, index) => <td key={index}><Cell value={value} /></td>)}</tr>)}</tbody>
                    </table></div> : null}
                    {activeTab.value?.nextCursor != null ? <button type="button" className="mysql-page__btn redis-page__load" disabled={activeTab.valueLoading} onClick={() => void loadValue(activeTab, activeTab.selected!, true)}>{activeTab.valueLoading ? '读取中…' : '加载更多数据'}</button> : null}
                  </>}
                </section>
              </div>
            </div>}
          </>}
        </section>
      </div>
    </div>
    <ConfirmDialog open={pendingDelete !== null} title="移除保存的 Redis 连接？" description="仅移除连接配置，不会删除 Redis 中的数据。" confirmLabel="移除连接" danger busy={removing}
      items={pendingDelete ? [{ icon: <RedisIcon />, label: '连接', value: pendingDelete.name || pendingDelete.host }] : []}
      onConfirm={() => void removeConnection()} onCancel={() => setPendingDelete(null)} />
  </div>
}
