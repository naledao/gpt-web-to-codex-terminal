import { useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { AppTheme, MysqlConnection } from '../../../shared/types'

interface MysqlDialogProps {
  open: boolean
  theme: AppTheme
  onClose: () => void
}

/**
 * The MySQL connection page, opened from the toolbox.
 *
 * Full-screen rather than a small card, because it is the first thing a connection
 * flow needs and the fields (plus whatever a later "browse tables / run SQL" step
 * adds) do not belong in a 440px box. Same reasoning as the Git dialog next to it.
 *
 * One connection PER MACHINE, for the same reason the notes are machine-scoped: a
 * connection describes one database on one machine, and carrying it to another host
 * would be worse than having none. The machine is whichever the terminal is driving
 * right now, so this page only ever edits that one and says which it is.
 *
 * Saving is the whole feature for now. Connecting, browsing tables and running SQL
 * come later; nothing here pretends to have tested the connection.
 */
export default function MysqlDialog({ open, theme, onClose }: MysqlDialogProps): ReactElement | null {
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [reveal, setReveal] = useState(false)
  const [error, setError] = useState('')
  const [label, setLabel] = useState('')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('3306')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [database, setDatabase] = useState('')

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError('')
    setSaved(false)
    setReveal(false)
    void window.api
      .getMysqlConnection()
      .then((connection: MysqlConnection) => {
        if (cancelled) return
        setLabel(connection.label)
        setHost(connection.host)
        setPort(String(connection.port || 3306))
        setUsername(connection.username)
        setPassword(connection.password)
        setDatabase(connection.database)
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

  // Escape closes the page, like every other dialog on the platform.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  const save = useCallback(async (): Promise<void> => {
    if (saving) return
    setSaving(true)
    setError('')
    const rawPort = Number(port)
    try {
      const next = await window.api.setMysqlConnection({
        scope: 'local',
        hostId: '',
        label,
        host: host.trim(),
        port: Number.isFinite(rawPort) && rawPort > 0 ? rawPort : 3306,
        username: username.trim(),
        password,
        database: database.trim()
      })
      setLabel(next.label)
      setHost(next.host)
      setPort(String(next.port || 3306))
      setUsername(next.username)
      setPassword(next.password)
      setDatabase(next.database)
      setSaved(true)
    } catch {
      setError('保存失败，请重试。')
    } finally {
      setSaving(false)
    }
  }, [database, host, label, password, port, saving, username])

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
          <span className="mysql-page__mark" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <ellipse cx="12" cy="5.6" rx="7.2" ry="2.8" />
              <path d="M4.8 5.6v12.8c0 1.55 3.22 2.8 7.2 2.8s7.2-1.25 7.2-2.8V5.6" />
              <path d="M4.8 12c0 1.55 3.22 2.8 7.2 2.8s7.2-1.25 7.2-2.8" />
            </svg>
          </span>
          <div className="mysql-page__titles">
            <h2 className="mysql-page__title">MySQL 连接</h2>
            <span className="mysql-page__scope" title={label}>
              只对当前机器生效{label ? ` · ${label}` : ''}
            </span>
          </div>
          <span className="panel__spacer" />
          <span className={saved ? 'mysql-page__badge mysql-page__badge--ok' : 'mysql-page__badge'}>
            <i />{saved ? '已保存' : '未保存'}
          </span>
          <button type="button" className="mysql-page__close" aria-label="关闭" onClick={onClose}>
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </header>

        <div className="mysql-page__body">
          <div className="mysql-page__card">
            <div className="mysql-page__card-head">
              <span className="mysql-page__card-title">连接信息</span>
              <span className="mysql-page__card-note">保存后即可在后续版本中连接使用</span>
            </div>

            {loading ? (
              <p className="mysql-page__hint">正在读取已保存的连接…</p>
            ) : (
              <div className="mysql-page__grid">
                <label className="mysql-page__field mysql-page__field--host">
                  <span className="mysql-page__label">主机 / IP</span>
                  <input
                    className="mysql-page__input"
                    value={host}
                    spellCheck={false}
                    placeholder="127.0.0.1"
                    onChange={(event) => { setHost(event.target.value); setSaved(false) }}
                  />
                </label>

                <label className="mysql-page__field mysql-page__field--port">
                  <span className="mysql-page__label">端口</span>
                  <input
                    className="mysql-page__input"
                    type="number"
                    min={1}
                    max={65535}
                    value={port}
                    onChange={(event) => { setPort(event.target.value); setSaved(false) }}
                  />
                </label>

                <label className="mysql-page__field">
                  <span className="mysql-page__label">用户名</span>
                  <input
                    className="mysql-page__input"
                    value={username}
                    spellCheck={false}
                    placeholder="root"
                    onChange={(event) => { setUsername(event.target.value); setSaved(false) }}
                  />
                </label>

                <label className="mysql-page__field">
                  <span className="mysql-page__label">密码</span>
                  <span className="mysql-page__password">
                    <input
                      className="mysql-page__input"
                      type={reveal ? 'text' : 'password'}
                      value={password}
                      spellCheck={false}
                      autoComplete="off"
                      placeholder="留空则保留已保存的密码"
                      onChange={(event) => { setPassword(event.target.value); setSaved(false) }}
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
                  <span className="mysql-page__label">默认数据库</span>
                  <input
                    className="mysql-page__input"
                    value={database}
                    spellCheck={false}
                    placeholder="可留空"
                    onChange={(event) => { setDatabase(event.target.value); setSaved(false) }}
                  />
                </label>

                <p className="mysql-page__hint mysql-page__hint--note mysql-page__field--wide">
                  密码会用系统加密后保存在本机数据库，不会明文写入。
                </p>
                {error ? <p className="mysql-page__hint mysql-page__hint--error mysql-page__field--wide" role="alert">{error}</p> : null}
              </div>
            )}
          </div>
        </div>

        <footer className="mysql-page__foot">
          <span className="mysql-page__foot-hint">MySQL 连接按机器分别保存，切换机器后各自独立。</span>
          <span className="panel__spacer" />
          <button type="button" className="mysql-page__btn" onClick={onClose}>关闭</button>
          <button
            type="button"
            className="mysql-page__btn mysql-page__btn--primary"
            disabled={loading || saving}
            onClick={() => void save()}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </footer>
      </div>
    </div>
  )
}