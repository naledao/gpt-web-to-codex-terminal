import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { ManagedSessionSummary, SshTransferTask, WorkspaceState } from '../../shared/types'
import App from './App'
import ManagerApp from './ManagerApp'

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

export default function WorkspaceApp(): ReactElement {
  const [workspace, setWorkspace] = useState<WorkspaceState>(INITIAL_WORKSPACE)
  const [sessions, setSessions] = useState<ManagedSessionSummary[]>([])
  const [transfers, setTransfers] = useState<SshTransferTask[]>([])
  const [transfersOpen, setTransfersOpen] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  useEffect(() => {
    void window.api.getWorkspaceState().then(setWorkspace)
    void window.api.listManagedSessions().then(setSessions)
    void window.api.getSshTransfers().then(setTransfers)
    const offWorkspace = window.api.onWorkspaceChanged(setWorkspace)
    const offSessions = window.api.onManagedSessionsChanged(setSessions)
    const offTransfers = window.api.onSshTransfersChanged(setTransfers)
    return () => {
      offWorkspace()
      offSessions()
      offTransfers()
    }
  }, [])

  const deleteSession = async (item: ManagedSessionSummary): Promise<void> => {
    if (deletingId !== null) return
    const title = item.title || '会话'
    if (!window.confirm(`删除“${title}”？\n\n该会话的终端进程和 SSH 连接会立即结束，ChatGPT 对话历史不会因此删除。`)) return
    setDeletingId(item.id)
    try {
      await window.api.destroyManagedSession(item.id)
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

  const activeTransfers = transfers.filter(
    (item) => item.status === 'uploading' || item.status === 'downloading'
  )
  const activeTotal = activeTransfers.reduce((sum, item) => sum + item.total, 0)
  const activeTransferred = activeTransfers.reduce((sum, item) => sum + item.transferred, 0)
  const activePercent = activeTotal > 0
    ? Math.min(100, Math.round((activeTransferred / activeTotal) * 100))
    : 0

  return (
    <div className="workspace">
      <nav className="workspace__nav">
        <div className="workspace__brand">GPT → Codex</div>
        <button
          type="button"
          className={workspace.view === 'manager' ? 'workspace__nav-button workspace__nav-button--active' : 'workspace__nav-button'}
          onClick={() => void window.api.showWorkspaceManager()}
        >
          会话管理
        </button>
        <div className="workspace__nav-label">会话</div>
        <div className="workspace__sessions">
          {sessions.map((item) => (
            <div className="workspace__session-row" key={item.id}>
              <button
                type="button"
                className={workspace.sessionId === item.id ? 'workspace__session workspace__session--active' : 'workspace__session'}
                onClick={() => void window.api.openManagedSession(item.id)}
                title={item.title || item.target}
              >
                <span className="workspace__session-title">{item.title || '会话'}</span>
                <span className="workspace__session-meta">
                  {item.taskRunning ? <span className="workspace__session-running">● 执行中 · </span> : null}
                  {item.kind === 'ssh' ? 'SSH' : '本地'} · {item.target}
                </span>
              </button>
              <button
                type="button"
                className="workspace__session-delete"
                disabled={deletingId !== null}
                title={`删除 ${item.title || '会话'}`}
                aria-label={`删除 ${item.title || '会话'}`}
                onClick={() => void deleteSession(item)}
              >
                {deletingId === item.id ? '…' : '×'}
              </button>
            </div>
          ))}
        </div>
      </nav>

      <section className="workspace__content">
        {workspace.view === 'session' && workspace.sessionId ? (
          <App
            key={workspace.sessionId}
            initialSshDialogOpen={workspace.openSshDialog}
            globalModalOpen={transfersOpen}
            /*
             * Read from the session list rather than held as its own state: the main process
             * republishes the list whenever a session changes, including on a platform switch,
             * so this stays right without a second copy to keep in sync.
             */
            platformId={
              sessions.find((item) => item.id === workspace.sessionId)?.platformId ?? ''
            }
          />
        ) : (
          <ManagerApp />
        )}
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
      </footer>

      {transfersOpen ? (
        <div
          className="modal"
          role="dialog"
          aria-modal="true"
          aria-label="传输任务"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setTransfersOpen(false)
          }}
        >
          <div className="modal__box transfer-modal__box">
            <div className="modal__head">
              <span className="panel__title">传输任务</span>
              <span className="transfer-modal__summary">
                {activeTransfers.length > 0 ? `${activeTransfers.length} 个进行中` : '当前没有进行中的任务'}
              </span>
              <span className="panel__spacer" />
              <button
                type="button"
                className="panel__sync"
                aria-label="关闭"
                onClick={() => setTransfersOpen(false)}
              >
                ✕
              </button>
            </div>
            <div className="modal__body transfer-modal__body">
              {transfers.length === 0 ? (
                <div className="transfer-modal__empty">暂无上传或下载任务。</div>
              ) : (
                <div className="transfer-list">
                  {transfers.map((item) => {
                    const percent = item.total > 0
                      ? Math.min(100, Math.round((item.transferred / item.total) * 100))
                      : 0
                    const active = item.status === 'uploading' || item.status === 'downloading'
                    const session = sessions.find((candidate) => candidate.id === item.sessionId)
                    const sessionLabel = session?.title || session?.target || item.sessionId.slice(0, 8)
                    return (
                      <div
                        className="ssh-download transfer-item"
                        key={`${item.sessionId}:${item.direction}:${item.id}`}
                        title={item.error || (item.direction === 'upload' ? item.remotePath : item.localPath)}
                      >
                        <div className="ssh-download__row">
                          <span className={`transfer-item__direction transfer-item__direction--${item.direction}`}>
                            {item.direction === 'upload' ? '上传' : '下载'}
                          </span>
                          <span className="ssh-download__name">{item.name}</span>
                          <span className={`ssh-download__status ssh-download__status--${item.status}`}>
                            {transferStatus(item, percent)}
                          </span>
                          {active ? (
                            <button
                              type="button"
                              className="ssh-download__cancel"
                              onClick={() => void cancelTransfer(item)}
                            >
                              取消
                            </button>
                          ) : null}
                        </div>
                        <div className="ssh-download__progress" aria-label={`${item.name} ${item.direction === 'upload' ? '上传' : '下载'}进度`}>
                          <span style={{ width: `${item.total > 0 ? percent : 0}%` }} />
                        </div>
                        <div className="ssh-download__meta">
                          <span>{sessionLabel}</span>
                          <span>{formatBytes(item.transferred)}{item.total > 0 ? ` / ${formatBytes(item.total)}` : ''}</span>
                        </div>
                        {item.error ? <div className="ssh-download__error">{item.error}</div> : null}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}