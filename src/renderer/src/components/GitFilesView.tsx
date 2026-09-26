import { useCallback, useEffect, useMemo, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import { DiffModeEnum, DiffView } from '@git-diff-view/react'
import '@git-diff-view/react/styles/diff-view.css'
import type { GitFileChange, GitFileDiff } from '../../../shared/types'

interface GitFilesViewProps {
  /** Active app theme, so the diff viewer matches the rest of the panel. */
  theme: 'light' | 'dark'
  cwd: string
  files: GitFileChange[]
}

type Filter = 'all' | 'modified' | 'added' | 'deleted' | 'renamed'

/** Narrow enough to still read file names, wide enough to keep the diff usable. */
const PANE_MIN_WIDTH = 260
const PANE_MAX_WIDTH = 620
const STORAGE_PANE_WIDTH = 'gitfiles.paneWidth'

interface FolderNode {
  name: string
  path: string
  folders: FolderNode[]
  files: GitFileChange[]
}

interface Totals {
  count: number
  additions: number
  deletions: number
}

function badgeFor(file: GitFileChange): { letter: string; tone: string } {
  if (file.kind === 'added' || file.kind === 'untracked') return { letter: 'A', tone: 'add' }
  if (file.kind === 'deleted') return { letter: 'D', tone: 'del' }
  if (file.kind === 'renamed') return { letter: 'R', tone: 'ren' }
  return { letter: 'M', tone: 'mod' }
}

/** Label for the little type tile in front of a file name. */
function extLabel(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  if (name.startsWith('.')) return 'ML'
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return 'ML'
  const ext = name.slice(dot + 1).toLowerCase()
  if (ext === 'json') return '{}'
  if (ext === 'md') return 'ML'
  return ext.toUpperCase().slice(0, 3)
}

function extTone(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  if (name.startsWith('.')) return 'git'
  const dot = name.lastIndexOf('.')
  const ext = dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
  if (ext === 'ts') return 'ts'
  if (ext === 'tsx') return 'tsx'
  if (ext === 'json') return 'json'
  if (ext === 'css') return 'css'
  if (ext === 'md') return 'doc'
  return 'doc'
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** Fold the flat, path-sorted list into a nested folder tree. */
function buildTree(files: GitFileChange[]): FolderNode {
  const root: FolderNode = { name: '', path: '', folders: [], files: [] }
  for (const file of files) {
    const segments = file.path.split('/')
    let node = root
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i]
      let child = node.folders.find((folder) => folder.name === segment)
      if (!child) {
        child = {
          name: segment,
          path: segments.slice(0, i + 1).join('/'),
          folders: [],
          files: []
        }
        node.folders.push(child)
      }
      node = child
    }
    node.files.push(file)
  }
  return root
}

/** Roll a folder\'s own files and every descendant into one set of figures. */
function rollUp(node: FolderNode): Totals {
  let count = node.files.length
  let additions = 0
  let deletions = 0
  for (const file of node.files) {
    additions += file.additions
    deletions += file.deletions
  }
  for (const child of node.folders) {
    const sub = rollUp(child)
    count += sub.count
    additions += sub.additions
    deletions += sub.deletions
  }
  return { count, additions, deletions }
}

/** Zero counts read as a plain grey 0 rather than a signed value. */
function Delta({ additions, deletions }: { additions: number; deletions: number }): ReactElement {
  return (
    <span className="gitfiles__delta">
      {additions > 0 ? <em className="gitfiles__plus">+{additions}</em> : <em className="gitfiles__zero">0</em>}
      {deletions > 0 ? <em className="gitfiles__minus">-{deletions}</em> : <em className="gitfiles__zero">0</em>}
    </span>
  )
}

interface ViewerProps {
  diff: GitFileDiff
  theme: 'light' | 'dark'
}

/** Unified/split toggle lives in the header, so the mode is owned by the parent. */
type DiffMode = 'unified' | 'split'

function DiffViewer({ diff, theme, mode }: ViewerProps & { mode: DiffMode }): ReactElement {
  if (diff.binary) {
    return <p className="gitdiff__empty">二进制文件，无法显示文本差异。</p>
  }
  if (diff.rawHunks.length === 0) {
    return <p className="gitdiff__empty">没有可显示的差异。</p>
  }

  const fileName = diff.path.slice(diff.path.lastIndexOf('/') + 1)
  return (
    <div className="gitdiff__viewer">
      <DiffView
        data={{
          oldFile: diff.oldContent
            ? { fileName, fileLang: diff.lang, content: diff.oldContent }
            : undefined,
          newFile: diff.newContent
            ? { fileName, fileLang: diff.lang, content: diff.newContent }
            : undefined,
          hunks: diff.rawHunks
        }}
        diffViewMode={mode === 'split' ? DiffModeEnum.Split : DiffModeEnum.Unified}
        diffViewTheme={theme}
        diffViewHighlight
        diffViewWrap={false}
        diffViewFontSize={12}
      />
    </div>
  )
}

export default function GitFilesView({ cwd, files, theme }: GitFilesViewProps): ReactElement {
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState('')
  const [diff, setDiff] = useState<GitFileDiff | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [copied, setCopied] = useState(false)
  const [mode, setMode] = useState<DiffMode>('unified')

  // The split is remembered across openings, like the workspace sidebars.
  const [paneWidth, setPaneWidth] = useState(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_PANE_WIDTH)
      const value = raw === null ? NaN : Number(raw)
      return Number.isFinite(value) ? value : 360
    } catch {
      return 360
    }
  })

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_PANE_WIDTH, String(paneWidth))
    } catch {
      /* storage unavailable; the width just will not persist */
    }
  }, [paneWidth])

  const counts = useMemo(() => {
    const tally = { all: files.length, modified: 0, added: 0, deleted: 0, renamed: 0 }
    for (const file of files) {
      if (file.kind === 'added' || file.kind === 'untracked') tally.added += 1
      else if (file.kind === 'deleted') tally.deleted += 1
      else if (file.kind === 'renamed') tally.renamed += 1
      else tally.modified += 1
    }
    return tally
  }, [files])

  const grand = useMemo(() => {
    let additions = 0
    let deletions = 0
    for (const file of files) {
      additions += file.additions
      deletions += file.deletions
    }
    return { additions, deletions }
  }, [files])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return files.filter((file) => {
      if (needle && !file.path.toLowerCase().includes(needle)) return false
      if (filter === 'all') return true
      if (filter === 'modified') return file.kind === 'modified'
      if (filter === 'added') return file.kind === 'added' || file.kind === 'untracked'
      if (filter === 'deleted') return file.kind === 'deleted'
      return file.kind === 'renamed'
    })
  }, [files, filter, query])

  const tree = useMemo(() => buildTree(visible), [visible])

  // Keep the right pane populated: fall back to the first visible file.
  useEffect(() => {
    if (selected && visible.some((file) => file.path === selected)) return
    setSelected(visible.length > 0 ? visible[0].path : '')
  }, [visible, selected])

  useEffect(() => {
    if (!selected) {
      setDiff(null)
      return
    }
    let cancelled = false
    setDiffLoading(true)
    void window.api
      .getGitDiff(cwd, selected)
      .then((result) => {
        if (!cancelled) setDiff(result)
      })
      .catch(() => {
        if (!cancelled) setDiff(null)
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [cwd, selected])

  const toggle = (path: string): void => {
    setCollapsed((previous) => {
      const next = new Set(previous)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  /** Drag the divider to trade width between the file list and the diff. */
  const startPaneResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      event.preventDefault()
      const startX = event.clientX
      const startWidth = paneWidth

      const onMove = (moveEvent: PointerEvent): void => {
        const next = startWidth + (moveEvent.clientX - startX)
        const max = Math.min(PANE_MAX_WIDTH, window.innerWidth - 420)
        setPaneWidth(Math.min(Math.max(next, PANE_MIN_WIDTH), Math.max(max, PANE_MIN_WIDTH)))
      }
      const onUp = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
      }

      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [paneWidth]
  )

  const copyPath = (): void => {
    if (!selected) return
    void navigator.clipboard.writeText(selected).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    })
  }

  const guides = (depth: number): ReactElement[] =>
    Array.from({ length: depth }, (_, index) => <span className="gitfiles__guide" key={index} />)

  const renderFile = (file: GitFileChange, depth: number): ReactElement => {
    const badge = badgeFor(file)
    return (
      <button
        key={file.path}
        type="button"
        className={selected === file.path ? 'gitfiles__row gitfiles__row--file gitfiles__row--on' : 'gitfiles__row gitfiles__row--file'}
        title={file.path}
        onClick={() => setSelected(file.path)}
      >
        {guides(depth)}
        <span className={'gitfiles__ext gitfiles__ext--' + extTone(file.path)}>{extLabel(file.path)}</span>
        <span className="gitfiles__name">{fileName(file.path)}</span>
        <em className={'gitfiles__badge gitfiles__badge--' + badge.tone}>{badge.letter}</em>
        <Delta additions={file.additions} deletions={file.deletions} />
      </button>
    )
  }

  const renderFolder = (node: FolderNode, depth: number): ReactElement[] => {
    const totals = rollUp(node)
    const isCollapsed = collapsed.has(node.path)
    const rows: ReactElement[] = [
      <button
        key={node.path}
        type="button"
        className="gitfiles__row gitfiles__row--folder"
        onClick={() => toggle(node.path)}
      >
        {guides(depth)}
        <span className={isCollapsed ? 'gitfiles__caret' : 'gitfiles__caret gitfiles__caret--open'}>
          <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 4l4 4-4 4" />
          </svg>
        </span>
        <span className="gitfiles__folder-icon">
          <svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor">
            <path d="M1.6 3.2h4.1l1.5 1.8h7.2v7.8H1.6z" />
          </svg>
        </span>
        <span className="gitfiles__name">{node.name}</span>
        <em className="gitfiles__folder-count">{totals.count}</em>
        <Delta additions={totals.additions} deletions={totals.deletions} />
      </button>
    ]
    if (!isCollapsed) {
      for (const child of node.folders) rows.push(...renderFolder(child, depth + 1))
      for (const file of node.files) rows.push(renderFile(file, depth + 1))
    }
    return rows
  }

  const rows: ReactElement[] = []
  for (const child of tree.folders) rows.push(...renderFolder(child, 0))
  for (const file of tree.files) rows.push(renderFile(file, 0))

  return (
    <div className="gitfiles" style={{ gridTemplateColumns: paneWidth + 'px minmax(0, 1fr)' }}>
      <div className="gitfiles__pane">
        <div className="gitfiles__head">
          <span className="gitfiles__title">本地未提交的改动</span>
          <span className="gitfiles__count">{counts.all}</span>
          <Delta additions={grand.additions} deletions={grand.deletions} />
        </div>

        <div className="gitfiles__filters">
          {([
            ['all', '全部', counts.all],
            ['modified', '已修改', counts.modified],
            ['added', '新增', counts.added],
            ['deleted', '已删除', counts.deleted],
            ['renamed', '重命名', counts.renamed]
          ] as [Filter, string, number][]).map(([value, label, total]) => (
            <button
              key={value}
              type="button"
              className={filter === value ? 'gitfiles__chip gitfiles__chip--on' : 'gitfiles__chip'}
              onClick={() => setFilter(value)}
            >
              {label}
              <em>{total}</em>
            </button>
          ))}
        </div>

        <div className="gitfiles__search">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <circle cx="7" cy="7" r="4.4" />
            <path d="M10.4 10.4 13.6 13.6" />
          </svg>
          <input
            type="text"
            value={query}
            placeholder="搜索文件…"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        <div className="gitfiles__tree">
          {rows.length === 0 ? <p className="gitfiles__none">没有匹配的文件。</p> : rows}
        </div>
        <div
          className="gitfiles__resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整文件列表宽度"
          onPointerDown={startPaneResize}
        />
      </div>

      <div className="gitdiff">
        {selected ? (
          <>
            <div className="gitdiff__head">
              <span className={'gitfiles__ext gitfiles__ext--' + extTone(selected)}>{extLabel(selected)}</span>
              <span className="gitdiff__path" title={selected}>{selected}</span>
              <button type="button" className="gitdiff__copy" onClick={copyPath} title={copied ? '已复制' : '复制路径'}>
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
                  <rect x="5.4" y="5.4" width="8.2" height="8.2" rx="1.6" />
                  <path d="M10.6 5.4V3.8a1.4 1.4 0 0 0-1.4-1.4H3.8a1.4 1.4 0 0 0-1.4 1.4v5.4a1.4 1.4 0 0 0 1.4 1.4h1.6" />
                </svg>
              </button>
              <div className="gitdiff__modes">
                <button
                  type="button"
                  className={mode === "unified" ? "gitdiff__mode gitdiff__mode--on" : "gitdiff__mode"}
                  onClick={() => setMode("unified")}
                >
                  统一视图
                </button>
                <button
                  type="button"
                  className={mode === "split" ? "gitdiff__mode gitdiff__mode--on" : "gitdiff__mode"}
                  onClick={() => setMode("split")}
                >
                  分离视图
                </button>
              </div>
              <span className="gitdiff__totals">
                <em className="gitfiles__plus">+{diff ? diff.additions : 0}</em>
                <em className="gitfiles__minus">-{diff ? diff.deletions : 0}</em>
              </span>
            </div>
            <div className="gitdiff__body">
              {diffLoading ? (
                <p className="gitdiff__empty">正在读取差异…</p>
              ) : diff ? (
                <DiffViewer diff={diff} theme={theme} mode={mode} />
              ) : (
                <p className="gitdiff__empty">无法读取该文件的差异。</p>
              )}
            </div>
          </>
        ) : (
          <p className="gitdiff__empty">左侧选择一个文件，这里显示它的差异。</p>
        )}
      </div>
    </div>
  )
}
