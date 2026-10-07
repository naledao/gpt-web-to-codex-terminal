import { useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import CodeMirror, { EditorState, EditorView, oneDarkTheme } from '@uiw/react-codemirror'
import type { BasicSetupOptions, ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { MySQL, sql } from '@codemirror/lang-sql'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { openSearchPanel } from '@codemirror/search'
import { tags } from '@lezer/highlight'
import type { AppTheme } from '../../../shared/types'
import './SqlViewer.css'

interface SqlViewerProps {
  value: string
  theme: AppTheme
  label: string
  compact?: boolean
}

const MYSQL_LANGUAGE = sql({ dialect: MySQL })
function sqlHighlighting(dark: boolean) {
  return syntaxHighlighting(HighlightStyle.define([
    { tag: [tags.keyword, tags.bool, tags.null], color: dark ? '#c7a4ff' : '#6b3aad', fontWeight: '600' },
    { tag: [tags.name, tags.special(tags.string)], color: dark ? '#80c9ff' : '#075c94' },
    { tag: tags.typeName, color: dark ? '#f0bd81' : '#994b00' },
    { tag: tags.number, color: dark ? '#f0bd81' : '#9c451b' },
    { tag: tags.string, color: dark ? '#add990' : '#32691a' },
    { tag: tags.comment, color: dark ? '#9cadc2' : '#5c6778', fontStyle: 'italic' },
    { tag: tags.operator, color: dark ? '#b5c7d7' : '#42516a' }
  ]))
}
const SQL_HIGHLIGHTING = { light: sqlHighlighting(false), dark: sqlHighlighting(true) }

const VIEWER_SETUP: BasicSetupOptions = {
  lineNumbers: true,
  foldGutter: true,
  bracketMatching: true,
  highlightSelectionMatches: true,
  searchKeymap: true,
  highlightActiveLine: false,
  highlightActiveLineGutter: false,
  history: false,
  historyKeymap: false,
  autocompletion: false,
  completionKeymap: false,
  closeBrackets: false,
  closeBracketsKeymap: false,
  indentOnInput: false,
  dropCursor: false
}

const COMPACT_SETUP: BasicSetupOptions = {
  ...VIEWER_SETUP,
  lineNumbers: false,
  foldGutter: false,
  searchKeymap: false,
  highlightSelectionMatches: false
}

const CHINESE_PHRASES = EditorState.phrases.of({
  Find: '查找',
  next: '下一个',
  previous: '上一个',
  all: '全部',
  'match case': '区分大小写',
  regexp: '正则表达式',
  'by word': '全词匹配',
  close: '关闭',
  'Go to line': '跳转到行',
  go: '跳转',
  'current match': '当前匹配',
  'on line': '所在行',
  'Fold line': '折叠行',
  'Unfold line': '展开行',
  'folded code': '已折叠的代码',
  unfold: '展开',
  'Folded lines': '已折叠行',
  'Unfolded lines': '已展开行',
  to: '至'
})

export default function SqlViewer({ value, theme, label, compact = false }: SqlViewerProps): ReactElement {
  const editorRef = useRef<ReactCodeMirrorRef>(null)
  const [wrapLines, setWrapLines] = useState(false)
  const extensions = useMemo(() => [
    MYSQL_LANGUAGE,
    SQL_HIGHLIGHTING[theme],
    CHINESE_PHRASES,
    EditorState.tabSize.of(2),
    // Non-editable content still needs keyboard focus for selection and search.
    EditorView.contentAttributes.of({ tabindex: '0', 'aria-label': label, 'aria-readonly': 'true' }),
    ...(wrapLines ? [EditorView.lineWrapping] : [])
  ], [label, theme, wrapLines])

  return (
    <div className={compact ? 'sql-viewer sql-viewer--compact' : 'sql-viewer'}>
      {!compact ? (
        <div className="sql-viewer__toolbar">
          <span className="sql-viewer__mode">MySQL · 只读</span>
          <span className="panel__spacer" />
          <button
            type="button"
            className="sql-viewer__button"
            title="查找（Ctrl+F）"
            onClick={() => {
              const view = editorRef.current?.view
              if (view) openSearchPanel(view)
            }}
          >
            查找
          </button>
          <button
            type="button"
            className="sql-viewer__button"
            aria-pressed={wrapLines}
            onClick={() => setWrapLines((current) => !current)}
          >
            自动换行
          </button>
        </div>
      ) : null}
      <CodeMirror
        ref={editorRef}
        value={value}
        theme={theme === 'dark' ? oneDarkTheme : 'light'}
        extensions={extensions}
        basicSetup={compact ? COMPACT_SETUP : VIEWER_SETUP}
        readOnly
        editable={false}
        indentWithTab={false}
        minHeight={compact ? undefined : '200px'}
        maxHeight={compact ? '88px' : 'max(200px, calc(100vh - 280px))'}
      />
    </div>
  )
}
