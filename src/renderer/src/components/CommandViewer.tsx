import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import CodeMirror, { EditorState, EditorView, oneDarkTheme } from '@uiw/react-codemirror'
import type { BasicSetupOptions, ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language'
import { powerShell } from '@codemirror/legacy-modes/mode/powershell'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { tags } from '@lezer/highlight'
import type { AppTheme } from '../../../shared/types'

export type CommandLanguage = 'powershell' | 'shell'

interface CommandViewerProps {
  command: string
  description: string
  language: CommandLanguage
  theme: AppTheme
  onClose: () => void
}

const COMMAND_LANGUAGES = {
  powershell: StreamLanguage.define(powerShell),
  shell: StreamLanguage.define(shell)
}

function commandHighlighting(dark: boolean) {
  return syntaxHighlighting(HighlightStyle.define([
    { tag: [tags.keyword, tags.atom, tags.bool, tags.null], color: dark ? '#c7a4ff' : '#6b3aad', fontWeight: '600' },
    { tag: tags.variableName, color: dark ? '#f3b894' : '#a13b2d' },
    { tag: tags.standard(tags.variableName), color: dark ? '#80c9ff' : '#075c94' },
    { tag: [tags.typeName, tags.namespace, tags.attributeName], color: dark ? '#f0bd81' : '#994b00' },
    { tag: tags.number, color: dark ? '#f0bd81' : '#9c451b' },
    { tag: [tags.string, tags.quote], color: dark ? '#add990' : '#32691a' },
    { tag: [tags.comment, tags.meta], color: dark ? '#9cadc2' : '#5c6778', fontStyle: 'italic' },
    { tag: [tags.operator, tags.punctuation], color: dark ? '#b5c7d7' : '#42516a' },
    // Legacy modes are display tokenizers, not validators for every shell version.
    { tag: tags.invalid, color: dark ? '#e6ecf6' : '#1f2733' }
  ]))
}

const COMMAND_HIGHLIGHTING = { light: commandHighlighting(false), dark: commandHighlighting(true) }

const VIEWER_SETUP: BasicSetupOptions = {
  lineNumbers: true,
  foldGutter: false,
  searchKeymap: true,
  highlightSelectionMatches: true,
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

export default function CommandViewer({ command, description, language, theme, onClose }: CommandViewerProps): ReactElement {
  const editorRef = useRef<ReactCodeMirrorRef>(null)
  const [wrapLines, setWrapLines] = useState(true)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  useEffect(() => {
    if (copyState === 'idle') return
    const timer = window.setTimeout(() => setCopyState('idle'), 2000)
    return () => window.clearTimeout(timer)
  }, [copyState])
  const extensions = useMemo(() => [
    COMMAND_LANGUAGES[language],
    COMMAND_HIGHLIGHTING[theme],
    EditorState.tabSize.of(2),
    EditorView.contentAttributes.of({ tabindex: '0', 'aria-label': '完整指令内容', 'aria-readonly': 'true' }),
    EditorState.phrases.of({ Find: '查找', next: '下一个', previous: '上一个', all: '全部',
      'match case': '区分大小写', regexp: '正则表达式', 'by word': '全词匹配', close: '关闭' }),
    ...(wrapLines ? [EditorView.lineWrapping] : [])
  ], [language, theme, wrapLines])

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose() }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="command-viewer__backdrop" />
        <Dialog.Popup
          className="command-viewer"
          data-theme={theme}
          initialFocus={() => editorRef.current?.view?.contentDOM ?? true}
        >
          <header className="command-viewer__head">
            <div className="command-viewer__heading">
              <Dialog.Title className="command-viewer__title">完整指令</Dialog.Title>
              <span className="command-viewer__language">{language === 'powershell' ? 'PowerShell' : 'Bash / Shell'}</span>
            </div>
            <div className="command-viewer__tools">
              {copyState === 'failed' ? <span className="command-viewer__error" role="alert">复制失败，请重试。</span> : null}
              <button type="button" className="command-viewer__button" onClick={async () => {
                try {
                  // Preserve the original instruction, including whitespace and line endings.
                  await navigator.clipboard.writeText(command)
                  setCopyState('copied')
                } catch { setCopyState('failed') }
              }}>{copyState === 'copied' ? '已复制' : '复制指令'}</button>
              <button type="button" className="command-viewer__button" aria-pressed={wrapLines}
                onClick={() => setWrapLines((current) => !current)}>自动换行</button>
              <Dialog.Close className="command-viewer__button" title="关闭弹窗（Esc）">关闭</Dialog.Close>
            </div>
          </header>
          {description !== '' ? <Dialog.Description className="command-viewer__description">{description}</Dialog.Description> : null}
          <div className="command-viewer__body">
            <CodeMirror
              ref={editorRef}
              value={command}
              theme={theme === 'dark' ? oneDarkTheme : 'light'}
              height="100%"
              extensions={extensions}
              basicSetup={VIEWER_SETUP}
              readOnly
              editable={false}
              indentWithTab={false}
            />
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
