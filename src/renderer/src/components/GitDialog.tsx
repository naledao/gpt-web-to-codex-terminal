import { useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import type { AppTheme, GitLogEntry, GitLogResult } from '../../../shared/types'
import GitFilesView from './GitFilesView'

interface GitDialogProps {
  open: boolean
  /** Repository directory to inspect; usually the terminal working directory. */
  cwd: string
  theme: AppTheme
  onClose: () => void
}

type GitView = 'log' | 'files'

const EMPTY: GitLogResult = {
  isRepo: false,
  currentBranch: '',
  entries: [],
  indexStatus: { modified: 0, added: 0, deleted: 0 },
  files: []
}

/** Width of one graph column; a commit sits at the centre of its own column. */
const LANE_WIDTH = 18

/** "2 小时前" style label, computed locally so the panel needs no date library. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ''
  const minutes = Math.floor((Date.now() - then) / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return minutes + ' 分钟前'
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return hours + ' 小时前'
  const days = Math.floor(hours / 24)
  if (days < 30) return days + ' 天前'
  const d = new Date(then)
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}

interface GraphRow {
  entry: GitLogEntry
  lane: number
  active: number[]
}

/**
 * Assigns every commit a column and records which columns are still live at that
 * row. Walking newest-first, the first parent inherits the lane while extra
 * parents (merges) open new ones — enough to draw the graph as plain DOM.
 */
function computeRows(entries: GitLogEntry[]): GraphRow[] {
  const pending = new Map<string, number>()
  const live = new Set<number>()
  const rows: GraphRow[] = []
  let nextLane = 0

  for (const entry of entries) {
    let lane = pending.get(entry.hash)
    if (lane === undefined) lane = nextLane++
    pending.delete(entry.hash)
    live.add(lane)
    rows.push({ entry, lane, active: [...live].sort((a, b) => a - b) })

    if (entry.parents.length > 0) pending.set(entry.parents[0], lane)
    for (let i = 1; i < entry.parents.length; i++) {
      if (!pending.has(entry.parents[i])) pending.set(entry.parents[i], nextLane++)
    }
    if (![...pending.values()].includes(lane)) live.delete(lane)
  }
  return rows
}

/** Stable pastel per author, so the same person keeps the same colour. */
function avatarHue(seed: string): number {
  let hash = 0
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) % 360
  return hash
}

/** A glyph per conventional-commit prefix, matching the shape of the change. */
function CommitIcon({ message }: { message: string }): ReactElement {
  const head = message.slice(0, 5).toLowerCase()
  if (head.startsWith('fix') || head.startsWith('merg')) {
    return (
      <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
        <circle cx="4.2" cy="3.6" r="1.7" />
        <circle cx="4.2" cy="12.4" r="1.7" />
        <circle cx="11.8" cy="8" r="1.7" />
        <path d="M4.2 5.3v5.4M5.9 8h4.2" />
      </svg>
    )
  }
  if (head.startsWith('chor') || head.startsWith('buil') || head.startsWith('ci')) {
    return (
      <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
        <path d="M8 1.7 13.9 5v6L8 14.3 2.1 11V5z" />
        <path d="M2.1 5 8 8.4 13.9 5M8 8.4v5.9" />
      </svg>
    )
  }
  if (head.startsWith('feat')) {
    return (
      <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <path d="M8 2.4v11.2M2.4 8h11.2" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
      <path d="M4.2 1.9h4.6l3.2 3.2v9H4.2z" />
      <path d="M8.8 1.9V5.1h3.2M6.3 8.1h3.6M6.3 10.6h3.6" />
    </svg>
  )
}

export default function GitDialog({ open, cwd, theme, onClose }: GitDialogProps): ReactElement | null {
  const [log, setLog] = useState<GitLogResult>(EMPTY)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [view, setView] = useState<GitView>('log')

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setCopied(false)
    void window.api
      .getGitLog(cwd)
      .then((result) => {
        if (!cancelled) setLog(result)
      })
      .catch(() => {
        if (!cancelled) setLog({ ...EMPTY, error: '读取 Git 仓库失败' })
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, cwd])

  const rows = useMemo(() => computeRows(log.entries), [log.entries])
  const laneCount = useMemo(
    () => rows.reduce((widest, row) => Math.max(widest, row.lane + 1), 1),
    [rows]
  )

  if (!open) return null

  const index = log.indexStatus
  const dirty = index.modified + index.added + index.deleted
  const graphWidth = laneCount * LANE_WIDTH

  const copyPath = (): void => {
    void navigator.clipboard.writeText(cwd).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    })
  }

  return (
    <div
      className={theme === 'dark' ? 'confirm-dialog git-dialog git-dialog--dark' : 'confirm-dialog git-dialog'}
      role="dialog"
      aria-modal="true"
      aria-label="Git 管理"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="confirm-dialog__box git-dialog__box">
        <header className="git-dialog__head">
          <div className="git-dialog__mark">
            <svg width="26" height="26" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg">
              <rect x="18" y="18" width="84" height="84" rx="8" fill="#F05032" transform="rotate(45 60 60)" />
              <path d="M45 38 L76 69" stroke="#FFFFFF" strokeWidth="7" strokeLinecap="round" />
              <path d="M59 52 L59 78" stroke="#FFFFFF" strokeWidth="7" strokeLinecap="round" />
              <circle cx="45" cy="38" r="7" fill="#FFFFFF" />
              <circle cx="59" cy="52" r="7" fill="#FFFFFF" />
              <circle cx="59" cy="80" r="7" fill="#FFFFFF" />
              <circle cx="78" cy="71" r="7" fill="#FFFFFF" />
            </svg>
          </div>

          <div className="git-dialog__titles">
            <h2 className="git-dialog__title">Git 管理</h2>
            <button
              type="button"
              className={copied ? 'git-dialog__path git-dialog__path--copied' : 'git-dialog__path'}
              onClick={copyPath}
              title={copied ? '已复制' : '复制路径'}
            >
              <span className="git-dialog__path-text">{copied ? '已复制路径' : cwd || '未设置工作目录'}</span>
              <span className="git-dialog__copy" aria-hidden="true">
                <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
                  <rect x="5.4" y="5.4" width="8.2" height="8.2" rx="1.6" />
                  <path d="M10.6 5.4V3.8a1.4 1.4 0 0 0-1.4-1.4H3.8a1.4 1.4 0 0 0-1.4 1.4v5.4a1.4 1.4 0 0 0 1.4 1.4h1.6" />
                </svg>
              </span>
            </button>
          </div>

          <div className="git-dialog__tabs">
            <button
              type="button"
              className={view === 'log' ? 'git-dialog__tab git-dialog__tab--on' : 'git-dialog__tab'}
              onClick={() => setView('log')}
            >
              <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <circle cx="4.2" cy="3.6" r="1.7" />
                <circle cx="4.2" cy="12.4" r="1.7" />
                <circle cx="11.8" cy="8" r="1.7" />
                <path d="M4.2 5.3v5.4M5.9 8h4.2" />
              </svg>
              提交记录
            </button>
            <button
              type="button"
              className={view === 'files' ? 'git-dialog__tab git-dialog__tab--on' : 'git-dialog__tab'}
              onClick={() => setView('files')}
            >
              <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
                <path d="M4.4 1.9h4.4l3 3v9.2H4.4z" />
                <path d="M8.8 1.9v3h3" />
              </svg>
              文件改动
            </button>
          </div>

          <div className="git-dialog__meta">
            <span className="git-dialog__pill git-dialog__pill--branch">
              <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <circle cx="4.4" cy="3.8" r="1.6" />
                <circle cx="4.4" cy="12.2" r="1.6" />
                <circle cx="11.6" cy="6.4" r="1.6" />
                <path d="M4.4 5.4v5.2M6 6.4h3.4" />
              </svg>
              {log.currentBranch || 'HEAD'}
              <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 6.4 8 10.4l4-4" />
              </svg>
            </span>
            <span className={dirty > 0 ? 'git-dialog__pill git-dialog__pill--dirty' : 'git-dialog__pill'}>
              <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
                <path d="M8 1.8 14 4.9 8 8 2 4.9z" />
                <path d="M2 8.1 8 11.2l6-3.1M2 11.2 8 14.3l6-3.1" />
              </svg>
              {dirty > 0 ? dirty + ' 处改动' : '工作区干净'}
            </span>
          </div>

          <button type="button" className="git-dialog__close" aria-label="关闭" onClick={onClose}>
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </header>

        {loading ? <p className="git-dialog__hint">正在读取仓库…</p> : null}
        {!loading && !log.isRepo ? <p className="git-dialog__hint">当前目录不是 Git 仓库。</p> : null}

        {!loading && log.isRepo && view === 'log' ? (
          <div className="gitlog">
            <div className="gitlog__columns">
              <span>分支 / 标签</span>
              <span>提交图</span>
              <span>提交信息</span>
              <span>作者</span>
              <span>时间</span>
              <span />
            </div>

            <div className="gitlog__body">
              {dirty > 0 ? (
                <div className="gitlog__row gitlog__row--index">
                  <div className="gitlog__labels">
                    <span className="gitlog__label">
                      index
                      <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
                        <path d="M8 2.2 13.4 8 8 13.8 2.6 8z" />
                      </svg>
                    </span>
                  </div>
                  <div className="gitlog__graph" style={{ width: graphWidth }}>
                    <span className="gitlog__dashed" />
                    <span className="gitlog__node gitlog__node--index" style={{ left: LANE_WIDTH / 2 }} />
                    <span className="gitlog__dashed-down" style={{ left: LANE_WIDTH / 2 }} />
                  </div>
                  <div className="gitlog__message">
                    <span className="gitlog__icon">
                      <CommitIcon message="wip" />
                    </span>
                    <span className="gitlog__subject">// WIP</span>
                    <span className="gitlog__chip gitlog__chip--mod">{index.modified} 修改</span>
                    <span className="gitlog__chip gitlog__chip--add">{index.added} 新增</span>
                  </div>
                  <div className="gitlog__author">-</div>
                  <div className="gitlog__time">-</div>
                  <div className="gitlog__menu"><span className="gitlog__more">···</span></div>
                </div>
              ) : null}

              {rows.map((row, position) => {
                const name = row.entry.author?.name ?? ''
                const hue = avatarHue(name || row.entry.hash)
                return (
                  <div className="gitlog__row" key={row.entry.hash}>
                    <div className="gitlog__labels">
                      {position === 0 && log.currentBranch ? (
                        <span className="gitlog__label gitlog__label--branch">
                          <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                            <circle cx="4.4" cy="3.8" r="1.6" />
                            <circle cx="4.4" cy="12.2" r="1.6" />
                            <circle cx="11.6" cy="6.4" r="1.6" />
                            <path d="M4.4 5.4v5.2M6 6.4h3.4" />
                          </svg>
                          {log.currentBranch}
                        </span>
                      ) : null}
                    </div>
                    <div className="gitlog__graph" style={{ width: graphWidth }}>
                      {row.active.map((lane) => (
                        <span
                          key={lane}
                          className="gitlog__lane"
                          style={{ left: lane * LANE_WIDTH + LANE_WIDTH / 2 }}
                        />
                      ))}
                      <span className="gitlog__node" style={{ left: row.lane * LANE_WIDTH + LANE_WIDTH / 2 }} />
                    </div>
                    <div className="gitlog__message">
                      <span className="gitlog__icon">
                        <CommitIcon message={row.entry.message} />
                      </span>
                      <span className="gitlog__subject" title={row.entry.message}>
                        {row.entry.message}
                      </span>
                    </div>
                    <div className="gitlog__author">
                      <span
                        className="gitlog__avatar"
                        style={{
                          background: 'hsl(' + hue + ', 62%, 90%)',
                          color: 'hsl(' + hue + ', 52%, 34%)'
                        }}
                      >
                        {(name || '?').slice(0, 1).toUpperCase()}
                      </span>
                      <span className="gitlog__author-name" title={row.entry.author?.email}>
                        {name || '-'}
                      </span>
                    </div>
                    <div className="gitlog__time">{relativeTime(row.entry.committerDate)}</div>
                    <div className="gitlog__menu">
                      <button type="button" className="gitlog__more" aria-label="更多操作">···</button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ) : null}

        {!loading && log.isRepo && view === 'files' ? (
          <GitFilesView cwd={cwd} files={log.files} />
        ) : null}      </div>
    </div>
  )
}