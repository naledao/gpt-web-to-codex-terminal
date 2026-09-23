import { useEffect, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import type { ManagedSessionSummary } from '../../shared/types'

const shell: CSSProperties = {
  height: '100%',
  overflow: 'auto',
  background: '#0b0e14',
  color: '#d7dde8',
  fontFamily: 'Inter, system-ui, sans-serif',
  padding: 28,
  boxSizing: 'border-box'
}

const button: CSSProperties = {
  border: '1px solid #303846',
  background: '#171c25',
  color: '#d7dde8',
  borderRadius: 7,
  padding: '9px 14px',
  cursor: 'pointer'
}

export default function ManagerApp(): ReactElement {
  const [sessions, setSessions] = useState<ManagedSessionSummary[]>([])
  const [creating, setCreating] = useState<'local' | 'ssh' | null>(null)
  const [destroying, setDestroying] = useState<string | null>(null)

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

  const destroySession = async (item: ManagedSessionSummary): Promise<void> => {
    if (destroying !== null) return
    const title = item.title || '会话'
    if (!window.confirm(`销毁“${title}”？\n\n该会话的终端进程和 SSH 连接会立即结束，ChatGPT 对话历史不会因此删除。`)) return
    setDestroying(item.id)
    try {
      await window.api.destroyManagedSession(item.id)
    } finally {
      setDestroying(null)
    }
  }

  return (
    <main style={shell}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22 }}>会话管理</h1>
          <div style={{ marginTop: 6, color: '#8b949e', fontSize: 13 }}>
            每个会话拥有独立的 ChatGPT、终端、SSH 和自动执行 loop。
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <button style={button} disabled={creating !== null} onClick={() => void createSession('local')}>
          {creating === 'local' ? '创建中…' : '+ 本地会话'}
        </button>
        <button style={button} disabled={creating !== null} onClick={() => void createSession('ssh')}>
          {creating === 'ssh' ? '创建中…' : '+ SSH 会话'}
        </button>
      </div>
      <section style={{ display: 'grid', gap: 12 }}>
        {sessions.length === 0 ? (
          <div style={{ border: '1px dashed #303846', borderRadius: 10, padding: 28, color: '#8b949e' }}>
            当前没有打开的会话。
          </div>
        ) : (
          sessions.map((item) => (
            <div key={item.id} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8 }}>
              <button
                onClick={() => void window.api.openManagedSession(item.id)}
                style={{ ...button, textAlign: 'left', padding: 16, display: 'grid', gridTemplateColumns: '1fr auto', gap: 8 }}
              >
                <div>
                  <div style={{ fontWeight: 650, fontSize: 15 }}>{item.title || '会话'}</div>
                  <div style={{ marginTop: 5, color: '#8b949e', fontSize: 12 }}>
                    {item.kind === 'ssh' ? 'SSH' : '本地'} · {item.target}
                  </div>
                  {item.conversationId ? (
                    <div style={{ marginTop: 4, color: '#6e7681', fontSize: 11 }}>{item.conversationId}</div>
                  ) : null}
                </div>
                <div style={{ color: '#7ee787', fontSize: 12, alignSelf: 'center' }}>打开</div>
              </button>
              <button
                type="button"
                disabled={destroying !== null}
                onClick={() => void destroySession(item)}
                style={{ ...button, color: '#ff7b72', padding: '9px 12px' }}
              >
                {destroying === item.id ? '销毁中…' : '销毁'}
              </button>
            </div>
          ))
        )}
      </section>
    </main>
  )
}
