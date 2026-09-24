import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, DragEvent as ReactDragEvent, FormEvent, JSX, MouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import { SESSION_COOKIE_NAME } from '@shared/types'
import { CHAT_PLATFORMS } from '@shared/platforms'
import type {
  AppInfo,
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
  SshState,
  TerminalNotes,
  TerminalState
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
}

export default function App({ initialSshDialogOpen = false, platformId = '' }: AppProps): JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [embed, setEmbed] = useState<EmbedState>(INITIAL_EMBED_STATE)
  const [externalAuth, setExternalAuth] = useState<ExternalAuthNotice | null>(null)
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [interceptor, setInterceptor] = useState<InterceptorStatus | null>(null)
  const [automation, setAutomation] = useState<AutomationState | null>(null)
  const [executions, setExecutions] = useState<ExecutionRecord[]>([])
  const [terminal, setTerminal] = useState<TerminalState | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [durationNow, setDurationNow] = useState(() => Date.now())
  const [address, setAddress] = useState('')
  const [editing, setEditing] = useState(false)
  const [terminalWidth, setTerminalWidth] = useState(TERMINAL_DEFAULT_WIDTH)
  const [terminalCollapsed, setTerminalCollapsed] = useState(false)
  const [panelCollapsed, setPanelCollapsed] = useState(false)
  const [switchingPlatform, setSwitchingPlatform] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [proxyDraft, setProxyDraft] = useState('')
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
  const [sshDialogOpen, setSshDialogOpen] = useState(initialSshDialogOpen)
  /** The quick host list, shown inside the terminal pane. */
  const [sshPickerOpen, setSshPickerOpen] = useState(false)
  const [sshBusy, setSshBusy] = useState(false)
  const [sshUploading, setSshUploading] = useState(false)
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
  const terminalOutputRef = useRef<HTMLDivElement>(null)
  /** scope:hostId of the note currently loaded into the editor. */
  const notesOwnerRef = useRef('')

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
  // Runtime info, kept as a working example of a renderer -> main IPC call.
  useEffect(() => {
    let cancelled = false

    window.api
      .getAppInfo()
      .then((value) => {
        if (!cancelled) setInfo(value)
      })
      .catch(() => {
        /* the status bar simply stays empty */
      })

    return () => {
      cancelled = true
    }
  }, [])

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
  const syncConversations = useCallback(async (): Promise<void> => {
    setSyncing(true)
    try {
      setConversations(await window.api.syncConversations())
    } catch {
      /* leave the previous list in place */
    } finally {
      setSyncing(false)
    }
  }, [])

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
        setSshProxyDraft(value.sshProxy)
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


  /**
   * The embedded page is a NATIVE view: it always paints above the DOM, so an
   * overlay alone would be hidden behind it. Hide the view while a dialog is up.
   */
  useEffect(() => {
    window.api.setEmbedVisible(!settingsOpen && !sshDialogOpen)
    window.api.setWorkspaceSshDialogOpen(sshDialogOpen)
  }, [settingsOpen, sshDialogOpen])

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
        embedProxy: proxyDraft,
        sshProxy: sshProxyDraft
      })
      setSettings(next)
      setProxyDraft(next.embedProxy)
      setSshProxyDraft(next.sshProxy)
      setSettingsOpen(false)
    } catch {
      /* leave the dialog open so the input is not lost */
    } finally {
      setSavingSettings(false)
    }
  }, [proxyDraft, sshProxyDraft])

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
    <div className={panelCollapsed ? 'app app--panel-collapsed' : 'app'} style={{ '--terminal-width': `${terminalWidth}px` } as CSSProperties}>
      <header className="topbar">
        <div className="brand">
          <span className="brand__mark">GPT</span>
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
          <select
            className="model-select"
            aria-label="模型"
            value={platformId}
            // Refused while a task is running: the main process enforces this too, and this is
            // only so the control does not look available when it is not.
            disabled={taskRunning || switchingPlatform || platformId === ''}
            title={taskRunning ? '任务运行中不能切换模型' : '切换模型'}
            onChange={(event) => void switchPlatform(event.target.value)}
          >
            {CHAT_PLATFORMS.map((platform) => (
              <option key={platform.id} value={platform.id}>
                {platform.label}
              </option>
            ))}
          </select>

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

          <details className="terminal__details">
            <summary>查看注入的提示词</summary>
            <pre className="terminal__prompt">{interceptor?.prefix.trim() || '…'}</pre>
          </details>
        </div>

        <div className="panel__head">
          <span className="panel__title">对话记录</span>
          <span className="panel__count">{conversations.length}</span>
          <span className="panel__spacer" />
          <button
            type="button"
            className="panel__sync"
            title="从 ChatGPT 侧边栏同步"
            disabled={syncing}
            onClick={() => void syncConversations()}
          >
            {syncing ? '同步中…' : '同步'}
          </button>
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

      <section className={terminalCollapsed ? 'terminal-pane terminal-pane--collapsed' : 'terminal-pane'}>
        <div className="terminal-pane__head">
          {sshActive ? null : <span className="panel__title">终端</span>}
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
                className={sshPickerOpen ? 'panel__sync panel__sync--on' : 'panel__sync'}
                title="切换到另一台已保存的主机"
                onClick={() => setSshPickerOpen((value) => !value)}
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
                className={sshPickerOpen ? 'panel__sync panel__sync--on' : 'panel__sync'}
                title="已保存的主机，点一下直接连接"
                onClick={() => setSshPickerOpen((value) => !value)}
              >
                SSH
              </button>
              <button type="button" className="panel__sync" onClick={() => void resetTerminal()}>
                重置
              </button>
            </>
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
        {terminalCollapsed || !sshPickerOpen ? null : (
          <div className="ssh-switch">
            <div className="ssh-switch__head">
              <span className="field__label">已保存的主机</span>
              <span className="panel__spacer" />
              <button
                type="button"
                className="panel__sync"
                title="打开连接表单，也可以在这里修改或删除已保存的主机"
                onClick={() => {
                  setSshPickerOpen(false)
                  setSshDialogOpen(true)
                }}
              >
                新建 / 管理
              </button>
            </div>

            {sshHosts.length === 0 ? (
              <p className="ssh-switch__empty">
                还没有保存的主机。点「新建 / 管理」添加一台 —— 连接成功后会记住，下次点一下就能切回来。
              </p>
            ) : (
              <ul className="ssh-list">
                {sshHosts.map((saved) => {
                  const here = sshLive && ssh?.hostId === saved.id
                  return (
                    <li key={saved.id} className="ssh-list__item">
                      <button
                        type="button"
                        className={here ? 'ssh-list__pick ssh-list__pick--active' : 'ssh-list__pick'}
                        disabled={sshBusy}
                        title={
                          here
                            ? `当前就在这里：${saved.name}`
                            : saved.hasPassword
                              ? `连接到 ${saved.name}（使用已保存的密码）`
                              : `打开表单填写密码后连接 ${saved.name}`
                        }
                        onClick={() => void switchSshHost(saved)}
                      >
                        <span className="ssh-list__name">{here ? `● ${saved.name}` : saved.name}</span>
                        <span className="ssh-list__target">
                          {saved.username}@{saved.host}:{saved.port}
                        </span>
                        <span
                          className={saved.hasPassword ? 'ssh-list__lock' : 'ssh-list__lock ssh-list__lock--warn'}
                        >
                          {saved.hasPassword ? '一键连接' : '需输密码'}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}

            <div className="ssh-switch__foot">
              {sshLive ? (
                <button
                  type="button"
                  className="panel__sync"
                  title="结束当前连接，但保留屏幕上的记录"
                  onClick={() => {
                    setSshPickerOpen(false)
                    void disconnectSsh()
                  }}
                >
                  断开当前连接
                </button>
              ) : null}
              <span className="panel__spacer" />
              <span className="ssh-switch__note">切换会断开当前会话</span>
            </div>
          </div>
        )}

        {terminalCollapsed ? null : sshActive ? (
          <div className="terminal-pane__meta">
            <span className="terminal-pane__id">{ssh?.name || 'SSH'}</span>
            <span
              className={ssh?.remoteExec ? 'badge badge--remote' : 'badge'}
              title={
                ssh?.remoteExec
                  ? `模型发出的命令在这台主机上执行\n模型 shell 的工作目录：${ssh.modelCwd || '尚未确定'}`
                  : '命令通道未就绪——模型命令目前仍在本地机器上执行'
              }
            >
              {ssh?.remoteExec ? '模型命令在此执行' : '模型命令仍在本地'}
            </span>
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

        {/*
          The per-machine note editor.
          In the pane's normal flow, like the host switcher, because the embedded
          page is a native view that would swallow anything floating over the stage.
        */}
        {terminalCollapsed || !notesOpen ? null : (
          <div className="notes">
            <div className="notes__head">
              <span className="field__label">发送给 GPT 的补充说明</span>
              <span className="panel__spacer" />
              <span className="notes__owner" title={notes?.label}>
                {notes?.scope === 'ssh' ? `SSH · ${notes.label}` : '本机'}
              </span>
            </div>

            <textarea
              className="notes__input"
              value={notesDraft}
              rows={5}
              spellCheck={false}
              placeholder={
                '只针对这台机器的事实和约定，例如：\n项目在 /srv/app，用 docker compose 部署\n不要动 /data 目录'
              }
              aria-label="补充说明"
              onChange={(event) => setNotesDraft(event.target.value)}
            />

            <p className="notes__hint">
              会拼在系统提示词最后，冲突时以它为准。每台机器各存一份，留空 = 不补充。
            </p>

            <div className="notes__foot">
              <button
                type="button"
                className="panel__sync"
                disabled={notesSaving || notesDraft === ''}
                onClick={() => setNotesDraft('')}
              >
                清空
              </button>
              <span className="panel__spacer" />
              <button
                type="button"
                className="panel__sync"
                onClick={() => setNotesOpen(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn--primary btn--inline"
                disabled={notesSaving || notes === null}
                onClick={() => void saveNotes()}
              >
                {notesSaving ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        )}

        {terminalCollapsed ? null : (
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
        <span className="statusbar__meta">
          {info
            ? `Electron ${info.electron} · Chromium ${info.chrome} · ${
                info.usingDevServer ? 'dev server' : 'bundled'
              }`
            : '…'}
        </span>
      </footer>

      {settingsOpen ? (
        <div
          className="modal"
          role="dialog"
          aria-modal="true"
          aria-label="设置"
          // Only a click on the backdrop itself dismisses, not one that started
          // inside the box and drifted out.
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setSettingsOpen(false)
          }}
        >
          <div className="modal__box">
            <div className="modal__head">
              <span className="panel__title">设置</span>
              <span className="panel__spacer" />
              <button
                type="button"
                className="panel__sync"
                aria-label="关闭"
                onClick={() => setSettingsOpen(false)}
              >
                ✕
              </button>
            </div>

            <div className="modal__body">
              <label className="field">
                <span className="field__label">ChatGPT 网页代理</span>
                <input
                  className="address__input"
                  value={proxyDraft}
                  spellCheck={false}
                  placeholder="http://127.0.0.1:7890　（留空 = 直连）"
                  onChange={(event) => setProxyDraft(event.target.value)}
                />
              </label>
              <p className="field__hint">
                以 <code>http://</code> 开头；只写 <code>127.0.0.1:7890</code> 也会自动补上。
              </p>

              <label className="field">
                <span className="field__label">SSH 代理</span>
                <input
                  className="address__input"
                  value={sshProxyDraft}
                  spellCheck={false}
                  placeholder="http://127.0.0.1:7897　（留空 = 直连）"
                  onChange={(event) => setSshProxyDraft(event.target.value)}
                />
              </label>

              <div className="field">
                <span className="field__label">从浏览器导入登录态</span>
                <p className="field__hint">
                  给<strong>无法在应用内登录</strong>的账号用：用 Google 创建的 ChatGPT
                  账号没有密码，而 Google 会拒绝一切内嵌浏览器登录（
                  <code>此浏览器或应用可能不安全</code>），系统浏览器里的登录态又不会自动回流。
                  唯一能搬进来的是<strong>会话令牌本身</strong>。
                </p>
                <p className="field__hint">
                  在已登录 ChatGPT 的浏览器里：<code>F12</code> → <code>Network</code> →
                  刷新页面 → 点最上面那条 <code>chatgpt.com</code> 请求 → 
                  <code>Request Headers</code> 里找到 <code>cookie:</code> 一整行复制。
                  整行直接粘进下面的框即可，会自动挑出会话令牌。
                </p>
                <p className="field__hint">
                  <strong>令牌可能被分成两块</strong>（NextAuth 在 cookie 超过约 4 KB
                  时会切成 <code>.0</code> 和 <code>.1</code>）。那种情况下
                  <strong>两块都要粘进来</strong>——只给一块的话服务端解不开。
                  上面的整行复制天然包含两块，所以优先用那个取法。
                </p>
                <p className="field__hint field__hint--warn">
                  这是把<strong>登录凭据</strong>交给本应用。会话令牌是 bearer 凭据：
                  谁拿到它谁就能以你的身份登录，<strong>不需要密码、也不会触发异常登录告警</strong>。
                  <strong>只粘进这个框</strong>——不要贴到任何聊天窗口、笔记或截图里。
                  Chrome 的 cookie 数据库是 App-Bound Encryption 加密的，任何程序都无法替你自动读取，
                  所以只能手工复制这一次。导完记得清一下剪贴板（Windows 的
                  <code>Win+V</code> 剪贴板历史也要清）。
                </p>

                <label className="field">
                  <span className="field__label">Cookie 名称（粘贴整行时可留默认值）</span>
                  <input
                    className="address__input"
                    value={sessionCookieName}
                    spellCheck={false}
                    onChange={(event) => setSessionCookieName(event.target.value)}
                  />
                </label>
                <label className="field">
                  <span className="field__label">Cookie 值 / 整行 cookie</span>
                  <textarea
                    className="address__input session-import__value"
                    value={sessionCookieValue}
                    spellCheck={false}
                    autoComplete="off"
                    rows={3}
                    placeholder="粘贴整行 cookie，或只粘 Value 一列的内容"
                    onChange={(event) => setSessionCookieValue(event.target.value)}
                  />
                </label>

                <div className="field-row">
                  <button
                    type="button"
                    className="btn btn--primary btn--inline"
                    disabled={importingSession || sessionCookieValue.trim() === ''}
                    onClick={() => void submitSessionImport()}
                  >
                    {importingSession ? '导入中…' : '导入并重新加载'}
                  </button>
                  <span className="panel__spacer" />
                </div>

                {sessionImport ? (
                  <p
                    className={
                      /*
                       * A preview that fails to parse IS a problem (the paste is wrong),
                       * and so is a finished import that left the page signed out. Only
                       * two things are neutral: a preview that parsed, and an import
                       * that actually signed in.
                       */
                      sessionImport.signedIn || (sessionImportPhase === 'preview' && sessionImport.ok)
                        ? 'field__hint'
                        : 'field__hint field__hint--warn'
                    }
                  >
                    {sessionImport.message}
                  </p>
                ) : null}
              </div>
            </div>

            {/*
              Outside `.modal__body` on purpose: the body is the scroll container, so
              a footer inside it scrolls away — and 保存 is the one control the user
              must be able to reach without hunting for it.
            */}
            <div className="modal__foot">
              <span className="panel__spacer" />
              <button
                type="button"
                className="panel__sync"
                onClick={() => {
                  setProxyDraft(settings?.embedProxy ?? '')
                  setSettingsOpen(false)
                }}
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn--primary btn--inline"
                disabled={savingSettings || settings === null}
                onClick={() => void saveSettings()}
              >
                {savingSettings ? '保存中…' : '保存并重新加载'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {sshDialogOpen ? (
        <div
          className="modal"
          role="dialog"
          aria-modal="true"
          aria-label="SSH 连接"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setSshDialogOpen(false)
          }}
        >
          <div className="modal__box">
            <div className="modal__head">
              <span className="panel__title">SSH 连接</span>
              <span className="panel__spacer" />
              <button
                type="button"
                className="panel__sync"
                aria-label="关闭"
                onClick={() => setSshDialogOpen(false)}
              >
                ✕
              </button>
            </div>

            <div className="modal__body">
              {sshHosts.length > 0 ? (
                <div className="field">
                  <span className="field__label">已保存的主机（点击填入）</span>
                  <ul className="ssh-list">
                    {sshHosts.map((saved) => (
                      <li key={saved.id} className="ssh-list__item">
                        <button
                          type="button"
                          className="ssh-list__pick"
                          title={`使用 ${saved.name}`}
                          onClick={() =>
                            setSshDraft({
                              id: saved.id,
                              name: saved.name,
                              host: saved.host,
                              port: saved.port,
                              username: saved.username,
                              password: '',
                              proxy: saved.proxy
                            })
                          }
                        >
                          <span className="ssh-list__name">{saved.name}</span>
                          <span className="ssh-list__target">
                            {saved.username}@{saved.host}:{saved.port}
                          </span>
                          {saved.hasPassword ? <span className="ssh-list__lock">已存密码</span> : null}
                        </button>
                        <button
                          type="button"
                          className="conversation__remove"
                          title="删除这台主机"
                          onClick={() => void removeSshHost(saved.id)}
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  void connectSsh(sshDraft)
                }}
              >
                <label className="field">
                  <span className="field__label">显示名称</span>
                  <input
                    className="address__input"
                    value={sshDraft.name}
                    placeholder="我的服务器"
                    onChange={(event) => setSshDraft({ ...sshDraft, name: event.target.value })}
                  />
                </label>

                <div className="field-row">
                  <label className="field field--grow">
                    <span className="field__label">主机 / IP</span>
                    <input
                      className="address__input"
                      value={sshDraft.host}
                      spellCheck={false}
                      placeholder="192.168.1.10"
                      onChange={(event) => setSshDraft({ ...sshDraft, host: event.target.value })}
                    />
                  </label>
                  <label className="field field--port">
                    <span className="field__label">端口</span>
                    <input
                      className="address__input"
                      type="number"
                      min={1}
                      max={65535}
                      value={sshDraft.port}
                      onChange={(event) =>
                        setSshDraft({ ...sshDraft, port: Number(event.target.value) })
                      }
                    />
                  </label>
                </div>

                <label className="field">
                  <span className="field__label">用户名</span>
                  <input
                    className="address__input"
                    value={sshDraft.username}
                    spellCheck={false}
                    onChange={(event) => setSshDraft({ ...sshDraft, username: event.target.value })}
                  />
                </label>

                <label className="field">
                  <span className="field__label">密码</span>
                  <input
                    className="address__input"
                    type="password"
                    value={sshDraft.password}
                    placeholder="留空 = 使用这台主机已保存的密码"
                    onChange={(event) => setSshDraft({ ...sshDraft, password: event.target.value })}
                  />
                </label>

                <label className="field">
                  <span className="field__label">代理（可选）</span>
                  <input
                    className="address__input"
                    value={sshDraft.proxy}
                    spellCheck={false}
                    placeholder="留空 = 使用设置里的 SSH 代理"
                    onChange={(event) => setSshDraft({ ...sshDraft, proxy: event.target.value })}
                  />
                </label>

                <p className="field__hint">
                  密码经系统凭据加密后存入本机数据库；系统不支持加密时**不会保存**，下次连接需重新输入。
                </p>
                <p className="field__hint field__hint--warn">
                  <strong>SSH 和 ChatGPT 网页用的是两个不同的代理设置</strong>，
                  各有各的用途，互不影响。
                </p>

                <div className="modal__foot">
                  <span className="panel__spacer" />
                  <button
                    type="button"
                    className="panel__sync"
                    onClick={() => setSshDialogOpen(false)}
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    className="btn btn--primary btn--inline"
                    disabled={
                      sshBusy ||
                      sshDraft.host.trim() === '' ||
                      sshDraft.username.trim() === ''
                    }
                  >
                    {sshBusy ? '连接中…' : '连接'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
