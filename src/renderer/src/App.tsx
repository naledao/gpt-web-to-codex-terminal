import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Filemanager, WillowDark } from '@svar-ui/react-filemanager'
import MDEditor from '@uiw/react-md-editor'
import * as mdCommands from '@uiw/react-md-editor/commands'
import { Menu } from '@base-ui/react/menu'
import GitDialog from './components/GitDialog'
import type { IApi as FilemanagerApi, IEntity as FilemanagerEntity } from '@svar-ui/react-filemanager'
import type { CSSProperties, DragEvent as ReactDragEvent, FormEvent, JSX, MouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import { SESSION_COOKIE_NAME } from '@shared/types'
import { CHAT_PLATFORMS } from '@shared/platforms'
import type {
  AppTheme,
  AppSettings,
  AutomationState,
  Conversation,
  EmbedState,
  ExecutionMode,
  ExecutionRecord,
  ExecutionStatus,
  ExternalAuthNotice,
  InterceptorStatus,
  SessionImportResult,
  SshHost,
  SshHostDraft,
  SshFileEntry,
  SshState,
  TerminalNotes,
  TerminalState,
  UpdateStatus
} from '@shared/types'

const INITIAL_EMBED_STATE: EmbedState = {
  url: '',
  title: '',
  isLoading: true,
  canGoBack: false,
  canGoForward: false,
  conversationId: null
}

const TERMINAL_MIN_WIDTH = 220
const TERMINAL_DEFAULT_WIDTH = 400
const PANEL_MIN_WIDTH = 220
const PANEL_DEFAULT_WIDTH = 320
const PANEL_MAX_RESERVE = 520

/* Layout sizes live in localStorage so they survive the App remount that happens
 * when the workspace switches to another session (WorkspaceApp keys App by session id). */
const STORAGE_TERMINAL_WIDTH = 'layout.terminalWidth'
const STORAGE_TERMINAL_COLLAPSED = 'layout.terminalCollapsed'
const STORAGE_PANEL_WIDTH = 'layout.panelWidth'
const STORAGE_PANEL_COLLAPSED = 'layout.panelCollapsed'

function readStoredNumber(key: string, fallback: number): number {
  try {
    const raw = window.localStorage.getItem(key)
    if (raw === null) return fallback
    const value = Number(raw)
    return Number.isFinite(value) ? value : fallback
  } catch {
    return fallback
  }
}

function readStoredBool(key: string, fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(key)
    if (raw === null) return fallback
    return raw === '1'
  } catch {
    return fallback
  }
}

function toFilemanagerEntities(entries: SshFileEntry[]): FilemanagerEntity[] {
  return entries.map((entry) => ({
    id: entry.id,
    type: entry.type,
    size: entry.size,
    date: new Date(entry.modifiedAt),
    lazy: entry.type === 'folder'
  }))
}

const STATUS_LABEL: Record<ExecutionStatus, string> = {
  pending: '待执行',
  blocked: '需确认',
  running: '执行中',
  interrupted: '已中断',
  done: '完成',
  failed: '失败',
  timeout: '超时',
  skipped: '已跳过'
}

/** Statuses where a click can still start the command. */
const RUNNABLE: ReadonlySet<ExecutionStatus> = new Set<ExecutionStatus>(['pending', 'blocked'])

/**
 * Colour a status badge by what it means rather than by which status it is.
 *
 * `blocked` is amber like a warning because that is all it is in auto mode — the
 * audit list warns, it does not stop anything.
 */
function statusTone(status: ExecutionStatus): string {
  if (status === 'running') return 'badge badge--running'
  if (status === 'done') return 'badge badge--ok'
  if (status === 'failed' || status === 'timeout') return 'badge badge--bad'
  if (status === 'interrupted') return 'badge badge--warn'
  if (status === 'blocked') return 'badge badge--warn'
  return 'badge'
}

function displayTitle(conversation: Conversation): string {
  if (conversation.title.trim() !== '') return conversation.title
  return `未命名对话 · ${conversation.id.slice(0, 8)}`
}

function formatTime(epochMs: number): string {
  const date = new Date(epochMs)
  const today = new Date()
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()

  return sameDay
    ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}


interface AppProps {
  initialSshDialogOpen?: boolean
  /** Which chat platform this session is showing, from the main process's session list. */
  platformId?: string
  /** True while a workspace-level modal must cover the native embedded view. */
  globalModalOpen?: boolean
  /** Called after settings are saved so the workspace shell changes immediately. */
  onThemeChange: (theme: AppTheme) => void
}

export default function App({ initialSshDialogOpen = false, platformId = '', globalModalOpen = false, onThemeChange }: AppProps): JSX.Element {
  const [embed, setEmbed] = useState<EmbedState>(INITIAL_EMBED_STATE)
  const [externalAuth, setExternalAuth] = useState<ExternalAuthNotice | null>(null)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [interceptor, setInterceptor] = useState<InterceptorStatus | null>(null)
  const [automation, setAutomation] = useState<AutomationState | null>(null)
  const [executions, setExecutions] = useState<ExecutionRecord[]>([])
  const [terminal, setTerminal] = useState<TerminalState | null>(null)
  const [durationNow, setDurationNow] = useState(() => Date.now())
  const [address, setAddress] = useState('')
  const [editing, setEditing] = useState(false)
  const [terminalWidth, setTerminalWidth] = useState(() => readStoredNumber(STORAGE_TERMINAL_WIDTH, TERMINAL_DEFAULT_WIDTH))
  const [terminalCollapsed, setTerminalCollapsed] = useState(() => readStoredBool(STORAGE_TERMINAL_COLLAPSED, false))
  const [panelWidth, setPanelWidth] = useState(() => readStoredNumber(STORAGE_PANEL_WIDTH, PANEL_DEFAULT_WIDTH))
  const [panelCollapsed, setPanelCollapsed] = useState(() => readStoredBool(STORAGE_PANEL_COLLAPSED, false))
  const [switchingPlatform, setSwitchingPlatform] = useState(false)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [proxyDraft, setProxyDraft] = useState('')
  const [themeDraft, setThemeDraft] = useState<AppTheme>('light')
  const [savingSettings, setSavingSettings] = useState(false)
  /**
   * Session-import fields. The value never leaves this component except as the
   * argument of one IPC call, and is cleared as soon as that call settles.
   */
  const [sessionCookieName, setSessionCookieName] = useState(SESSION_COOKIE_NAME)
  const [sessionCookieValue, setSessionCookieValue] = useState('')
  const [sessionImport, setSessionImport] = useState<SessionImportResult | null>(null)
  /**
   * Whether the message above is a preview of the current paste or the outcome of a
   * real import. They must be styled differently: a preview saying "not signed in" is
   * normal, and a finished import saying it is a problem.
   */
  const [sessionImportPhase, setSessionImportPhase] = useState<'preview' | 'result'>('preview')
  const [importingSession, setImportingSession] = useState(false)
  const [commandDraft, setCommandDraft] = useState('')
  /** Non-null while the working directory is being edited inline. */
  const [cwdDraft, setCwdDraft] = useState<string | null>(null)
  /**
   * Non-null while the send-delay field is being edited.
   *
   * The committed value lives in main and arrives back over terminal:changed, so
   * without a local draft every push would rewrite the box while it is being
   * typed into.
   */
  const [sendDelayDraft, setSendDelayDraft] = useState<string | null>(null)
  const [ssh, setSsh] = useState<SshState | null>(null)
  const [sshHosts, setSshHosts] = useState<SshHost[]>([])
  /** The per-machine note editor, shown inside the terminal pane. */
  const [notesOpen, setNotesOpen] = useState(false)
  const [notes, setNotes] = useState<TerminalNotes | null>(null)
  const [notesDraft, setNotesDraft] = useState('')
  const [notesSaving, setNotesSaving] = useState(false)
  const [notesPreview, setNotesPreview] = useState(false)
  /** 注入提示词查看弹框。 */
  /** The Git 管理 dialog opened from the toolbox. */
  const [gitDialogOpen, setGitDialogOpen] = useState(false)
  const [promptOpen, setPromptOpen] = useState(false)
  const [promptSearchOpen, setPromptSearchOpen] = useState(false)
  const [promptSearch, setPromptSearch] = useState('')
  const [promptCopied, setPromptCopied] = useState(false)
  const [sshDialogOpen, setSshDialogOpen] = useState(initialSshDialogOpen)
  const [sshAdvancedOpen, setSshAdvancedOpen] = useState(true)
  /** The quick host list, shown inside the terminal pane. */
  const [sshPickerOpen, setSshPickerOpen] = useState(false)
  const [sshBusy, setSshBusy] = useState(false)
  const [sshUploading, setSshUploading] = useState(false)
  const [sshFilesOpen, setSshFilesOpen] = useState(false)
  const [sshFileData, setSshFileData] = useState<FilemanagerEntity[]>([])
  const [sshFilesLoading, setSshFilesLoading] = useState(false)
  const [sshFilesError, setSshFilesError] = useState('')
  const [sshDraft, setSshDraft] = useState<SshHostDraft>({
    id: null,
    name: '',
    host: '',
    port: 22,
    username: 'root',
    password: '',
    proxy: ''
  })
  const [sshProxyDraft, setSshProxyDraft] = useState('')
  const [updateProxyDraft, setUpdateProxyDraft] = useState('')
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null)
  /** True between clicking download and the first progress event. */
  const [preparingDownload, setPreparingDownload] = useState(false)

  /** While an SSH transcript is on screen it replaces the local terminal. */
  const sshActive = ssh !== null && ssh.attached
  /**
   * True while a host is actually in charge — as opposed to the pane merely still
   * showing a transcript after a disconnect or a failure. Deciding this in one
   * place keeps the switcher's "you are here" mark honest.
   */
  const sshLive = sshActive && (ssh?.status === 'connected' || ssh?.status === 'connecting')
  /** True when the machine in charge has a note; the marker on the 说明 button. */
  const notesSet = (notes?.text ?? '').trim() !== ''
  const slotRef = useRef<HTMLDivElement>(null)
  /** The pane the toolbox menu mounts into, so it can never spill under the native web view. */
  const toolboxPaneRef = useRef<HTMLElement>(null)
  const terminalOutputRef = useRef<HTMLDivElement>(null)
  /** scope:hostId of the note currently loaded into the editor. */
  const notesOwnerRef = useRef('')

  // Persist the layout sizes: switching sessions remounts App (WorkspaceApp keys it
  // by session id), so without this the terminal width would snap back to default.
  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_TERMINAL_WIDTH, String(terminalWidth))
      window.localStorage.setItem(STORAGE_TERMINAL_COLLAPSED, terminalCollapsed ? '1' : '0')
      window.localStorage.setItem(STORAGE_PANEL_WIDTH, String(panelWidth))
      window.localStorage.setItem(STORAGE_PANEL_COLLAPSED, panelCollapsed ? '1' : '0')
    } catch {
      /* storage unavailable; the sizes just will not persist */
    }
  }, [terminalWidth, terminalCollapsed, panelWidth, panelCollapsed])

  const conversationId = embed.conversationId
  const isAuto = automation?.mode === 'auto'
  const taskRunning = interceptor?.taskStartedAt != null && interceptor.taskFinishedAt == null

  const waiting = useMemo(
    () => executions.filter((record) => RUNNABLE.has(record.status)),
    [executions]
  )

  /**
   * The step the loop is on, for the call-out above the output.
   *
   * Running wins, because that is literally "the currently executing command".
   * Otherwise it is the newest command still waiting — that is the one the next
   * 运行 click would start — and only when there is nothing outstanding does it
   * fall back to the last completed one, so the block does not go blank the moment
   * a command finishes.
   */
  const currentExecution = useMemo(() => {
    const running = executions.find((record) => record.status === 'running')
    if (running) return running
    if (waiting.length > 0) return waiting[waiting.length - 1]
    return executions.length > 0 ? executions[executions.length - 1] : null
  }, [executions, waiting])

  /**
   * What the USER asked for in this conversation.
   *
   * Not `currentExecution.description`: that is the model's one-liner about a single
   * command, which is a different thing and reads as a non-sequitur under a label that
   * says "goal". The goal is captured on send and stored on the conversation itself, so
   * it also survives a reload — where `description` is only as good as the last command
   * that happened to run.
   */
  const currentGoal = useMemo(() => {
    if (!conversationId) return ''
    return conversations.find((conversation) => conversation.id === conversationId)?.goal?.trim() ?? ''
  }, [conversations, conversationId])

  useEffect(() => {
    if (interceptor?.taskStartedAt == null || interceptor.taskFinishedAt != null) return
    setDurationNow(Date.now())
    const timer = window.setInterval(() => setDurationNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [interceptor?.taskStartedAt, interceptor?.taskFinishedAt])

  // Third-party OAuth must run in the system browser. Pull the last notice once
  // as well as subscribing so a redirect that happened before React mounted is
  // still explained to the user.
  useEffect(() => {
    let cancelled = false

    void window.api.getExternalAuthNotice().then((notice) => {
      if (!cancelled && notice) setExternalAuth(notice)
    })

    const unsubscribe = window.api.onExternalAuth(setExternalAuth)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  // Embed state is pushed from the main process, but the earliest events fire
  // before React subscribes, so pull the current snapshot first as well.
  useEffect(() => {
    let cancelled = false

    window.api
      .getEmbedState()
      .then((state) => {
        if (!cancelled) setEmbed(state)
      })
      .catch(() => {
        /* push updates below will still recover the UI */
      })

    const unsubscribe = window.api.onEmbedState(setEmbed)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  // Stored conversations: load once, then stay in sync with main's pushes.
  useEffect(() => {
    let cancelled = false

    window.api
      .listConversations()
      .then((items) => {
        if (!cancelled) setConversations(items)
      })
      .catch(() => {
        /* the panel simply stays empty */
      })

    const unsubscribe = window.api.onConversationsChanged(setConversations)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  // Terminal-mode interceptor: same pull-then-subscribe pattern as the embed
  // state, because the script reports 'installed' before React mounts.
  useEffect(() => {
    let cancelled = false

    window.api
      .getInterceptorStatus()
      .then((status) => {
        if (!cancelled) setInterceptor(status)
      })
      .catch(() => {
        /* the block renders a placeholder */
      })

    const unsubscribe = window.api.onInterceptorEvent(setInterceptor)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  // Automation + terminal.
  useEffect(() => {
    let cancelled = false

    void window.api.getAutomationState().then((state) => {
      if (!cancelled) setAutomation(state)
    })
    void window.api.getTerminalState().then((state) => {
      if (!cancelled) setTerminal(state)
    })

    const offAutomation = window.api.onAutomationChanged(setAutomation)
    const offTerminal = window.api.onTerminalChanged(setTerminal)
    return () => {
      cancelled = true
      offAutomation()
      offTerminal()
    }
  }, [])

  // Executions belong to whichever conversation is on screen.
  const refreshExecutions = useCallback(async (): Promise<void> => {
    if (!conversationId) {
      setExecutions([])
      return
    }
    try {
      setExecutions(await window.api.listExecutions(conversationId))
    } catch {
      /* leave the previous list in place */
    }
  }, [conversationId])

  useEffect(() => {
    void refreshExecutions()
  }, [refreshExecutions])

  useEffect(() => window.api.onExecutionChanged(() => void refreshExecutions()), [refreshExecutions])

  // Mirror the real URL into the address bar, but never while it is being typed.
  useEffect(() => {
    if (!editing) setAddress(embed.url)
  }, [embed.url, editing])

  // Keep the newest terminal output in view. Both transcripts are watched: while
  // an SSH session is attached the pane renders the SSH one, and the model's own
  // commands are mirrored into it.
  useEffect(() => {
    const element = terminalOutputRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [terminal?.lines, ssh?.lines])

  /**
   * The embedded page is a NATIVE view, not a DOM node, so it cannot be
   * positioned by CSS. Measure the placeholder and hand the rectangle to the
   * main process, which moves the view on top of it.
   *
   * getBoundingClientRect() is in CSS pixels relative to the viewport, which is
   * exactly the coordinate space `WebContentsView.setBounds()` expects (DIPs),
   * so no devicePixelRatio scaling is needed here.
   */
  useEffect(() => {
    const element = slotRef.current
    if (!element) return

    const report = (): void => {
      const rect = element.getBoundingClientRect()
      window.api.setEmbedBounds({
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      })
    }

    report()
    const observer = new ResizeObserver(report)
    observer.observe(element)
    window.addEventListener('resize', report)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', report)
      // Collapsing the rectangle hides the native view on unmount.
      window.api.setEmbedBounds({ x: 0, y: 0, width: 0, height: 0 })
    }
  }, [])

  const submitAddress = useCallback(
    (event: FormEvent<HTMLFormElement>): void => {
      event.preventDefault()
      if (taskRunning) {
        setEditing(false)
        return
      }
      window.api.navigateEmbed(address)
      setEditing(false)
    },
    [address, taskRunning]
  )

  /**
   * Send the embedded view to the email/OTP sign-in page.
   *
   * This used to send the embed home, which is not a sign-in route at all: the
   * button promised email sign-in and did nothing. Email/OTP is the only route that
   * can complete inside the embedded user-agent, so it is the one the banner must
   * actually offer.
   */
  const loginWithEmail = useCallback((): void => {
    setExternalAuth(null)
    window.api.loginWithEmail()
  }, [])

  const openChatgptExternal = useCallback((): void => {
    setExternalAuth(null)
    window.api.openChatgptExternal()
  }, [])

  /**
   * Hand the pasted token to the main process, then forget it here.
   *
   * The field is cleared in `finally` rather than on success: a failed import is
   * exactly when the user is most likely to paste again, and leaving a live session
   * token sitting in a DOM input is not worth the convenience.
   */
  const submitSessionImport = useCallback(async (): Promise<void> => {
    setImportingSession(true)
    setSessionImport(null)
    // Claim the message before the value is cleared below: otherwise the preview
    // effect sees an empty field, decides there is nothing to report, and wipes the
    // import's own result off the screen the moment it arrives.
    setSessionImportPhase('result')
    try {
      const result = await window.api.importSession({
        name: sessionCookieName,
        value: sessionCookieValue
      })
      setSessionImport(result)
    } catch (error) {
      setSessionImport({
        ok: false,
        message: `导入调用失败：${(error as Error).message}`,
        signedIn: false
      })
    } finally {
      setSessionCookieValue('')
      setImportingSession(false)
    }
  }, [sessionCookieName, sessionCookieValue])

  /**
   * Say what the paste WOULD import, before anything is written.
   *
   * Pasting the whole `cookie:` header is the reliable move, and this is what makes it
   * trustworthy: the user sees which cookie was recognised and how big the reassembled
   * token is, instead of having to guess whether they grabbed the right row out of
   * DevTools. Debounced, because it runs on every keystroke.
   */
  useEffect(() => {
    if (!settingsOpen) return
    const value = sessionCookieValue.trim()
    if (value === '') {
      if (sessionImportPhase !== 'result') setSessionImport(null)
      return
    }

    let cancelled = false
    const timer = setTimeout(() => {
      void window.api
        .previewSessionImport({ name: sessionCookieName, value: sessionCookieValue })
        .then((result) => {
          if (cancelled) return
          setSessionImportPhase('preview')
          setSessionImport(result)
        })
        .catch(() => {
          /* a preview that fails is not worth reporting — the import itself will */
        })
    }, 250)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [settingsOpen, sessionCookieName, sessionCookieValue])

  const externalAuthProviderLabel = externalAuth?.provider === 'apple' ? 'Apple' : 'Google'

  const conversationFolders = useMemo(() => {
    const folders = new Map<
      string,
      { project: Conversation['project']; conversations: Conversation[] }
    >()

    for (const conversation of conversations) {
      const key = conversation.project?.id ?? '__unbound__'
      const folder = folders.get(key)
      if (folder) {
        folder.conversations.push(conversation)
      } else {
        folders.set(key, { project: conversation.project, conversations: [conversation] })
      }
    }

    return Array.from(folders.values())
  }, [conversations])

  const openConversation = useCallback(async (conversation: Conversation): Promise<void> => {
    if (conversation.id === conversationId || taskRunning) return
    if (conversation.project?.path) {
      try {
        setTerminal(await window.api.setTerminalCwd(conversation.project.path))
      } catch {
        /* keep the current directory, but still open the conversation */
      }
    }
    window.api.navigateEmbed(conversation.url)
  }, [conversationId, taskRunning])

  const moveConversationToProject = useCallback(
    async (event: ReactDragEvent<HTMLElement>, projectId: string): Promise<void> => {
      event.preventDefault()
      const conversationId = event.dataTransfer.getData('text/plain')
      if (conversationId === '') return
      const source = conversations.find((conversation) => conversation.id === conversationId)
      if (!source || source.project?.id === projectId) return

      try {
        setConversations(await window.api.moveConversation(conversationId, projectId))
      } catch {
        /* leave the previous grouping in place */
      }
    },
    [conversations]
  )
  const toggleInterceptor = useCallback(async (): Promise<void> => {
    if (!interceptor) return
    try {
      setInterceptor(await window.api.setInterceptorEnabled(!interceptor.enabled))
    } catch {
      /* leave the previous state in place */
    }
  }, [interceptor])

  const setMode = useCallback(async (mode: ExecutionMode): Promise<void> => {
    try {
      setAutomation(await window.api.setAutomationMode(mode))
    } catch {
      /* leave the previous state in place */
    }
  }, [])

  /**
   * Bring the other platform's page to the front.
   *
   * No state is set from the result: the main process republishes the session list, and
   * `platformId` comes from there — so the button only moves if the switch actually happened.
   * The main process also re-sends `embed:state` for the newly shown view, which is what
   * updates the address bar and the conversation list.
   */
  const switchPlatform = useCallback(async (next: string): Promise<void> => {
    setSwitchingPlatform(true)
    try {
      await window.api.switchSessionPlatform(next)
    } catch {
      /* leave the previous state in place */
    } finally {
      setSwitchingPlatform(false)
    }
  }, [])

  /** Escape hatch: re-read the last reply even though it counted as pre-existing. */
  const checkLastReply = useCallback(async (): Promise<void> => {
    try {
      setAutomation(await window.api.checkLastReply())
      await refreshExecutions()
    } catch {
      /* ignore */
    }
  }, [refreshExecutions])

  const endTask = useCallback(async (): Promise<void> => {
    try {
      setInterceptor(await window.api.endTask())
      await refreshExecutions()
    } catch {
      /* leave pushed state to correct the UI */
    }
  }, [refreshExecutions])

  const togglePaused = useCallback(async (): Promise<void> => {
    if (!automation) return
    try {
      setAutomation(await window.api.setAutomationPaused(!automation.paused))
    } catch {
      /* leave the previous state in place */
    }
  }, [automation])

  const runExecution = useCallback(
    async (messageId: string): Promise<void> => {
      try {
        setExecutions(await window.api.runExecution(messageId))
      } catch {
        /* the pushed update will correct the list */
      }
    },
    []
  )

  const skipExecution = useCallback(async (messageId: string): Promise<void> => {
    try {
      setExecutions(await window.api.skipExecution(messageId))
    } catch {
      /* ignore */
    }
  }, [])

  const submitCommand = useCallback(
    async (event: FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault()
      const text = commandDraft
      setCommandDraft('')
      try {
        // One input box, two destinations: whatever the pane is currently showing.
        if (sshActive) {
          setSsh(await window.api.sendSshInput(text))
        } else {
          setTerminal(await window.api.sendTerminalInput(text))
        }
      } catch {
        /* ignore */
      }
    },
    [commandDraft, sshActive]
  )

  const connectSsh = useCallback(async (draft: SshHostDraft): Promise<void> => {
    setSshBusy(true)
    try {
      // Resolves with `connecting`; the outcome arrives over onSshChanged.
      setSsh(await window.api.connectSsh(draft))
      setSshHosts(await window.api.listSshHosts())
      setSshDialogOpen(false)
    } catch {
      /* the dialog stays open so the input is not lost */
    } finally {
      setSshBusy(false)
    }
  }, [])

  /**
   * Jump straight to a saved host from the quick list.
   *
   * The point of the list is that switching costs one click: no dialog, and no
   * having to close the current session first. A host with a stored password
   * connects immediately; one without opens the form prefilled instead, because
   * connecting with no password would flip the pane over and only then report
   * that it needs one — losing the transcript you were reading.
   */
  const switchSshHost = useCallback(
    async (host: SshHost): Promise<void> => {
      setSshPickerOpen(false)
      // Already here: reconnecting would drop a working session for nothing.
      if (sshLive && ssh?.hostId === host.id) return

      if (!host.hasPassword) {
        setSshDraft({
          id: host.id,
          name: host.name,
          host: host.host,
          port: host.port,
          username: host.username,
          password: '',
          proxy: host.proxy
        })
        setSshDialogOpen(true)
        return
      }

      setSshBusy(true)
      try {
        setSsh(
          await window.api.connectSsh({
            id: host.id,
            name: host.name,
            host: host.host,
            port: host.port,
            username: host.username,
            // Empty means "use the password already stored for this host".
            password: '',
            proxy: host.proxy
          })
        )
        setSshHosts(await window.api.listSshHosts())
      } catch {
        /* the pane's own state reports the failure */
      } finally {
        setSshBusy(false)
      }
    },
    [ssh?.hostId, sshLive]
  )

  const uploadSshFiles = useCallback(async (): Promise<void> => {
    if (ssh?.status !== 'connected' || sshUploading) return
    setSshUploading(true)
    try {
      setSsh(await window.api.uploadSshFiles())
    } catch {
      /* upload errors are reported in the SSH transcript when possible */
    } finally {
      setSshUploading(false)
    }
  }, [ssh?.status, sshUploading])
  const initSshFilemanager = useCallback((api: FilemanagerApi): void => {
    api.on('request-data', (event) => {
      const id = String(event?.id ?? '/')
      setSshFilesError('')
      void window.api
        .listSshFiles(id)
        .then((entries) => api.exec('provide-data', { id, data: toFilemanagerEntities(entries) }))
        .catch((error: unknown) => {
          setSshFilesError(error instanceof Error ? error.message : '读取远程目录失败')
          void api.exec('provide-data', { id, data: [] })
        })
    })
    const downloadFile = (event: { id?: string } | null): void => {
      const id = String(event?.id ?? '')
      if (id === '') return
      setSshFilesError('')
      void window.api.downloadSshFile(id).catch((error: unknown) => {
        setSshFilesError(error instanceof Error ? error.message : '下载远程文件失败')
      })
    }
    api.on('download-file', downloadFile)
    api.on('open-file', downloadFile)
  }, [])

  useEffect(() => {
    let cancelled = false
    if (!sshFilesOpen || ssh?.status !== 'connected') {
      setSshFileData([])
      setSshFilesError('')
      setSshFilesLoading(false)
      return () => {
        cancelled = true
      }
    }
    setSshFilesError('')
    setSshFilesLoading(true)
    void window.api
      .listSshFiles('/')
      .then((entries) => {
        if (!cancelled) setSshFileData(toFilemanagerEntities(entries))
      })
      .catch((error: unknown) => {
        if (!cancelled) setSshFilesError(error instanceof Error ? error.message : '读取远程目录失败')
      })
      .finally(() => {
        if (!cancelled) setSshFilesLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [sshFilesOpen, ssh?.status, ssh?.hostId])

  const disconnectSsh = useCallback(async (): Promise<void> => {
    try {
      setSsh(await window.api.disconnectSsh())
    } catch {
      /* ignore */
    }
  }, [])

  const dismissSsh = useCallback(async (): Promise<void> => {
    try {
      setSsh(await window.api.dismissSsh())
    } catch {
      /* ignore */
    }
  }, [])

  const removeSshHost = useCallback(async (id: string): Promise<void> => {
    try {
      setSshHosts(await window.api.removeSshHost(id))
      setSshDraft((current) => (current.id === id ? { ...current, id: null } : current))
    } catch {
      /* ignore */
    }
  }, [])

  const interruptTerminal = useCallback(async (): Promise<void> => {
    const next = await window.api.interruptTerminal()
    setTerminal(next)
  }, [])

  /**
   * Commit the send-delay field.
   *
   * The draft is read and dropped before the await so a push landing mid-flight
   * cannot leave the box holding text the user already submitted. Reading it
   * first is also what makes Escape work: it clears the draft, and by the time
   * blur fires there is nothing left to commit.
   */
  const commitSendDelay = useCallback(async (): Promise<void> => {
    const raw = sendDelayDraft
    setSendDelayDraft(null)
    if (raw === null) return
    const seconds = raw.trim() === '' ? 0 : Number(raw)
    if (!Number.isFinite(seconds)) return
    try {
      setTerminal(await window.api.setTerminalSendDelay(seconds))
    } catch {
      /* main keeps the previous value */
    }
  }, [sendDelayDraft])

  const resetTerminal = useCallback(async (): Promise<void> => {
    try {
      setTerminal(await window.api.resetTerminal())
    } catch {
      /* ignore */
    }
  }, [])

  /**
   * Move the terminal somewhere else.
   *
   * Main re-runs the environment probe afterwards, because the working directory
   * is part of what the model is told — the prompt on screen would otherwise
   * describe a directory the terminal has already left.
   */
  const submitCwd = useCallback(
    async (event: FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault()
      const target = (cwdDraft ?? '').trim()
      // Closed before awaiting: the input's blur handler must not race with it.
      setCwdDraft(null)
      if (target === '') return
      try {
        setTerminal(await window.api.setTerminalCwd(target))
      } catch {
        /* main leaves the previous directory in place */
      }
    },
    [cwdDraft]
  )

  // Settings: load once, then mirror into the draft the dialog edits.
  useEffect(() => {
    let cancelled = false

    window.api
      .getSettings()
      .then((value) => {
        if (cancelled) return
        setSettings(value)
        setProxyDraft(value.embedProxy)
        setThemeDraft(value.theme)
        setSshProxyDraft(value.sshProxy)
        setUpdateProxyDraft(value.updateProxy)
      })
      .catch(() => {
        /* the dialog renders a placeholder */
      })

      .catch(() => {
        /* the section is simply omitted */
      })

    return () => {
      cancelled = true
    }
  }, [settingsOpen])

  /*
   * Updater state: seed once so the dialog has something to render, then keep
   * it live. Main is the source of truth; this only mirrors what it pushes.
   */
  useEffect(() => {
    let cancelled = false
    window.api
      .getUpdateStatus()
      .then((value) => {
        if (!cancelled) setUpdateStatus(value)
      })
      .catch(() => {
        /* the section renders a placeholder */
      })
    const off = window.api.onUpdateChanged((value) => setUpdateStatus(value))
    return () => {
      cancelled = true
      off()
    }
  }, [])

  /*
   * The spinner covers the gap between clicking download and the first
   * progress event. Any phase other than 'available' means the wait is over.
   */
  useEffect(() => {
    if (updateStatus?.phase !== 'available') setPreparingDownload(false)
  }, [updateStatus?.phase])


  /**
   * The embedded page is a NATIVE view: it always paints above the DOM, so an
   * overlay alone would be hidden behind it. Hide the view while a dialog is up.
   */
  useEffect(() => {
    window.api.setEmbedVisible(!settingsOpen && !sshDialogOpen && !notesOpen && !globalModalOpen && !promptOpen && !gitDialogOpen)
    window.api.setWorkspaceSshDialogOpen(sshDialogOpen)
  }, [settingsOpen, sshDialogOpen, notesOpen, globalModalOpen, promptOpen, gitDialogOpen])

  // SSH state and saved hosts.
  useEffect(() => {
    let cancelled = false

    void window.api.getSshState().then((value) => {
      if (!cancelled) setSsh(value)
    })
    void window.api.listSshHosts().then((value) => {
      if (!cancelled) setSshHosts(value)
    })

    const unsubscribe = window.api.onSshChanged(setSsh)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  /**
   * Adopt the note the main process hands over.
   *
   * Main pushes on every save AND whenever the machine in charge changes, so the
   * draft is only replaced when the editor is showing a DIFFERENT machine —
   * otherwise a routine broadcast would wipe whatever is being typed.
   */
  const applyNotes = useCallback((value: TerminalNotes): void => {
    const owner = `${value.scope}:${value.hostId}`
    if (owner !== notesOwnerRef.current) {
      notesOwnerRef.current = owner
      setNotesDraft(value.text)
    }
    setNotes(value)
  }, [])

  // Per-machine notes: the same value the prompt is built from, resolved in main
  // against the live backend so the renderer never guesses which machine is which.
  useEffect(() => {
    let cancelled = false

    void window.api.getTerminalNotes().then((value) => {
      if (!cancelled) applyNotes(value)
    })

    const unsubscribe = window.api.onTerminalNotesChanged(applyNotes)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [applyNotes])

  const saveNotes = useCallback(async (): Promise<void> => {
    setNotesSaving(true)
    try {
      applyNotes(await window.api.setTerminalNotes(notesDraft))
      setNotesOpen(false)
    } catch {
      /* leave the panel open so nothing typed is lost */
    } finally {
      setNotesSaving(false)
    }
  }, [applyNotes, notesDraft])

  // Escape closes the dialog, like every other dialog on the platform.
  useEffect(() => {
    if (!settingsOpen) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setSettingsOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [settingsOpen])

  // Escape closes the injected-prompt viewer; Ctrl/Cmd+F opens its local find field.
  useEffect(() => {
    if (!promptOpen) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        setPromptSearchOpen(true)
        return
      }
      if (event.key === 'Escape') {
        if (promptSearchOpen) {
          setPromptSearchOpen(false)
          setPromptSearch('')
        } else {
          setPromptOpen(false)
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [promptOpen, promptSearchOpen])

  // …and dismisses the transient panels that live in the terminal column.
  useEffect(() => {
    if (!sshPickerOpen && !notesOpen) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setSshPickerOpen(false)
      setNotesOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [sshPickerOpen, notesOpen])

  const saveSettings = useCallback(async (): Promise<void> => {
    setSavingSettings(true)
    try {
      // Show back what main actually stored — it normalises a bare "host:port"
      // into a URL, and the user should see that rather than be surprised later.
      const next = await window.api.updateSettings({
        theme: themeDraft,
        embedProxy: proxyDraft,
        sshProxy: sshProxyDraft,
        updateProxy: updateProxyDraft
      })
      setSettings(next)
      onThemeChange(next.theme)
      setThemeDraft(next.theme)
      setProxyDraft(next.embedProxy)
      setSshProxyDraft(next.sshProxy)
      setUpdateProxyDraft(next.updateProxy)
      setSettingsOpen(false)
    } catch {
      /* leave the dialog open so the input is not lost */
    } finally {
      setSavingSettings(false)
    }
  }, [onThemeChange, proxyDraft, sshProxyDraft, themeDraft, updateProxyDraft])

  /** Drag the terminal's right edge to resize the column. */
  const startResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      event.preventDefault()
      const startX = event.clientX
      const startWidth = terminalWidth

      const onMove = (moveEvent: PointerEvent): void => {
        // The terminal sits on the LEFT, so dragging right makes it wider.
        const next = startWidth + (moveEvent.clientX - startX)
        // Leave room for the chat view and the conversation panel.
        const max = Math.max(TERMINAL_MIN_WIDTH, window.innerWidth - 520)
        setTerminalWidth(Math.min(Math.max(next, TERMINAL_MIN_WIDTH), max))
      }
      const onUp = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
      }

      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [terminalWidth]
  )

  /** Drag the conversation panel's left edge to resize that column. */
  const startPanelResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      event.preventDefault()
      const startX = event.clientX
      const startWidth = panelWidth

      const onMove = (moveEvent: PointerEvent): void => {
        // The panel sits on the RIGHT, so dragging left makes it wider.
        const next = startWidth - (moveEvent.clientX - startX)
        // Leave room for the terminal and the chat view.
        const max = Math.max(PANEL_MIN_WIDTH, window.innerWidth - PANEL_MAX_RESERVE)
        setPanelWidth(Math.min(Math.max(next, PANEL_MIN_WIDTH), max))
      }
      const onUp = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
      }

      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [panelWidth]
  )

  const removeConversation = useCallback(
    async (event: MouseEvent, id: string): Promise<void> => {
      // The row itself navigates; the delete button must not trigger that.
      event.stopPropagation()
      try {
        setConversations(await window.api.removeConversation(id))
      } catch {
        /* ignore */
      }
    },
    []
  )

  return (
    <div className={panelCollapsed ? 'app app--panel-collapsed' : 'app'} style={{ '--terminal-width': `${terminalWidth}px`, '--panel-width': `${panelWidth}px` } as CSSProperties}>
      <header className="topbar">
        <div className="brand">
          <span className="brand__mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M3 12h18" />
              <path d="M12 3c2.6 2.6 3.9 5.7 3.9 9s-1.3 6.4-3.9 9c-2.6-2.6-3.9-5.7-3.9-9S9.4 5.6 12 3z" />
            </svg>
          </span>
          <span className="brand__text">Web → Codex Terminal</span>
        </div>

        <div className="toolbar">
          <button
            type="button"
            title="后退"
            disabled={taskRunning || !embed.canGoBack}
            onClick={() => window.api.sendEmbedCommand('back')}
          >
            ←
          </button>
          <button
            type="button"
            title="前进"
            disabled={taskRunning || !embed.canGoForward}
            onClick={() => window.api.sendEmbedCommand('forward')}
          >
            →
          </button>
          <button
            type="button"
            title={embed.isLoading ? '停止加载' : '重新加载'}
            disabled={taskRunning && !embed.isLoading}
            onClick={() => window.api.sendEmbedCommand(embed.isLoading ? 'stop' : 'reload')}
          >
            {embed.isLoading ? '✕' : '⟳'}
          </button>
          <button type="button" title="回到 ChatGPT 首页" disabled={taskRunning} onClick={() => window.api.sendEmbedCommand('home')}>
            ⌂
          </button>

          <form className="address" onSubmit={submitAddress}>
            <input
              className="address__input"
              value={address}
              spellCheck={false}
              readOnly
              placeholder="https://chatgpt.com/"
              aria-label="地址"
              onChange={(event) => setAddress(event.target.value)}
              onFocus={() => setEditing(true)}
              onBlur={() => setEditing(false)}
            />
          </form>

          {/*
            Which model this session is talking to, sitting immediately left of the gear so the
            gear stays the last thing in the bar. Both platforms' pages stay loaded, so this is
            a change of which one is in front — the SSH connection and the terminal are NOT
            rebuilt, and each site keeps its own conversation.

            A dropdown rather than a row of buttons: one-of-N is what a select is for, and the
            list is expected to grow.
          */}
          <div
            className={`model-picker${modelMenuOpen ? ' model-picker--open' : ''}`}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setModelMenuOpen(false)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                setModelMenuOpen(false)
              }
            }}
          >
            <button
              type="button"
              className="model-picker__trigger"
              aria-label="模型"
              aria-haspopup="listbox"
              aria-expanded={modelMenuOpen}
              disabled={taskRunning || switchingPlatform || platformId === ''}
              title={taskRunning ? '任务运行中不能切换模型' : '切换模型'}
              onClick={() => setModelMenuOpen((value) => !value)}
            >
              <span>{CHAT_PLATFORMS.find((platform) => platform.id === platformId)?.label || '模型'}</span>
              <svg viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1l4 4 4-4" /></svg>
            </button>
            {modelMenuOpen ? (
              <div className="model-picker__menu" role="listbox" aria-label="选择模型">
                {CHAT_PLATFORMS.map((platform) => (
                  <button
                    key={platform.id}
                    type="button"
                    role="option"
                    aria-selected={platform.id === platformId}
                    className={`model-picker__option${platform.id === platformId ? ' model-picker__option--active' : ''}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      setModelMenuOpen(false)
                      if (platform.id !== platformId) void switchPlatform(platform.id)
                    }}
                  >
                    <span>{platform.label}</span>
                    {platform.id === platformId ? <span className="model-picker__check">✓</span> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <button
            type="button"
            title="设置"
            aria-label="设置"
            className={settings?.embedProxy ? 'toolbar__settings toolbar__settings--on' : 'toolbar__settings'}
            onClick={() => setSettingsOpen((value) => !value)}
          >
            ⚙
          </button>
        </div>
      </header>

      <main className="stage">
        {/*
          The main process sizes the native chatgpt.com view to cover this box
          exactly, so nothing may overlap it — a native view always paints above
          the DOM and cannot be rounded or z-ordered.
        */}
        <div className="stage__slot" ref={slotRef}>
          <div className="stage__hint">
            <p className="stage__hint-title">正在加载 chatgpt.com …</p>
            <p className="stage__hint-sub">
              若长时间空白，通常是 Cloudflare 人机校验或该网络无法访问 chatgpt.com。
            </p>
          </div>
        </div>
      </main>

      <aside className={panelCollapsed ? 'panel panel--collapsed' : 'panel'}>
        {panelCollapsed ? null : (
          <div
            className="panel__resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整侧栏宽度"
            onPointerDown={startPanelResize}
          />
        )}
        <div className="panel__collapse-head">
          {panelCollapsed ? null : <span className="panel__title">侧栏</span>}
          <span className="panel__spacer" />
          <button
            type="button"
            className="panel__sync panel__collapse-button"
            title={panelCollapsed ? '展开右侧栏' : '折叠右侧栏'}
            aria-label={panelCollapsed ? '展开右侧栏' : '折叠右侧栏'}
            onClick={() => setPanelCollapsed((value) => !value)}
          >
            {panelCollapsed ? '«' : '»'}
          </button>
        </div>
        <div className="terminal-controls">
          <div className="terminal__row">
            <span className="terminal__label">终端模式</span>
            <span className={interceptor?.installed ? 'terminal__dot' : 'terminal__dot terminal__dot--wait'} />
            <span className="terminal__spacer" />
            <button
              type="button"
              role="switch"
              aria-checked={interceptor?.enabled ?? false}
              aria-label="终端模式"
              disabled={!interceptor}
              className={interceptor?.enabled ? 'switch switch--on' : 'switch'}
              onClick={() => void toggleInterceptor()}
            >
              <span className="switch__knob" />
            </button>
          </div>

          <p className="terminal__hint">
            {interceptor === null
              ? '正在读取状态…'
              : interceptor.enabled
                ? interceptor.installed
                  ? null
                  : '已开启，等待页面加载后生效'
                : '已关闭：消息按原样发送'}
          </p>

          <div className="mode" role="radiogroup" aria-label="执行模式">
            <button
              type="button"
              role="radio"
              aria-checked={automation !== null && !isAuto}
              className={automation !== null && !isAuto ? 'mode__item mode__item--on' : 'mode__item'}
              disabled={!automation}
              onClick={() => void setMode('manual')}
            >
              手动执行
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={isAuto === true}
              className={isAuto ? 'mode__item mode__item--on' : 'mode__item'}
              disabled={!automation}
              onClick={() => void setMode('auto')}
            >
              自动执行
            </button>
          </div>

          <p className="terminal__hint">
            {automation === null
              ? '正在读取设置…'
              : isAuto
                ? null
                : '手动执行：命令列在下方等你点「运行」，跑完的结果同样会发回给模型。'}
          </p>

          <div className="terminal__row terminal__row--gap">
            <button
              type="button"
              className={automation?.paused ? 'btn btn--danger' : 'btn'}
              disabled={!automation}
              onClick={() => void togglePaused()}
            >
              {automation?.paused ? '已暂停 · 恢复' : '暂停'}
            </button>
            <button
              type="button"
              className="btn btn--danger"
              disabled={!taskRunning}
              title="停止 ChatGPT 生成、终端命令和后续自动执行，并允许切换对话"
              onClick={() => void endTask()}
            >
              结束任务
            </button>
            <button
              type="button"
              className="btn"
              disabled={!conversationId || taskRunning}
              title="重新解析上一条回复，用于恢复中断的任务"
              onClick={() => void checkLastReply()}
            >
              检查上一条
            </button>
          </div>


          <div className="terminal__stats">
            <span className="terminal__count">已注入 {interceptor?.injectedCount ?? 0} 次</span>
            {waiting.length > 0 ? (
              <span className="terminal__count terminal__count--warn">{waiting.length} 条待处理</span>
            ) : null}
            {interceptor?.taskStartedAt != null ? (
              <span className="terminal__count terminal__count--time">
                任务耗时 {formatDuration((interceptor.taskFinishedAt ?? durationNow) - interceptor.taskStartedAt)}
              </span>
            ) : null}
          </div>

          {currentGoal ? (
            <p className="terminal__last" title={currentGoal}>
              当前的目标：{currentGoal}
            </p>
          ) : null}

          <div className="terminal__details">
            <button
              type="button"
              className="terminal__prompt-link"
              onClick={() => setPromptOpen(true)}
            >
              查看注入的提示词
            </button>
          </div>
        </div>

        <div className="panel__head">
          <span className="panel__title">对话记录</span>
          <span className="panel__count">{conversations.length}</span>
          <span className="panel__spacer" />
          {/* 同步按钮已隐藏 */}
        </div>

        {conversations.length === 0 ? (
          <p className="panel__empty">还没有记录。打开一个对话，或点「同步」从侧边栏导入。</p>
        ) : (
          <div className="panel__list">
            {conversationFolders.map((folder) => (
              <details
                key={folder.project?.id ?? '__unbound__'}
                className="conversation-folder"
                open
                onDragOver={(event) => {
                  if (!folder.project) return
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                }}
                onDrop={(event) => {
                  if (folder.project) void moveConversationToProject(event, folder.project.id)
                }}
              >
                <summary
                  className="conversation-folder__head"
                  title={folder.project?.path ?? '未绑定项目'}
                >
                  <span className="conversation-folder__icon">📁</span>
                  <span className="conversation-folder__name">
                    {folder.project?.name ?? '未绑定项目'}
                  </span>
                  <span className="conversation-folder__count">{folder.conversations.length}</span>
                </summary>
                <ul className="conversation-folder__list">
                  {folder.conversations.map((conversation) => {
                    const active = conversation.id === conversationId
                    const locked = taskRunning && !active
                    return (
                      <li key={conversation.id}>
                        <div
                          className={active ? 'conversation conversation--active' : 'conversation'}
                          role="button"
                          tabIndex={locked ? -1 : 0}
                          draggable={Boolean(conversation.project)}
                          aria-disabled={locked}
                          title={locked ? '任务进行中，结束任务后才能切换对话' : `${displayTitle(conversation)}\n${conversation.url}`}
                          onDragStart={(event) => {
                            event.dataTransfer.setData('text/plain', conversation.id)
                            event.dataTransfer.effectAllowed = 'move'
                          }}
                          onClick={() => {
                            if (!locked) void openConversation(conversation)
                          }}
                          onKeyDown={(event) => {
                            if (!locked && (event.key === 'Enter' || event.key === ' ')) {
                              event.preventDefault()
                              void openConversation(conversation)
                            }
                          }}
                        >
                          <span className="conversation__body">
                            <span className="conversation__title">{displayTitle(conversation)}</span>
                            <span className="conversation__time">{formatTime(conversation.updatedAt)}</span>
                          </span>
                          <button
                            type="button"
                            className="conversation__remove"
                            title="从数据库删除"
                            onClick={(event) => void removeConversation(event, conversation.id)}
                          >
                            ✕
                          </button>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </details>
            ))}
          </div>
        )}
      </aside>

      <section ref={toolboxPaneRef} className={terminalCollapsed ? 'terminal-pane terminal-pane--collapsed' : 'terminal-pane'}>
        <div className="terminal-pane__head">
          <span className="panel__title">终端</span>
          <span
            className={
              sshActive
                ? ssh?.status === 'connected'
                  ? 'terminal__dot'
                  : ssh?.status === 'error'
                    ? 'terminal__dot terminal__dot--error'
                    : 'terminal__dot terminal__dot--wait'
                : terminal?.alive
                  ? 'terminal__dot'
                  : 'terminal__dot terminal__dot--wait'
            }
          />
          <span className="panel__spacer" />
          {terminalCollapsed ? null : (
            <span className="panel__delay">
              <input
                type="text"
                className="panel__delay-input"
                inputMode="numeric"
                value={sendDelayDraft ?? String(terminal?.sendDelaySeconds ?? 0)}
                title="命令执行完成后，等待这么多秒再把结果回传给模型（0 表示立即发送）"
                aria-label="回传前的等待秒数"
                onChange={(event) => setSendDelayDraft(event.target.value)}
                onBlur={() => void commitSendDelay()}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    void commitSendDelay()
                  }
                  if (event.key === 'Escape') setSendDelayDraft(null)
                }}
              />
              <span className="panel__delay-unit">秒</span>
            </span>
          )}
          {terminalCollapsed ? null : (
            <button
              type="button"
              className="panel__sync"
              title="中断当前正在执行的命令"
              onClick={() => void interruptTerminal()}
            >
              中断
            </button>
          )}
          {terminalCollapsed ? null : sshActive ? (
            <>
              <button
                type="button"
                className="panel__sync"
                title="已保存的主机，打开连接窗口"
                onClick={() => setSshDialogOpen(true)}
              >
                切换
              </button>
              <button
                type="button"
                className="panel__sync"
                title="关闭 SSH 面板，回到本地终端"
                onClick={() => void dismissSsh()}
              >
                关闭
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="panel__sync"
                title="已保存的主机，打开连接窗口"
                onClick={() => setSshDialogOpen(true)}
              >
                SSH
              </button>
              <button type="button" className="panel__sync" onClick={() => void resetTerminal()}>
                重置
              </button>
            </>
          )}
          {terminalCollapsed ? null : (
            <Menu.Root onOpenChange={(open) => { if (open) setSshPickerOpen(false) }}>
              <Menu.Trigger className="panel__sync" title="打开工具箱">
                工具箱
              </Menu.Trigger>
              <Menu.Portal container={toolboxPaneRef}>
                <Menu.Positioner side="bottom" align="end" sideOffset={6} collisionPadding={8} collisionBoundary={toolboxPaneRef.current ?? undefined} className="toolbox-menu__positioner">
                  <Menu.Popup className="toolbox-menu">
                    <Menu.Item className="toolbox-menu__item" onClick={() => { setSshPickerOpen(false); setGitDialogOpen(true) }}>
                      <span className="toolbox-menu__icon">
                        <svg width="15" height="15" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg">
                          <rect x="18" y="18" width="84" height="84" rx="8" fill="#F05032" transform="rotate(45 60 60)" />
                          <path d="M45 38 L76 69" stroke="#FFFFFF" stroke-width="7" stroke-linecap="round" />
                          <path d="M59 52 L59 78" stroke="#FFFFFF" stroke-width="7" stroke-linecap="round" />
                          <circle cx="45" cy="38" r="7" fill="#FFFFFF" />
                          <circle cx="59" cy="52" r="7" fill="#FFFFFF" />
                          <circle cx="59" cy="80" r="7" fill="#FFFFFF" />
                          <circle cx="78" cy="71" r="7" fill="#FFFFFF" />
                        </svg>
                      </span>
                      <span>Git 管理</span>
                    </Menu.Item>
                  </Menu.Popup>
                </Menu.Positioner>
              </Menu.Portal>
            </Menu.Root>
          )}
          <button
            type="button"
            className="panel__sync"
            title={terminalCollapsed ? '展开终端' : '折叠终端'}
            onClick={() => {
              setTerminalCollapsed((value) => !value)
              // These live in the pane's flow, so they would simply vanish with it.
              setSshPickerOpen(false)
              setNotesOpen(false)
            }}
          >
            {terminalCollapsed ? '»' : '«'}
          </button>
        </div>

        {/*
          The host switcher.
          It sits in the pane's normal flow rather than floating over it: the pane
          is to the LEFT of the embedded page, which is a native view that always
          paints above the DOM, so anything spilling out of this column — a dropdown
          anchored to the header, say — would be swallowed by it.
        */}
        {terminalCollapsed ? null : sshActive ? (
          <div className="terminal-pane__meta">
            <span className="terminal-pane__id">{ssh?.name || 'SSH'}</span>
            {ssh?.status === 'connected' ? (
              cwdDraft !== null ? (
                <form className="terminal-pane__cwd-form" onSubmit={submitCwd}>
                  <input
                    className="terminal-pane__cwd-input"
                    value={cwdDraft}
                    spellCheck={false}
                    autoFocus
                    aria-label="SSH 工作目录"
                    onChange={(event) => setCwdDraft(event.target.value)}
                    onBlur={() => setCwdDraft(null)}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') setCwdDraft(null)
                    }}
                  />
                </form>
              ) : (
                <button
                  type="button"
                  className="terminal-pane__cwd"
                  title={`${ssh.modelCwd || '目录尚未确定'}\n点击编辑，回车切换目录`}
                  onClick={() => setCwdDraft(ssh.modelCwd ?? '')}
                >
                  {ssh.modelCwd || '设置目录…'}
                </button>
              )
            ) : (
              <span className="terminal-pane__cwd" title={ssh?.message}>{ssh?.message}</span>
            )}
            <button
              type="button"
              className="panel__sync"
              disabled={ssh?.status !== 'connected' || sshUploading}
              title={`上传本地文件到当前远程目录：${ssh?.modelCwd || '.'}`}
              onClick={() => void uploadSshFiles()}
            >
              {sshUploading ? '上传中…' : '上传'}
            </button>
            <button
              type="button"
              className={sshFilesOpen ? 'panel__sync panel__sync--on' : 'panel__sync'}
              disabled={ssh?.status !== 'connected'}
              title="浏览远程主机文件"
              onClick={() => setSshFilesOpen((value) => !value)}
            >
              文件
            </button>
            <button
              type="button"
              className={notesSet || notesOpen ? 'panel__sync panel__sync--on' : 'panel__sync'}
              title={`写一段只针对这台机器的说明，会拼在系统提示词后面${notesSet ? '（已设置）' : ''}`}
              onClick={() => setNotesOpen((value) => !value)}
            >
              说明{notesSet ? ' ●' : ''}
            </button>
          </div>
        ) : (
          <div className="terminal-pane__meta">
            <span className="terminal-pane__id">本机</span>
            {cwdDraft !== null ? (
              <form className="terminal-pane__cwd-form" onSubmit={submitCwd}>
                <input
                  className="terminal-pane__cwd-input"
                  value={cwdDraft}
                  spellCheck={false}
                  autoFocus
                  aria-label="终端目录"
                  onChange={(event) => setCwdDraft(event.target.value)}
                  onBlur={() => setCwdDraft(null)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') setCwdDraft(null)
                  }}
                />
              </form>
            ) : (
              <button
                type="button"
                className="terminal-pane__cwd"
                title={terminal?.cwd ? `${terminal.cwd}\n点击修改目录` : '设置终端目录'}
                onClick={() => setCwdDraft(terminal?.cwd ?? '')}
              >
                {terminal?.cwd || '设置目录…'}
              </button>
            )}
            <button
              type="button"
              className={notesSet || notesOpen ? 'panel__sync panel__sync--on' : 'panel__sync'}
              title={`写一段只针对这台机器的说明，会拼在系统提示词后面${notesSet ? '（已设置）' : ''}`}
              onClick={() => setNotesOpen((value) => !value)}
            >
              说明{notesSet ? ' ●' : ''}
            </button>
          </div>
        )}
        {/* Markdown note editor. The native embedded view is hidden while this modal is open. */}
        {terminalCollapsed || !notesOpen ? null : (
          <div
            className="modal modal--notes"
            role="dialog"
            aria-modal="true"
            aria-label="编辑补充说明"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setNotesOpen(false)
            }}
          >
            <div className="notes-modal" data-color-mode="light">
              <div className="notes-modal__head">
                <div className="notes-modal__heading">
                  <span className="notes-modal__title">发送给 GPT 的补充说明</span>
                  <span className="notes-modal__scope" title={notes?.label}>
                    {notes?.scope === 'ssh' ? `SSH · ${notes.label}` : '本机'}
                  </span>
                </div>
                <span className="panel__spacer" />
                <span className={notesDraft === (notes?.text ?? '') ? 'notes-modal__saved notes-modal__saved--ok' : 'notes-modal__saved'}>
                  <span>●</span>{notesDraft === (notes?.text ?? '') ? '已保存' : '未保存'}
                </span>
                <button type="button" className="notes-modal__close" aria-label="关闭" onClick={() => setNotesOpen(false)}>×</button>
              </div>

              <div className="notes-modal__editor-wrap">
                <div className="notes-modal__toolbar-mode">
                  <button
                    type="button"
                    className={notesPreview ? 'notes-modal__preview-toggle notes-modal__preview-toggle--on' : 'notes-modal__preview-toggle'}
                    onClick={() => setNotesPreview((value) => !value)}
                  >
                    ◉ {notesPreview ? '编辑' : '预览'}
                  </button>
                </div>
                <MDEditor
                  value={notesDraft}
                  preview={notesPreview ? 'preview' : 'edit'}
                  visibleDragbar={false}
                  commands={[
                    mdCommands.title,
                    mdCommands.divider,
                    mdCommands.bold,
                    mdCommands.italic,
                    mdCommands.strikethrough,
                    mdCommands.divider,
                    mdCommands.link,
                    mdCommands.code,
                    mdCommands.quote,
                    mdCommands.divider,
                    mdCommands.unorderedListCommand,
                    mdCommands.orderedListCommand,
                    mdCommands.divider,
                    mdCommands.image
                  ]}
                  extraCommands={[]}
                  textareaProps={{
                    placeholder: '继续输入补充说明…',
                    'aria-label': '补充说明 Markdown 编辑器'
                  }}
                  onChange={(value) => setNotesDraft(value ?? '')}
                />
              </div>

              <div className="notes-modal__foot">
                <button type="button" className="notes-modal__button" disabled={notesSaving || notesDraft === ''} onClick={() => setNotesDraft('')}>清空</button>
                <span className="panel__spacer" />
                <button type="button" className="notes-modal__button" onClick={() => setNotesOpen(false)}>取消</button>
                <button type="button" className="notes-modal__button notes-modal__button--primary" disabled={notesSaving || notes === null || notesDraft === (notes?.text ?? '')} onClick={() => void saveNotes()}>
                  {notesSaving ? '保存中…' : '保存'}
                </button>
              </div>
            </div>
          </div>
        )}
        {terminalCollapsed ? null : (
          <>
            {sshActive && sshFilesOpen ? (
              <div className="ssh-files">
                {sshFilesError ? <div className="ssh-files__error">{sshFilesError}</div> : null}
                <div className="ssh-files__browser">
                  {sshFilesLoading ? (
                    <div className="ssh-files__loading">正在读取远程文件…</div>
                  ) : (
                    <WillowDark>
                      <Filemanager
                        data={sshFileData}
                        readonly
                        mode="table"
                        preview={false}
                        icons="simple"
                        init={initSshFilemanager}
                      />
                    </WillowDark>
                  )}
                </div>
              </div>
            ) : (
              <>
            {/*
              The step the loop is on, on its own.

              The description was already being stored on every command and shown
              nowhere, and the command itself only existed as one line inside the
              scrollback — so "what is it doing right now, and why" meant reading
              back up through the terminal to find it.
            */}
            {currentExecution ? (
              <div className="current">
                <div className="current__head">
                  <span className={statusTone(currentExecution.status)}>
                    {STATUS_LABEL[currentExecution.status]}
                  </span>
                  <span
                    className="current__desc"
                    title={currentExecution.description || undefined}
                  >
                    {currentExecution.description || '（模型没有给出说明）'}
                  </span>
                  <span className="current__code">超时 {currentExecution.timeoutSeconds}s</span>
                  {currentExecution.exitCode !== null ? (
                    <span className="current__code">退出码 {currentExecution.exitCode}</span>
                  ) : null}
                </div>
                <pre className="current__command">{currentExecution.command || '（空命令）'}</pre>
              </div>
            ) : null}

            {waiting.length > 0 ? (
              <div className="pending">
                {waiting.map((record) => (
                  <div key={record.messageId} className="pending__item">
                    <span className={record.status === 'blocked' ? 'badge badge--warn' : 'badge'}>
                      {STATUS_LABEL[record.status]}
                    </span>
                    <code
                      className="pending__command"
                      title={
                        record.description
                          ? `${record.description}\n\n${record.command}`
                          : record.command
                      }
                    >
                      {record.command || '(空命令)'}
                    </code>
                    <span className="panel__spacer" />
                    <button
                      type="button"
                      className="panel__sync"
                      onClick={() => void runExecution(record.messageId)}
                    >
                      运行
                    </button>
                    <button
                      type="button"
                      className="panel__sync"
                      onClick={() => void skipExecution(record.messageId)}
                    >
                      跳过
                    </button>
                  </div>
                ))}
              </div>
            ) : null}

            <div className="terminal-pane__output" ref={terminalOutputRef}>
              {sshActive ? (
                (ssh?.lines.length ?? 0) === 0 ? (
                  <p className="terminal-pane__empty">{ssh?.message || '正在连接…'}</p>
                ) : (
                  ssh?.lines.map((line, index) => (
                    <pre key={index} className={`line line--${line.kind}`}>
                      {line.kind === 'command' ? `$ ${line.text}` : line.text}
                    </pre>
                  ))
                )
              ) : (terminal?.lines.length ?? 0) === 0 ? (
                <p className="terminal-pane__empty">
                  还没有输出。在下面直接输入命令，或让模型在这里执行。
                </p>
              ) : (
                terminal?.lines.map((line, index) => (
                  <pre key={index} className={`line line--${line.kind}`}>
                    {line.kind === 'command' ? `> ${line.text}` : line.text}
                  </pre>
                ))
              )}
            </div>

            <form className="terminal-pane__input" onSubmit={submitCommand}>
              <span className="terminal-pane__prompt">{sshActive ? '$' : '>'}</span>
              <input
                className="address__input"
                value={commandDraft}
                spellCheck={false}
                placeholder={
                  sshActive
                    ? ssh?.status === 'connected'
                      ? '输入命令，回车发送到远程主机'
                      : '尚未连接'
                    : '直接在本机执行命令（不经过模型）'
                }
                aria-label={sshActive ? 'SSH 命令' : '终端命令'}
                disabled={sshActive ? ssh?.status !== 'connected' : false}
                onChange={(event) => setCommandDraft(event.target.value)}
              />
            </form>
              </>
            )}
          </>
        )}

        <div
          className="terminal-pane__resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整终端宽度"
          onPointerDown={startResize}
        />
      </section>

      <footer className="statusbar">
        {externalAuth ? (
          <div className="auth-notice" role="status">
            <span className="auth-notice__text">
              {externalAuthProviderLabel} 登录在内嵌页面里被提供方拒绝（“此浏览器或应用可能不安全”），已改在系统浏览器打开。用邮箱/验证码可以直接在这里登录。
            </span>
            <button type="button" className="auth-notice__button" onClick={loginWithEmail}>
              改用邮箱登录
            </button>
            <button type="button" className="auth-notice__button" onClick={openChatgptExternal}>
              打开浏览器版 ChatGPT
            </button>
            <button
              type="button"
              className="auth-notice__close"
              aria-label="关闭登录提示"
              title="关闭登录提示"
              onClick={() => setExternalAuth(null)}
            >
              ×
            </button>
          </div>
        ) : null}
        <span className={embed.isLoading ? 'dot dot--busy' : 'dot'} />
        <span className="statusbar__title" title={embed.url}>
          {embed.title || embed.url || '未加载'}
        </span>
        {(ssh?.remoteExec ? ssh.modelCwd : terminal?.cwd) ? (
          <span
            className="statusbar__id"
            title={ssh?.remoteExec ? ssh.modelCwd : terminal?.cwd}
          >
            {ssh?.remoteExec ? ssh.modelCwd : terminal?.cwd}
          </span>
        ) : null}
        {isAuto ? (
          <span className="statusbar__mode">
            {automation?.paused ? '自动执行 · 已暂停' : '自动执行中'}
          </span>
        ) : null}
        {ssh?.remoteExec ? (
          <span className="statusbar__remote" title={`模型命令在 ${ssh.target} 上执行`}>
            远端执行 · {ssh.name || ssh.target}
          </span>
        ) : null}
        <span className="statusbar__spacer" />
      </footer>

        {/* Injected prompt viewer. Rendered as Markdown. */}
        {promptOpen ? (
          <div
            className="modal modal--prompt"
            role="dialog"
            aria-modal="true"
            aria-label="注入的提示词"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setPromptOpen(false)
            }}
          >
            <div className="prompt-modal" data-color-mode="light">
              <div className="prompt-modal__head">
                <span className="prompt-modal__icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" width="20" height="20"><path d="M7 3.75h7.7L19 8.05v12.2H7z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/><path d="M14.5 3.9v4.4h4.35M10 12h6M10 15.5h6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>
                </span>
                <span className="prompt-modal__title">注入的提示词</span>
                <span className="prompt-modal__readonly">只读</span>
                <span className="panel__spacer" />
                <button
                  type="button"
                  className={promptCopied ? 'prompt-modal__action prompt-modal__action--success' : 'prompt-modal__action'}
                  onClick={() => {
                    void navigator.clipboard.writeText(interceptor?.prefix.trim() || '').then(() => {
                      setPromptCopied(true)
                      window.setTimeout(() => setPromptCopied(false), 1600)
                    })
                  }}
                >
                  <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><rect x="8" y="8" width="10" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.8"/><path d="M15 8V6.5A1.5 1.5 0 0 0 13.5 5h-7A1.5 1.5 0 0 0 5 6.5v7A1.5 1.5 0 0 0 6.5 15H8" fill="none" stroke="currentColor" strokeWidth="1.8"/></svg>
                  {promptCopied ? '已复制' : '复制全部'}
                </button>
                <button
                  type="button"
                  className={promptSearchOpen ? 'prompt-modal__action prompt-modal__action--active' : 'prompt-modal__action'}
                  onClick={() => setPromptSearchOpen((value) => !value)}
                >
                  <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><circle cx="10.5" cy="10.5" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.8"/><path d="m15 15 4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>
                  查找
                </button>
                <button type="button" className="prompt-modal__close" aria-label="关闭" onClick={() => setPromptOpen(false)}>×</button>
              </div>

              {promptSearchOpen ? (
                <div className="prompt-modal__search">
                  <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><circle cx="10.5" cy="10.5" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.8"/><path d="m15 15 4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>
                  <input
                    autoFocus
                    value={promptSearch}
                    placeholder="在注入的提示词中查找…"
                    aria-label="查找注入的提示词"
                    onChange={(event) => setPromptSearch(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' || !promptSearch.trim()) return
                      event.preventDefault()
                      const find = (window as typeof window & { find?: (text: string, caseSensitive?: boolean, backwards?: boolean, wrapAround?: boolean, wholeWord?: boolean, searchInFrames?: boolean, showDialog?: boolean) => boolean }).find
                      find?.(promptSearch.trim(), false, event.shiftKey, true, false, false, false)
                    }}
                  />
                  <span className="prompt-modal__search-hint">Enter 下一个 · Shift+Enter 上一个</span>
                  <button type="button" aria-label="关闭查找" onClick={() => { setPromptSearchOpen(false); setPromptSearch('') }}>×</button>
                </div>
              ) : null}

              <div className="prompt-modal__body">
                <MDEditor.Markdown source={interceptor?.prefix.trim() || '（暂无注入内容）'} wrapperElement={{ 'data-color-mode': 'light' }} />
              </div>
              <div className="prompt-modal__scroll-hint" aria-hidden="true"><span>↓</span> 滚动查看更多</div>
            </div>
          </div>
        ) : null}      {settingsOpen ? (
        <div
          className="modal modal--settings"
          role="dialog"
          aria-modal="true"
          aria-label="设置"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setSettingsOpen(false)
          }}
        >
          <div className="modal__box settings-modal">
            <div className="settings-modal__head">
              <div className="settings-modal__title-icon">●</div>
              <div>
                <div className="settings-modal__title">设置</div>
                <div className="settings-modal__subtitle">外观、代理、更新和登录态</div>
              </div>
              <span className="panel__spacer" />
              <button type="button" className="settings-modal__close" aria-label="关闭" onClick={() => setSettingsOpen(false)}>×</button>
            </div>

            <div className="modal__body settings-modal__body">
              <section className="settings-card settings-appearance-card">
                <div className="settings-card__heading">
                  <span className="settings-card__icon">◐</span>
                  <span>外观</span>
                </div>
                <div className="settings-appearance-row">
                  <div>
                    <div className="settings-proxy-row__label">应用主题</div>
                    <small className="settings-appearance-hint">切换应用界面整体的明暗外观</small>
                  </div>
                  <select
                    className="settings-theme-select"
                    value={themeDraft}
                    aria-label="应用主题"
                    onChange={(event) => setThemeDraft(event.target.value as AppTheme)}
                  >
                    <option value="light">浅色</option>
                    <option value="dark">深色</option>
                  </select>
                </div>
              </section>

              <section className="settings-card">
                <div className="settings-card__heading">
                  <span className="settings-card__icon">◎</span>
                  <span>网络代理</span>
                </div>

                <div className="settings-proxy-row">
                  <label className="settings-proxy-row__label">ChatGPT 网页 <span className="settings-help">?</span></label>
                  <input className="address__input settings-input" value={proxyDraft} spellCheck={false} placeholder="http://127.0.0.1:7897" onChange={(event) => setProxyDraft(event.target.value)} />
                  <span className={`settings-state ${proxyDraft.trim() ? 'settings-state--ok' : ''}`}><i />{proxyDraft.trim() ? '已配置' : '未配置'}</span>
                  <button type="button" className="settings-copy" aria-label="复制 ChatGPT 网页代理" disabled={!proxyDraft.trim()} onClick={() => void navigator.clipboard.writeText(proxyDraft)}>⧉</button>
                </div>

                <div className="settings-proxy-row settings-proxy-row--with-hint">
                  <label className="settings-proxy-row__label">SSH 代理 <span className="settings-help">?</span><small>留空 = 直连</small></label>
                  <input className="address__input settings-input" value={sshProxyDraft} spellCheck={false} placeholder="http://127.0.0.1:7897" onChange={(event) => setSshProxyDraft(event.target.value)} />
                  <span className={`settings-state ${sshProxyDraft.trim() ? 'settings-state--ok' : ''}`}><i />{sshProxyDraft.trim() ? '已配置' : '未配置'}</span>
                  <button type="button" className="settings-copy" aria-label="复制 SSH 代理" disabled={!sshProxyDraft.trim()} onClick={() => void navigator.clipboard.writeText(sshProxyDraft)}>⧉</button>
                </div>

                <div className="settings-proxy-row">
                  <label className="settings-proxy-row__label">更新下载 <span className="settings-help">?</span></label>
                  <input className="address__input settings-input" value={updateProxyDraft} spellCheck={false} placeholder="http://127.0.0.1:7897" onChange={(event) => setUpdateProxyDraft(event.target.value)} />
                  <span className={`settings-state ${updateProxyDraft.trim() ? 'settings-state--ok' : ''}`}><i />{updateProxyDraft.trim() ? '已配置' : '未配置'}</span>
                  <button type="button" className="settings-copy" aria-label="复制更新代理" disabled={!updateProxyDraft.trim()} onClick={() => void navigator.clipboard.writeText(updateProxyDraft)}>⧉</button>
                </div>
              </section>

              <section className="settings-card settings-update-card">
                <div className="settings-card__heading">
                  <span className="settings-card__icon">⇩</span>
                  <span>应用更新</span>
                </div>
                <div className="settings-update-card__content">
                  <div className={`settings-update-status ${updateStatus?.phase === 'error' ? 'settings-update-status--warn' : ''}`}>
                    <span className="settings-update-check">✓</span>
                    <span>{updateStatus === null ? '正在读取更新状态…' : updateStatus.phase === 'checking' ? '正在检查更新…' : updateStatus.phase === 'available' ? `发现新版本 ${updateStatus.version}` : updateStatus.phase === 'downloading' ? `正在下载 ${updateStatus.percent}%…` : updateStatus.phase === 'downloaded' ? `新版本 ${updateStatus.version} 已下载` : updateStatus.phase === 'error' ? `更新出错：${updateStatus.message}` : updateStatus.message || '已是最新版本'}</span>
                  </div>
                  <div className="settings-update-actions">
                    <button type="button" className="settings-outline-btn" disabled={updateStatus !== null && (updateStatus.phase === 'checking' || updateStatus.phase === 'downloading')} onClick={() => void window.api.checkForUpdates()}>检查更新</button>
                    {updateStatus?.phase === 'available' ? <button type="button" className="settings-outline-btn" disabled={preparingDownload} onClick={() => { setPreparingDownload(true); void window.api.downloadUpdate().finally(() => setPreparingDownload(false)) }}>{preparingDownload ? <><span className="btn-spinner" />正在准备下载…</> : '下载更新'}</button> : null}
                    {updateStatus?.phase === 'downloaded' ? <button type="button" className="settings-outline-btn" onClick={() => void window.api.installUpdate()}>重启并安装</button> : null}
                  </div>
                </div>
              </section>

              <section className="settings-card settings-session-card">
                <div className="settings-card__heading">
                  <span className="settings-card__icon">▣</span>
                  <span>浏览器登录态</span>
                </div>
                <div className="settings-session-row">
                  <label>Cookie 名称</label>
                  <input className="address__input settings-input" value={sessionCookieName} spellCheck={false} onChange={(event) => setSessionCookieName(event.target.value)} />
                </div>
                <div className="settings-session-row settings-session-row--value">
                  <label>Cookie 值 / 整行 cookie</label>
                  <textarea className="address__input session-import__value settings-input" value={sessionCookieValue} spellCheck={false} autoComplete="off" rows={3} placeholder="粘贴整行 cookie，或只粘 Value 一列的内容" onChange={(event) => setSessionCookieValue(event.target.value)} />
                  <button type="button" className="settings-outline-btn settings-import-btn" disabled={importingSession || sessionCookieValue.trim() === ''} onClick={() => void submitSessionImport()}>{importingSession ? '导入中…' : '导入并重新加载'}</button>
                </div>
                <div className="settings-local-note">ⓘ 仅在本机处理，不会上传</div>
                {sessionImport ? <p className={sessionImport.signedIn || (sessionImportPhase === 'preview' && sessionImport.ok) ? 'settings-import-message' : 'settings-import-message settings-import-message--warn'}>{sessionImport.message}</p> : null}
              </section>
            </div>

            <div className="modal__foot settings-modal__foot">
              <span className="panel__spacer" />
              <button type="button" className="settings-cancel-btn" onClick={() => { setProxyDraft(settings?.embedProxy ?? ''); setSshProxyDraft(settings?.sshProxy ?? ''); setUpdateProxyDraft(settings?.updateProxy ?? ''); setThemeDraft(settings?.theme ?? 'light'); setSettingsOpen(false) }}>取消</button>
              <button type="button" className="settings-save-btn" disabled={savingSettings || settings === null} onClick={() => void saveSettings()}>{savingSettings ? '保存中…' : '保存并重新加载'}</button>
            </div>
          </div>
        </div>
      ) : null}
      {sshDialogOpen ? (
        <div
          className="modal ssh-connect-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="SSH 连接"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setSshDialogOpen(false)
          }}
        >
          <div className="ssh-connect-modal">
            <div className="ssh-connect__head">
              <span className="ssh-connect__title">SSH 连接</span>
              <span className="panel__spacer" />
              {sshLive ? (
                <button
                  type="button"
                  className="ssh-connect__disconnect"
                  title="结束当前连接，但保留屏幕上的记录"
                  onClick={() => { setSshDialogOpen(false); void disconnectSsh() }}
                >
                  断开当前连接
                </button>
              ) : null}
              <button type="button" className="ssh-connect__close" aria-label="关闭" onClick={() => setSshDialogOpen(false)}>×</button>
            </div>

            <div className="ssh-connect__content">
              <aside className="ssh-connect__sidebar">
                <h3 className="ssh-connect__section-title">已保存的主机</h3>
                <div className="ssh-connect__host-list">
                  {sshHosts.map((saved) => (
                    <div key={saved.id} className={sshDraft.id === saved.id ? 'ssh-connect__host ssh-connect__host--active' : 'ssh-connect__host'}>
                      <button
                        type="button"
                        className="ssh-connect__host-main"
                        onClick={() => setSshDraft({ id: saved.id, name: saved.name, host: saved.host, port: saved.port, username: saved.username, password: '', proxy: saved.proxy })}
                      >
                        <span className="ssh-connect__host-icon">▦</span>
                        <span className="ssh-connect__host-copy">
                          <strong>{saved.name}</strong>
                          <small>{saved.username}@{saved.host}:{saved.port}</small>
                        </span>
                        {saved.hasPassword ? <span className="ssh-connect__saved">已存密码</span> : null}
                      </button>
                      <button
                        type="button"
                        className="ssh-connect__host-connect"
                        title={saved.hasPassword ? `直接连接到 ${saved.name}` : `填写密码后连接 ${saved.name}`}
                        disabled={sshBusy}
                        onClick={() => { setSshDialogOpen(false); void switchSshHost(saved) }}
                      >
                        连接
                      </button>
                      <button type="button" className="ssh-connect__host-remove" aria-label={`删除 ${saved.name}`} onClick={() => void removeSshHost(saved.id)}>×</button>
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  className="ssh-connect__new"
                  onClick={() => setSshDraft({ id: null, name: '', host: '', port: 22, username: 'root', password: '', proxy: '' })}
                >
                  ＋ 新建主机
                </button>
              </aside>

              <form
                className="ssh-connect__form"
                onSubmit={(event) => {
                  event.preventDefault()
                  void connectSsh(sshDraft)
                }}
              >
                <div className="ssh-connect__form-body">
                  <h3 className="ssh-connect__section-title">连接信息</h3>

                  <label className="ssh-connect__field">
                    <span>显示名称</span>
                    <input className="ssh-connect__input" value={sshDraft.name} placeholder="我的服务器" onChange={(event) => setSshDraft({ ...sshDraft, name: event.target.value })} />
                  </label>

                  <div className="ssh-connect__row">
                    <label className="ssh-connect__field ssh-connect__field--grow">
                      <span>主机 / IP</span>
                      <input className="ssh-connect__input" value={sshDraft.host} spellCheck={false} placeholder="192.168.1.10" onChange={(event) => setSshDraft({ ...sshDraft, host: event.target.value })} />
                    </label>
                    <label className="ssh-connect__field ssh-connect__field--port">
                      <span>端口</span>
                      <input className="ssh-connect__input" type="number" min={1} max={65535} value={sshDraft.port} onChange={(event) => setSshDraft({ ...sshDraft, port: Number(event.target.value) })} />
                    </label>
                  </div>

                  <label className="ssh-connect__field">
                    <span>用户名</span>
                    <input className="ssh-connect__input" value={sshDraft.username} spellCheck={false} onChange={(event) => setSshDraft({ ...sshDraft, username: event.target.value })} />
                  </label>

                  <div className={sshAdvancedOpen ? 'ssh-connect__advanced ssh-connect__advanced--open' : 'ssh-connect__advanced'}>
                    <button type="button" className="ssh-connect__advanced-toggle" onClick={() => setSshAdvancedOpen((value) => !value)}>
                      <span className="ssh-connect__chevron">⌄</span>
                      高级选项
                    </button>
                    {sshAdvancedOpen ? (
                      <div className="ssh-connect__advanced-body">
                        <label className="ssh-connect__field">
                          <span>密码</span>
                          <input className="ssh-connect__input" type="password" value={sshDraft.password} placeholder="留空 = 使用这台主机已保存的密码" onChange={(event) => setSshDraft({ ...sshDraft, password: event.target.value })} />
                        </label>
                        <label className="ssh-connect__field">
                          <span>代理（可选）</span>
                          <input className="ssh-connect__input" value={sshDraft.proxy} spellCheck={false} placeholder="留空 = 使用设置里的 SSH 代理" onChange={(event) => setSshDraft({ ...sshDraft, proxy: event.target.value })} />
                        </label>
                      </div>
                    ) : null}
                  </div>
                </div>

                <div className="ssh-connect__foot">
                  <button type="button" className="ssh-connect__cancel" onClick={() => setSshDialogOpen(false)}>取消</button>
                  <button type="submit" className="ssh-connect__submit" disabled={sshBusy || sshDraft.host.trim() === '' || sshDraft.username.trim() === ''}>
                    {sshBusy ? '连接中…' : '连接'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      ) : null}
      <GitDialog open={gitDialogOpen} cwd={terminal?.cwd ?? ""} theme={settings?.theme ?? "light"} onClose={() => setGitDialogOpen(false)} />
    </div>
  )
}