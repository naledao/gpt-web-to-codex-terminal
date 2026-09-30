import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react'
import type { SshFileEntry } from '../../../shared/types'

interface SshDirectoryPickerProps {
  basePath: string
  onPick: (path: string) => void
  onClose: () => void
}

/** Join a POSIX directory and a child name without doubling the slash. */
function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? dir + name : dir + '/' + name
}

/**
 * Remote working-directory editor with live suggestions.
 *
 * Typing narrows a list of the sub-directories under the path being typed;
 * arrow keys move the highlight, Enter applies the highlight (or the typed
 * path when nothing matches) and Escape cancels. Suggestions come straight
 * from the SSH host, so they always reflect the real remote tree.
 */
export default function SshDirectoryPicker({
  basePath,
  onPick,
  onClose
}: SshDirectoryPickerProps): ReactElement {
  const [draft, setDraft] = useState(basePath)
  const [entries, setEntries] = useState<SshFileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [highlight, setHighlight] = useState(0)
  const containerRef = useRef<HTMLDivElement | null>(null)

  const trimmedBase = basePath && basePath.length > 0 ? basePath : '/'

  // Split the typed value into the directory to list plus the name prefix.
  const split = useMemo(() => {
    const slash = draft.lastIndexOf('/')
    if (slash < 0) {
      return { dir: trimmedBase.endsWith('/') ? trimmedBase : trimmedBase + '/', prefix: draft }
    }
    return { dir: draft.slice(0, slash + 1) || '/', prefix: draft.slice(slash + 1) }
  }, [draft, trimmedBase])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    void window.api
      .listSshFiles(split.dir)
      .then((list) => {
        if (cancelled) return
        setEntries(list.filter((entry) => entry.type === 'folder'))
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setEntries([])
        setError(err instanceof Error ? err.message : '读取远程目录失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [split.dir])

  const suggestions = useMemo(() => {
    const needle = split.prefix.toLowerCase()
    return entries
      .filter((entry) => entry.name.toLowerCase().startsWith(needle))
      .slice(0, 50)
  }, [entries, split.prefix])

  useEffect(() => {
    setHighlight(0)
  }, [split.prefix, split.dir])

  const confirm = (path: string): void => {
    const target = path.trim()
    if (target === '') return
    onPick(target)
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setHighlight((value) => Math.min(value + 1, suggestions.length - 1))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlight((value) => Math.max(value - 1, 0))
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const picked = suggestions[highlight]
      confirm(picked ? joinPath(split.dir, picked.name) : draft)
    }
  }

  return (
    <div
      className="ssh-cwd-picker"
      ref={containerRef}
      onBlur={(event) => {
        if (!containerRef.current?.contains(event.relatedTarget as Node | null)) onClose()
      }}
    >
      <input
        className="terminal-pane__cwd-input"
        value={draft}
        spellCheck={false}
        autoFocus
        aria-label="SSH 工作目录"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <ul className="ssh-cwd-picker__list" role="listbox">
        {loading ? (
          <li className="ssh-cwd-picker__hint">加载中…</li>
        ) : error ? (
          <li className="ssh-cwd-picker__hint ssh-cwd-picker__hint--error">{error}</li>
        ) : suggestions.length === 0 ? (
          <li className="ssh-cwd-picker__hint">没有匹配的子目录，回车可直接进入输入的路径</li>
        ) : (
          suggestions.map((entry, index) => (
            <li
              key={entry.id}
              role="option"
              aria-selected={index === highlight}
              className={
                index === highlight
                  ? 'ssh-cwd-picker__item ssh-cwd-picker__item--active'
                  : 'ssh-cwd-picker__item'
              }
              onMouseEnter={() => setHighlight(index)}
              onMouseDown={(event) => {
                event.preventDefault()
                confirm(joinPath(split.dir, entry.name))
              }}
            >
              <span className="ssh-cwd-picker__icon">📁</span>
              <span className="ssh-cwd-picker__name">{entry.name}</span>
            </li>
          ))
        )}
      </ul>
    </div>
  )
}