import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { ManagedSessionSummary } from '../../shared/types'
import ConfirmDialog from './components/ConfirmDialog'

function formatCreatedAt(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value))
}

export default function ManagerApp(): ReactElement {
  const [sessions, setSessions] = useState<ManagedSessionSummary[]>([])
  const [creating, setCreating] = useState<'local' | 'ssh' | null>(null)
  const [destroying, setDestroying] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [renameSaving, setRenameSaving] = useState(false)
  const [pendingDestroy, setPendingDestroy] = useState<ManagedSessionSummary | null>(null)

  useEffect(() => {
    void window.api.listManagedSessions().then(setSessions)
    return window.api.onManagedSessionsChanged(setSessions)
  }, [])

  const createSession = async (kind: 'local' | 'ssh'): Promise<void> => {
    if (creating !== null) return
    setCreating(kind)
    try {
      await window.api.createManagedSession(kind)
    } finally {
      setCreating(null)
    }
  }

  const beginRename = (item: ManagedSessionSummary): void => {
    setRenamingId(item.id)
    setRenameDraft(item.title || '')
  }

  const saveRename = async (): Promise<void> => {
    if (!renamingId || renameSaving) return
    setRenameSaving(true)
    try {
      await window.api.renameManagedSession(renamingId, renameDraft)
      setRenamingId(null)
      setRenameDraft('')
    } finally {
      setRenameSaving(false)
    }
  }

  const cancelRename = (): void => {
    if (renameSaving) return
    setRenamingId(null)
    setRenameDraft('')
  }

  const destroySession = async (item: ManagedSessionSummary): Promise<void> => {
    if (destroying !== null) return
    setDestroying(item.id)
    try {
      await window.api.destroyManagedSession(item.id)
      setPendingDestroy(null)
    } finally {
      setDestroying(null)
    }
  }

  return (
    <main className="manager-page">
      <header className="manager-header">
        <h1>会话管理</h1>
        <div className="manager-header__actions">
          <button
            type="button"
            className="manager-create manager-create--local"
            disabled={creating !== null}
            onClick={() => void createSession('local')}
          >
            <span className="manager-create__icon">＋</span>
            {creating === 'local' ? '创建中…' : '本机会话'}
          </button>
          <button
            type="button"
            className="manager-create manager-create--ssh"
            disabled={creating !== null}
            onClick={() => void createSession('ssh')}
          >
            <span className="manager-create__icon">＋</span>
            {creating === 'ssh' ? '创建中…' : 'SSH 会话'}
          </button>
        </div>
      </header>

      <section className="manager-card">
        <div className="manager-card__topline">
          <div className="manager-card__title">全部会话</div>
          <div className="manager-card__count">{sessions.length} 个会话</div>
        </div>

        {sessions.length === 0 ? (
          <div className="manager-empty">
            <div className="manager-empty__icon">＋</div>
            <div className="manager-empty__title">暂无会话</div>
            <div className="manager-empty__hint">点击右上角按钮创建一个新会话</div>
          </div>
        ) : (
          <div className="manager-table">
            <div className="manager-table__head">
              <span>会话</span>
              <span>状态</span>
              <span>类型</span>
              <span>目标</span>
              <span>创建时间</span>
              <span className="manager-table__actions-title">操作</span>
            </div>

            {sessions.map((item) => (
              <div className="manager-table__row" key={item.id}>
                <div className="manager-session-cell">
                  <div className={`manager-session-icon manager-session-icon--${item.kind}`}>
                    {item.kind === 'ssh' ? '⌁' : '›_'}
                  </div>
                  <div className="manager-session-copy">
                    {renamingId === item.id ? (
                      <div className="manager-rename">
                        <input
                          autoFocus
                          className="manager-rename__input"
                          value={renameDraft}
                          disabled={renameSaving}
                          placeholder="会话名称"
                          onChange={(event) => setRenameDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') void saveRename()
                            if (event.key === 'Escape') cancelRename()
                          }}
                        />
                        <button type="button" onClick={() => void saveRename()} disabled={renameSaving}>✓</button>
                        <button type="button" onClick={cancelRename} disabled={renameSaving}>×</button>
                      </div>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="manager-session-name"
                          onClick={() => void window.api.openManagedSession(item.id)}
                        >
                          {item.title || '会话'}
                        </button>
                        <div className="manager-session-platform">
                          {item.platformId === 'deepseek' ? 'DeepSeek' : 'ChatGPT'}
                          {item.conversationId ? <span> · {item.conversationId}</span> : null}
                        </div>
                      </>
                    )}
                  </div>
                </div>

                <div>
                  <span className={item.taskRunning ? 'manager-status manager-status--running' : 'manager-status'}>
                    <i />{item.taskRunning ? '执行中' : '空闲'}
                  </span>
                </div>

                <div>
                  <span className={`manager-kind manager-kind--${item.kind}`}>
                    {item.kind === 'ssh' ? 'SSH' : '本地'}
                  </span>
                </div>

                <div className="manager-target" title={item.target}>{item.target || '—'}</div>
                <div className="manager-created">{formatCreatedAt(item.createdAt)}</div>

                <div className="manager-row-actions">
                  <button
                    type="button"
                    className="manager-action manager-action--open"
                    onClick={() => void window.api.openManagedSession(item.id)}
                  >
                    打开
                  </button>
                  <button
                    type="button"
                    className="manager-action manager-action--icon"
                    aria-label="重命名"
                    title="重命名"
                    disabled={destroying !== null || renamingId === item.id}
                    onClick={() => beginRename(item)}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    className="manager-action manager-action--icon manager-action--danger"
                    aria-label="销毁"
                    title="销毁"
                    disabled={destroying !== null}
                    onClick={() => setPendingDestroy(item)}
                  >
                    {destroying === item.id ? '…' : '×'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <ConfirmDialog
        open={pendingDestroy !== null}
        title={`销毁“${pendingDestroy?.title || '会话'}”？`}
        description="此操作会立即结束该会话的运行环境，请确认是否继续。"
        icon="!"
        danger
        busy={destroying !== null}
        confirmLabel="确认销毁"
        items={[
          { icon: '▣', label: '终端进程和 SSH 连接', value: '立即结束', tone: 'danger' },
          { icon: '◉', label: 'ChatGPT 对话历史', value: '保留', tone: 'success' }
        ]}
        onCancel={() => setPendingDestroy(null)}
        onConfirm={() => { if (pendingDestroy) void destroySession(pendingDestroy) }}
      />    </main>
  )
}
