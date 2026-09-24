import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { ManagedSessionSummary, WorkspaceState } from '../../shared/types'
import App from './App'
import ManagerApp from './ManagerApp'

const INITIAL_WORKSPACE: WorkspaceState = {
  view: 'manager',
  sessionId: null,
  openSshDialog: false
}

export default function WorkspaceApp(): ReactElement {
  const [workspace, setWorkspace] = useState<WorkspaceState>(INITIAL_WORKSPACE)
  const [sessions, setSessions] = useState<ManagedSessionSummary[]>([])
  const [deletingId, setDeletingId] = useState<string | null>(null)

  useEffect(() => {
    void window.api.getWorkspaceState().then(setWorkspace)
    void window.api.listManagedSessions().then(setSessions)
    const offWorkspace = window.api.onWorkspaceChanged(setWorkspace)
    const offSessions = window.api.onManagedSessionsChanged(setSessions)
    return () => {
      offWorkspace()
      offSessions()
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
    </div>
  )
}
