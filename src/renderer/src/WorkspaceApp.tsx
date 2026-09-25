import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import type { ManagedSessionSummary, SshTransferTask, UpdateStatus, WorkspaceState } from '../../shared/types'
import brandIcon from './assets/brand-icon.png'
import { platformById } from '../../shared/platforms'
import App from './App'
import ConfirmDialog from './components/ConfirmDialog'

const INITIAL_WORKSPACE: WorkspaceState = {
  view: 'manager',
  sessionId: null,
  openSshDialog: false
}

function formatBytes(bytes: number): string {
  const value = Math.max(0, bytes)
  if (value < 1024) return `${value} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let size = value
  let index = -1
  do {
    size /= 1024
    index += 1
  } while (size >= 1024 && index < units.length - 1)
  return `${size >= 10 ? size.toFixed(1) : size.toFixed(2)} ${units[index]}`
}

function transferStatus(item: SshTransferTask, percent: number): string {
  if (item.status === 'completed') return '已完成'
  if (item.status === 'cancelled') return '已取消'
  if (item.status === 'failed') return '失败'
  return item.total > 0 ? `${percent}%` : '准备中…'
}

function formatTransferDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  const rounded = Math.ceil(seconds)
  if (rounded < 60) return `${rounded} 秒`
  const minutes = Math.floor(rounded / 60)
  const rest = rounded % 60
  return rest > 0 ? `${minutes} 分 ${rest} 秒` : `${minutes} 分`
}


export default function WorkspaceApp(): ReactElement {
  const [workspace, setWorkspace] = useState<WorkspaceState>(INITIAL_WORKSPACE)
  const [sessions, setSessions] = useState<ManagedSessionSummary[]>([])
  const [transfers, setTransfers] = useState<SshTransferTask[]>([])
  const [transfersOpen, setTransfersOpen] = useState(false)
  const [newSessionOpen, setNewSessionOpen] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<ManagedSessionSummary | null>(null)
  const [appVersion, setAppVersion] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [renameSaving, setRenameSaving] = useState(false)
  const [updateNotice, setUpdateNotice] = useState<{ version: string } | null>(null)
  const [updateDownloading, setUpdateDownloading] = useState(false)
  const noticedVersion = useRef('')
  const [navWidth, setNavWidth] = useState(() => {
    try {
      const raw = window.localStorage.getItem('layout.navWidth')
      const value = raw === null ? NaN : Number(raw)
      return Number.isFinite(value) ? value : 228
    } catch {
      return 228
    }
  })

  useEffect(() => {
    try {
      window.localStorage.setItem('layout.navWidth', String(navWidth))
    } catch {
      /* storage unavailable; the width just will not persist */
    }
  }, [navWidth])

  const [navCollapsed, setNavCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem('layout.navCollapsed') === '1'
    } catch {
      return false
    }
  })

  useEffect(() => {
    try {
      window.localStorage.setItem('layout.navCollapsed', navCollapsed ? '1' : '0')
    } catch {
      /* storage unavailable; the state just will not persist */
    }
  }, [navCollapsed])

  /** Drag the sidebar's right edge to resize it. */
  const startNavResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      event.preventDefault()
      const startX = event.clientX
      const startWidth = navWidth
      const onMove = (moveEvent: PointerEvent): void => {
        const next = startWidth + (moveEvent.clientX - startX)
        const max = Math.max(200, Math.min(420, window.innerWidth - 520))
        setNavWidth(Math.min(Math.max(next, 176), max))
      }
      const onUp = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [navWidth]
  )

  useEffect(() => {
    void window.api.getWorkspaceState().then(setWorkspace)
    void window.api.listManagedSessions().then(setSessions)
    void window.api.getSshTransfers().then(setTransfers)
    void window.api.getAppInfo().then((info) => setAppVersion(info.version))
    const offWorkspace = window.api.onWorkspaceChanged(setWorkspace)
    const offSessions = window.api.onManagedSessionsChanged(setSessions)
    const offTransfers = window.api.onSshTransfersChanged(setTransfers)
    return () => {
      offWorkspace()
      offSessions()
      offTransfers()
    }
  }, [])

  useEffect(() => {
    const notice = (status: UpdateStatus): void => {
      if (status.phase !== 'available' || !status.version) return
      if (noticedVersion.current === status.version) return
      noticedVersion.current = status.version
      setUpdateNotice({ version: status.version })
      /* Hide the native chat view at once: it paints above the DOM, so the
       * dialog would otherwise be covered the moment the session view shows. */
      window.api.setEmbedVisible(false)
    }
    void window.api.getUpdateStatus().then(notice)
    const off = window.api.onUpdateChanged(notice)
    return off
  }, [])

  const deleteSession = async (item: ManagedSessionSummary): Promise<void> => {
    if (deletingId !== null) return
    setDeletingId(item.id)
    try {
      await window.api.destroyManagedSession(item.id)
      setPendingDelete(null)
    } finally {
      setDeletingId(null)
    }
  }

  const cancelTransfer = async (item: SshTransferTask): Promise<void> => {
    try {
      await window.api.cancelSshTransfer(item.sessionId, item.direction, item.id)
    } catch {
      /* pushed global transfer state remains authoritative */
    }
  }

  const createManagedSession = async (kind: 'local' | 'ssh'): Promise<void> => {
    setNewSessionOpen(false)
    // For SSH the main process opens the connect dialog for us (createSession passes
    // openSshDialog = kind === 'ssh'), so there is nothing else to do here.
    await window.api.createManagedSession(kind)
  }

  const activeTransfers = transfers.filter(
    (item) => item.status === 'uploading' || item.status === 'downloading'
  )
  const activeTotal = activeTransfers.reduce((sum, item) => sum + item.total, 0)
  const activeTransferred = activeTransfers.reduce((sum, item) => sum + item.transferred, 0)
  const activePercent = activeTotal > 0
    ? Math.min(100, Math.round((activeTransferred / activeTotal) * 100))
    : 0

  const beginRename = (item: ManagedSessionSummary): void => {
    setRenamingId(item.id)
    setRenameDraft(item.title || '')
  }

  const cancelRename = (): void => {
    if (renameSaving) return
    setRenamingId(null)
    setRenameDraft('')
  }

  const saveRename = async (): Promise<void> => {
    if (renamingId === null || renameSaving) return
    setRenameSaving(true)
    try {
      await window.api.renameManagedSession(renamingId, renameDraft)
      setRenamingId(null)
      setRenameDraft('')
    } finally {
      setRenameSaving(false)
    }
  }

  const downloadUpdate = async (): Promise<void> => {
    if (updateDownloading) return
    setUpdateDownloading(true)
    try {
      await window.api.downloadUpdate()
    } finally {
      setUpdateDownloading(false)
    }
  }

  return (
    <div className={'workspace' + (navCollapsed ? ' workspace--nav-collapsed' : '')} style={{ '--nav-width': `${navWidth}px` } as CSSProperties}>
      <nav className="workspace__nav">
        <div className="workspace__brand">
          <span className="workspace__brand-mark" aria-hidden="true"><img src={brandIcon} alt="" /></span>
          <span className="workspace__brand-text">GPT → Codex</span>
          <button
            type="button"
            className="workspace__nav-collapse"
            title={navCollapsed ? '展开左侧栏' : '折叠左侧栏'}
            aria-label={navCollapsed ? '展开左侧栏' : '折叠左侧栏'}
            onClick={() => setNavCollapsed((value) => !value)}
          >
            {navCollapsed ? '»' : '«'}
          </button>
        </div>
        <div className="workspace__nav-label-row">
          <div className="workspace__nav-label">会话</div>
          <button
            type="button"
            className="workspace__new-session"
            title="新建会话"
            aria-label="新建会话"
            onClick={() => setNewSessionOpen(true)}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
          </button>
        </div>
        <div className="workspace__sessions">
          {sessions.map((item) => (
            <div className="workspace__session-row" key={item.id} onContextMenu={(event) => { event.preventDefault(); beginRename(item) }}>
              {renamingId === item.id ? (
                <div className="workspace__session-rename">
                  <input
                    autoFocus
                    value={renameDraft}
                    disabled={renameSaving}
                    onChange={(event) => setRenameDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void saveRename()
                      if (event.key === 'Escape') cancelRename()
                    }}
                    onBlur={() => void saveRename()}
                  />
                </div>
              ) : (
              <>
              <button
                type="button"
                className={workspace.sessionId === item.id ? 'workspace__session workspace__session--active' : 'workspace__session'}
                onClick={() => void window.api.openManagedSession(item.id)}
                title={item.title || item.target}
              >
                <span className="workspace__session-head">
                  <span className="workspace__session-title">{item.title || '会话'}</span>
                  <span className={`workspace__session-platform workspace__session-platform--${item.platformId}`}>{platformById(item.platformId)?.label ?? item.platformId}</span>
                </span>
                <span className="workspace__session-meta">
                  {item.taskRunning ? <span className="workspace__session-running"><svg viewBox="0 0 8 8" width="7" height="7" fill="currentColor"><circle cx="4" cy="4" r="3.2" /></svg> 执行中 · </span> : null}
                  {item.kind === 'ssh' ? 'SSH' : '本地'} · {item.target}
                </span>
              </button>
              <button
                type="button"
                className="workspace__session-delete"
                disabled={deletingId !== null}
                title={`删除 ${item.title || '会话'}`}
                aria-label={`删除 ${item.title || '会话'}`}
                onClick={() => setPendingDelete(item)}
              >
                {deletingId === item.id ? '…' : <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>}
              </button>
              </>
              )}
            </div>
          ))}
        </div>
        <div
          className="workspace__nav-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整侧栏宽度"
          onPointerDown={startNavResize}
        />
      </nav>

      <section className="workspace__content">
        {workspace.sessionId ? (
          <App
            key={workspace.sessionId}
            initialSshDialogOpen={workspace.openSshDialog}
            globalModalOpen={transfersOpen || pendingDelete !== null || newSessionOpen || updateNotice !== null}
            /*
             * Read from the session list rather than held as its own state: the main process
             * republishes the list whenever a session changes, including on a platform switch,
             * so this stays right without a second copy to keep in sync.
             */
            platformId={
              sessions.find((item) => item.id === workspace.sessionId)?.platformId ?? ''
            }
          />
        ) : null}
      </section>

      <footer className="workspace__transferbar">
        <button
          type="button"
          className="workspace__transfer-button"
          onClick={() => setTransfersOpen(true)}
          title="查看所有会话的上传和下载任务"
        >
          <span className={activeTransfers.length > 0 ? 'dot dot--busy' : 'dot'} />
          <span className="workspace__transfer-title">传输任务</span>
          <span className="workspace__transfer-summary">
            {activeTransfers.length > 0
              ? `${activeTransfers.length} 个进行中${activeTotal > 0 ? ` · ${activePercent}%` : ''}`
              : transfers.length > 0
                ? `${transfers.length} 个任务`
                : '暂无任务'}
          </span>
        </button>
        {appVersion ? <span className="workspace__version" title="应用版本号">v{appVersion}</span> : null}
      </footer>

      {transfersOpen ? (
        <div
          className="modal transfer-modal"
          role="dialog"
          aria-modal="true"
          aria-label="传输任务"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setTransfersOpen(false)
          }}
        >
          <div className="transfer-modal__box">
            <div className="transfer-modal__head">
              <div className="transfer-modal__title">传输任务</div>
              {activeTransfers.length > 0 ? (
                <span className="transfer-modal__active-count">{activeTransfers.length} 个进行中</span>
              ) : null}
              <span className="panel__spacer" />
              <button type="button" className="transfer-modal__close" aria-label="关闭" onClick={() => setTransfersOpen(false)}>×</button>
            </div>

            <div className="transfer-modal__body">
              {transfers.length === 0 ? (
                <div className="transfer-modal__empty">
                  <div className="transfer-modal__empty-icon">⇅</div>
                  <strong>暂无传输任务</strong>
                  <span>上传和下载任务会显示在这里</span>
                </div>
              ) : (
                <div className="transfer-list">
                  {transfers.map((item) => {
                    const percent = item.total > 0 ? Math.min(100, Math.round((item.transferred / item.total) * 100)) : 0
                    const active = item.status === 'uploading' || item.status === 'downloading'
                    const session = sessions.find((candidate) => candidate.id === item.sessionId)
                    const sessionLabel = session?.title || session?.target || item.sessionId.slice(0, 8)
                    const elapsedSeconds = Math.max(0, (Date.now() - item.startedAt) / 1000)
                    const speed = elapsedSeconds > 0 ? item.transferred / elapsedSeconds : 0
                    const remainingSeconds = active && item.total > item.transferred && speed > 0 ? (item.total - item.transferred) / speed : 0
                    const statusLabel = active ? (item.direction === 'upload' ? '正在上传' : '正在下载') : transferStatus(item, percent)
                    return (
                      <div className={`transfer-card transfer-card--${item.status}`} key={`${item.sessionId}:${item.direction}:${item.id}`} title={item.error || (item.direction === 'upload' ? item.remotePath : item.localPath)}>
                        <div className={`transfer-card__icon transfer-card__icon--${item.direction}`}>{item.direction === 'upload' ? '↑' : '↓'}</div>
                        <div className="transfer-card__content">
                          <div className="transfer-card__top">
                            <span className={`transfer-card__direction transfer-card__direction--${item.direction}`}>{item.direction === 'upload' ? '上传' : '下载'}</span>
                            <span className="transfer-card__name">{item.name}</span>
                            {item.total > 0 ? <strong className="transfer-card__percent">{percent}%</strong> : null}
                            {active ? <button type="button" className="transfer-card__cancel" onClick={() => void cancelTransfer(item)}>取消</button> : null}
                          </div>
                          <div className="transfer-card__session">{sessionLabel}</div>
                          <div className="transfer-card__progress" aria-label={`${item.name} ${statusLabel} ${percent}%`}>
                            <span style={{ width: `${item.total > 0 ? percent : active ? 12 : 100}%` }} />
                          </div>
                          <div className="transfer-card__meta">
                            <span>{item.direction === 'upload' ? '已上传' : '已下载'} {formatBytes(item.transferred)}{item.total > 0 ? ` / ${formatBytes(item.total)}` : ''}</span>
                            {active && speed > 0 ? <><i /><span>{formatBytes(speed)}/s</span></> : null}
                            {active && remainingSeconds > 0 ? <><i /><span>预计还需 {formatTransferDuration(remainingSeconds)}</span></> : null}
                            <span className={`transfer-card__status transfer-card__status--${item.status}`}><b />{statusLabel}</span>
                          </div>
                          {item.error ? <div className="transfer-card__error">{item.error}</div> : null}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {newSessionOpen ? (
        <div
          className="modal new-session-modal"
          role="dialog"
          aria-modal="true"
          aria-label="新建会话"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setNewSessionOpen(false)
          }}
        >
          <div className="new-session-modal__box">
            <div className="new-session-modal__header">
              <div>
                <h2>新建会话</h2>
                <p>选择一种工作环境开始任务</p>
              </div>
              <button type="button" className="new-session-modal__close" aria-label="关闭" onClick={() => setNewSessionOpen(false)}>×</button>
            </div>

            <div className="new-session-modal__options">
              <button type="button" className="new-session-modal__option" onClick={() => void createManagedSession('local')}>
                <span className="new-session-modal__icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="4" width="14" height="11" rx="1.5"/><path d="M3.5 18h17M8 18h8"/></svg>
                </span>
                <span className="new-session-modal__content">
                  <span className="new-session-modal__title-row"><strong>本地会话</strong></span>
                  <small>使用当前电脑创建新的工作环境</small>
                </span>
                <span className="new-session-modal__arrow" aria-hidden="true">›</span>
              </button>

              <button type="button" className="new-session-modal__option new-session-modal__option--ssh" onClick={() => void createManagedSession('ssh')}>
                <span className="new-session-modal__icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="4" width="14" height="6" rx="1.5"/><rect x="5" y="14" width="14" height="6" rx="1.5"/><path d="M9 7h.01M9 17h.01M12 7h3M12 17h3"/></svg>
                </span>
                <span className="new-session-modal__content">
                  <span className="new-session-modal__title-row"><strong>SSH 会话</strong><em className="new-session-modal__badge">远程</em></span>
                  <small>连接远程机器并创建 SSH 工作环境</small>
                </span>
                <span className="new-session-modal__arrow" aria-hidden="true">›</span>
              </button>
            </div>

            <div className="new-session-modal__footer">
              <span className="new-session-modal__info" aria-hidden="true">i</span>
              <span>创建后仍可在会话设置中修改连接方式</span>
            </div>
          </div>
        </div>
      ) : null}
      <ConfirmDialog
        open={updateNotice !== null}
        title={`发现新版本 v${updateNotice?.version ?? ''}`}
        description="新版本已可下载。下载完成后重启即可安装，不会打断当前任务。"
        icon="⬆"
        confirmLabel="下载更新"
        cancelLabel="稍后"
        busy={updateDownloading}
        dismissOnBackdrop={false}
        dismissOnEscape={false}
        onConfirm={() => void downloadUpdate()}
        onCancel={() => setUpdateNotice(null)}
      />
      <ConfirmDialog
        open={pendingDelete !== null}
        title={`删除“${pendingDelete?.title || '会话'}”？`}
        description="此操作会立即结束该会话的运行环境，请确认是否继续。"
        icon="!"
        danger
        busy={deletingId !== null}
        confirmLabel="确认删除"
        items={[
          { icon: '▣', label: '终端进程和 SSH 连接', value: '立即结束', tone: 'danger' },
          { icon: '◉', label: 'ChatGPT 对话历史', value: '保留', tone: 'success' }
        ]}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => { if (pendingDelete) void deleteSession(pendingDelete) }}
      />    </div>
  )
}
