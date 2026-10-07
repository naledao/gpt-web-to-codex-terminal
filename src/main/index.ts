import { join, posix } from 'node:path'
import { appendFileSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, screen, session, shell, Tray } from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import {
  EMBED_LOGIN_URL,
  FALLBACK_ENVIRONMENT,
  IpcChannels,
  isConversationId
} from '../shared/types'
import { readGitDiff, readGitLog } from './git'
import { CHAT_PLATFORMS, CHATGPT_PLATFORM, DEFAULT_PLATFORM_ID, platformById } from '../shared/platforms'
import type { ChatPlatform } from '../shared/platforms'
import type {
  AppInfo,
  AppSettings,
  AppSettingsPatch,
  AppTheme,
  AutomationState,
  Conversation,
  ConversationMessage,
  EmbedAuthState,
  EmbedBounds,
  EmbedCommand,
  EmbedState,
  ExecutionMode,
  ExecutionRecord,
  GitFileDiff,
  GitLogResult,
  InterceptorStatus,
  ManagedSessionSummary,
  WorkspaceState,
  SessionImportDraft,
  SessionImportResult,
  SshHost,
  SshHostDraft,
  SshDownloadTask,
  SshUploadTask,
  SshTransferDirection,
  SshTransferTask,
  SshFileEntry,
  SshState,
  TerminalNotes,
  TerminalNotesOwner,
  TerminalState,

  MysqlConnectionDraft,
  MysqlConnectionsState,
  MysqlDatabaseList,
  MysqlTableData,
  MysqlTableDdl,
  MysqlTableList,
  MysqlSaveResult,
  UpdateStatus,
  NacosViewState
} from '../shared/types'
import { embedAuthState, importCookieSet, importSessionToken, previewSessionImport } from './session-import'
import { ConversationStore } from './db'
import { EMPTY_SSH_STATE, SessionRuntime } from './session-runtime'
import { installAppLog, installNetLog } from './app-log'
import { EMPTY_NACOS_VIEW_STATE } from '../shared/types'
import { NacosView } from './nacos-view'
import { applyUpdateProxy, checkForUpdates, downloadUpdate, getUpdateStatus, installUpdate, setUpdaterBroadcast, startUpdateSchedule } from './updater'

/*
 * Before anything else, so a failure during startup is itself recorded.
 *
 * Both are off unless their flag is set. `installNetLog` must run before the network service
 * starts, which is why it lives here rather than inside `whenReady`.
 */
const netLogFile = installNetLog()
const appLogFile = installAppLog()

/*
 * Stop Chromium from dialling hosts that a platform declares unreachable from this machine.
 *
 * `hif-dliq.deepseek.com` is IPv6-only and this machine has no IPv6 route, so the page's
 * background beacon to it failed every ~6.5s and Chromium printed a `net_error -100` line that
 * names no host — 24 of them in one 149-second run, all from that one destination. Nothing the
 * app can do makes the host reachable; it can only stop asking. See the field's comment on
 * `ChatPlatform` for why it is declared there, and for when to delete it.
 *
 * Must run before `app.whenReady()`, like the net log: the host resolver is built during
 * startup and this switch is read once.
 */
const unresolvableHosts = CHAT_PLATFORMS.flatMap((platform) => platform.unresolvableHosts)
if (unresolvableHosts.length > 0) {
  const rules = unresolvableHosts.map((host) => `MAP ${host} ~NOTFOUND`).join(', ')
  // `appendArgument` rather than `appendSwitch`: the rule text contains spaces, and
  // `--host-resolver-rules=MAP a ~NOTFOUND` has to stay ONE command-line token.
  app.commandLine.appendArgument(`--host-resolver-rules=${rules}`)
}

const rendererDevServerUrl = process.env['ELECTRON_RENDERER_URL']
const isDev = !app.isPackaged
const SETTING_EXECUTION_MODE = 'executionMode'
const SETTING_THEME = 'theme'
/**
 * The pre-per-platform embed proxy key.
 *
 * Kept only so an existing installation is not silently reset to "no proxy" the first time this
 * version runs. Everything now lives under one key PER PLATFORM (`embedProxy:claude`), because a
 * single shared value cannot say "chatgpt.com goes through the proxy, claude.ai goes direct" —
 * and those are different destinations that routinely need different routes.
 */
const SETTING_EMBED_PROXY_LEGACY = 'embedProxy'
const embedProxyKey = (platformId: string): string => `embedProxy:${platformId}`
const SETTING_SSH_PROXY = 'sshProxy'
const SETTING_UPDATE_PROXY = 'updateProxy'
const SETTING_USER_AVATAR = 'userAvatarDataUrl'
const SETTING_USER_AVATAR_SOURCE = 'userAvatarSourceDataUrl'
const SETTING_USER_AVATAR_POSITION_X = 'userAvatarPositionX'
const SETTING_USER_AVATAR_POSITION_Y = 'userAvatarPositionY'
const SETTING_USER_AVATAR_SCALE = 'userAvatarScale'
const SETTING_LOCAL_MACHINE_ID = 'localMachineId'
const SETTING_WORKSPACE_SESSION_ID = 'workspaceSessionId'
const SETTING_WORKSPACE_OPEN_SSH_DIALOG = 'workspaceOpenSshDialog'

function readAvatarPosition(value: string | null): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : 50
}

function readAvatarScale(value: string | null): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(1, Math.min(4, parsed)) : 1
}

let managerWindow: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
let store: ConversationStore | null = null
let localMachineId = ''
let settings: AppSettings = { theme: 'light', embedProxy: {}, sshProxy: '', updateProxy: '', userAvatarDataUrl: '', userAvatarSourceDataUrl: '', userAvatarPositionX: 50, userAvatarPositionY: 50, userAvatarScale: 1 }
const runtimes = new Map<string, SessionRuntime>()
let currentSessionId: string | null = null
let workspaceOpenSshDialog = false

/** The user's own Nacos console, shown inside the window on demand. Null until first opened. */
let nacosView: NacosView | null = null

/*
 * The startup splash.
 *
 * WHY A SEPARATE WINDOW RATHER THAN AN OVERLAY
 * -------------------------------------------
 * The chat page is a native `WebContentsView` layered ON TOP of the renderer, so a DOM
 * overlay in the main window would be painted UNDER it - the animation would be invisible
 * exactly while it is needed. A second BrowserWindow also runs in its own renderer process,
 * which is what keeps the animation smooth while the main process is busy probing the
 * machine, opening the database, and starting the first page load.
 *
 * It is a plain static HTML file with no script: all the motion is CSS, so there is nothing
 * to fail at the moment it matters.
 */
let splashWindow: BrowserWindow | null = null
let splashClosing = false
let splashReady = false
let splashShownAt: number | null = null
let splashCloseRequested = false
/** Fallback timer, cleared as soon as the splash closes for the normal reason. */
let splashFallbackTimer: ReturnType<typeof setTimeout> | null = null
let splashCloseTimer: ReturnType<typeof setTimeout> | null = null
let managerReadyToShow = false

const SPLASH_WIDTH = 380
const SPLASH_HEIGHT = 264
/** Keep the animation visible for at least three seconds, even when the page is cached. */
const SPLASH_MIN_VISIBLE_MS = 3_000
/**
 * Hard ceiling on how long the splash may stay up.
 *
 * The normal exit is the first `did-stop-loading` of the visible chat view. That event never
 * fires when the page cannot be reached at all, and without this the splash would sit on top
 * of an otherwise working app forever. Deliberately generous: the splash is only wrong when
 * it outlives the thing it is covering.
 */
const SPLASH_MAX_MS = 20_000

function showManagerWhenReady(): void {
  if (!managerReadyToShow || !managerWindow || managerWindow.isDestroyed()) return
  /*
   * The splash is still up, so the main window must stay hidden. Do NOT clear
   * managerReadyToShow here: the flag is the record that the window is ready to be
   * revealed, and it has to survive until the splash is actually gone.
   */
  if (splashWindow && !splashClosing) return
  managerReadyToShow = false
  /*
   * Focus here rather than at every call site: the splash has just disappeared, and the
   * user's next action is aimed at the window underneath it.
   */
  if (managerWindow.isMinimized()) managerWindow.restore()
  managerWindow.show()
  managerWindow.focus()
}

function createSplashWindow(): void {
  if (splashWindow && !splashWindow.isDestroyed()) return

  splashClosing = false
  splashReady = false
  splashShownAt = null
  splashCloseRequested = false
  if (splashCloseTimer) {
    clearTimeout(splashCloseTimer)
    splashCloseTimer = null
  }

  const workArea = screen.getPrimaryDisplay().workAreaSize
  const window = new BrowserWindow({
    width: SPLASH_WIDTH,
    height: SPLASH_HEIGHT,
    x: Math.round((workArea.width - SPLASH_WIDTH) / 2),
    y: Math.round((workArea.height - SPLASH_HEIGHT) / 2),
    frame: false,
    title: '',
    titleBarStyle: 'hidden',
    titleBarOverlay: false,
    // The page's rounded card supplies per-pixel alpha. A native setShape()
    // region would hard-clip its antialiased edge, especially at high DPI.
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  splashWindow = window
  window.setBounds({
    x: Math.round((workArea.width - SPLASH_WIDTH) / 2),
    y: Math.round((workArea.height - SPLASH_HEIGHT) / 2),
    width: SPLASH_WIDTH,
    height: SPLASH_HEIGHT
  })
  window.setResizable(false)
  window.setMaximizable(false)

  // `showInactive` so the splash never takes focus from the window that is still loading
  // behind it: stealing focus would make the main window's first paint look like a flash.
  // Some transparent Windows builds do not emit `ready-to-show`, so `did-finish-load` is
  // also a valid reveal signal. The guard makes the two events harmless when both fire.
  const revealSplash = (): void => {
    if (splashWindow !== window || window.isDestroyed() || splashReady) return
    splashReady = true
    splashShownAt = Date.now()
    window.showInactive()
    if (splashCloseRequested) closeSplashWindow()
  }
  window.once('ready-to-show', revealSplash)
  window.webContents.once('did-finish-load', revealSplash)
  window.on('closed', () => {
    if (splashWindow === window) splashWindow = null
    showManagerWhenReady()
  })

  // Keep the splash independent from the renderer's main route. In dev mode the workspace
  // still uses Vite/HMR, but the startup window always loads this standalone document.
  const splashPath = isDev
    ? join(app.getAppPath(), 'src/renderer/splash.html')
    : join(__dirname, '../renderer/splash.html')
  console.info(`[splash] opening separate ${SPLASH_WIDTH}x${SPLASH_HEIGHT} window`)
  /*
   * The palette has to be decided BEFORE the first paint, so the theme travels as a query
   * parameter rather than as a message after load: a push would arrive one frame too late
   * and the user would see the splash paint dark and then flip to light.
   *
   * settings is already populated from the database at this point (see the settings load
   * above), so this is the same value the workspace itself is about to render with.
   */
  void window.loadFile(splashPath, { query: { theme: settings.theme } })

  splashFallbackTimer = setTimeout(() => {
    splashFallbackTimer = null
    if (splashClosing) return
    console.warn('[splash] the chat view never reported a finished load; closing on the fallback timer')
    closeSplashWindow(true)
  }, SPLASH_MAX_MS)
}

/**
 * Fade the splash out and destroy it.
 *
 * Idempotent, and safe to call when no splash exists: the only cost of a spurious call is
 * that a later `createSplashWindow` finds nothing to close.
 */
function closeSplashWindow(force = false): void {
  if (splashClosing) return

  const window = splashWindow
  if (!window || window.isDestroyed()) {
    splashWindow = null
    return
  }

  // The embedded page can finish before the splash has painted its first frame. Keep the
  // request pending until the splash is visible; otherwise fast dev-mode loads make the
  // animation disappear completely.
  if (!force) {
    splashCloseRequested = true
    if (!splashReady || splashShownAt === null) return

    const remaining = SPLASH_MIN_VISIBLE_MS - (Date.now() - splashShownAt)
    if (remaining > 0) {
      if (!splashCloseTimer) {
        splashCloseTimer = setTimeout(() => {
          splashCloseTimer = null
          closeSplashWindow(true)
        }, remaining)
      }
      return
    }
  }

  splashClosing = true
  splashCloseRequested = false
  if (splashFallbackTimer) {
    clearTimeout(splashFallbackTimer)
    splashFallbackTimer = null
  }
  if (splashCloseTimer) {
    clearTimeout(splashCloseTimer)
    splashCloseTimer = null
  }
  splashWindow = null

  /*
   * Fade, then destroy.
   *
   * `setOpacity` is a no-op on a transparent window under some Windows builds, which is why
   * the fade is best-effort and the destroy below is unconditional - a splash that refuses
   * to leave is worse than one that leaves abruptly.
   */
  const startedAt = Date.now()
  const duration = 220
  const startOpacity = (() => {
    try {
      return window.getOpacity()
    } catch {
      return 1
    }
  })()

  const timer = setInterval(() => {
    if (window.isDestroyed()) {
      clearInterval(timer)
      splashClosing = false
      showManagerWhenReady()
      return
    }
    const progress = Math.min(1, (Date.now() - startedAt) / duration)
    try {
      window.setOpacity(startOpacity * (1 - progress))
    } catch {
      /* opacity unsupported here; fall through to the destroy below */
    }
    if (progress >= 1) {
      clearInterval(timer)
      window.destroy()
    }
  }, 16)
  window.once('closed', () => {
    clearInterval(timer)
    /*
     * The splash is genuinely gone now, so the 'in transition' flag has to be cleared.
     * Leaving it set would make every LATER reveal (a tray click, a macOS activate) look
     * like a startup that is still animating, and the main window would never show again.
     */
    splashClosing = false
    showManagerWhenReady()
  })
}

/*
 * The splash covers the app, so it must never outlive it.
 *
 * `destroy` rather than `close`: a close could be intercepted, and quitting is not the
 * moment to negotiate.
 */
function destroySplashWindow(): void {
  if (splashFallbackTimer) {
    clearTimeout(splashFallbackTimer)
    splashFallbackTimer = null
  }
  if (splashCloseTimer) {
    clearTimeout(splashCloseTimer)
    splashCloseTimer = null
  }
  splashClosing = true
  splashCloseRequested = false
  const window = splashWindow
  splashWindow = null
  if (window && !window.isDestroyed()) window.destroy()
}
const EMPTY_EMBED_STATE: EmbedState = {
  url: '',
  title: '',
  isLoading: false,
  canGoBack: false,
  canGoForward: false,
  conversationId: null,
  botCheckSince: null
}

const FALLBACK_INTERCEPTOR_STATE: InterceptorStatus = {
  enabled: false,
  promptInjectionEnabled: true,
  installed: false,
  injectedCount: 0,
  lastSentText: null,
  taskStartedAt: null,
  taskFinishedAt: null,
  pendingQuestion: null,
  basePrompt: '',
  toolPrompt: '',
  prefix: ''
}

const FALLBACK_AUTOMATION: AutomationState = { mode: 'manual', paused: true }
const FALLBACK_TERMINAL_STATE: TerminalState = { alive: false, cwd: '', lines: [], sendDelaySeconds: 0 }
const EMPTY_NOTES: TerminalNotes = { scope: 'local', hostId: '', directoryKey: '', directory: '', label: '', text: '', legacyText: '' }
const EMPTY_MYSQL: MysqlConnectionsState = { machineLabel: '', connections: [] }

function normalizeProxy(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '') return ''
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
}

/**
 * Read each platform's proxy, migrating a single-platform setting the first time.
 *
 * The migration WRITES, rather than carrying the old value in memory on every start. That makes
 * it a one-time event: the keys exist afterwards, so the branch cannot run again, a platform
 * added later starts with no proxy instead of inheriting this one, and the log line below means
 * what it says instead of repeating on every launch.
 *
 * The legacy key is left in place rather than deleted — a downgrade would otherwise lose the
 * setting — but it is never read again once any per-platform key exists.
 */
function readEmbedProxies(store: {
  getSetting(key: string): string | null
  setSetting(key: string, value: string): void
}): Record<string, string> {
  const proxies: Record<string, string> = {}
  let anyStored = false

  for (const platform of CHAT_PLATFORMS) {
    const stored = store.getSetting(embedProxyKey(platform.id))
    if (stored !== null) {
      anyStored = true
      proxies[platform.id] = stored
    } else {
      proxies[platform.id] = ''
    }
  }

  if (anyStored) return proxies

  const legacy = store.getSetting(SETTING_EMBED_PROXY_LEGACY) ?? ''
  if (legacy === '') return proxies

  console.info(
    `[settings] migrating the single embed proxy to ${CHAT_PLATFORMS.length} per-platform keys`
  )
  for (const platform of CHAT_PLATFORMS) {
    proxies[platform.id] = legacy
    store.setSetting(embedProxyKey(platform.id), legacy)
  }
  return proxies
}

async function applyEmbedProxy(proxies: Record<string, string>): Promise<void> {
  /*
   * One session per platform, so each is set from ITS OWN value.
   *
   * This used to apply one shared value to every platform — which is why it carried a comment
   * about "the proxy works for ChatGPT but not DeepSeek" being half-applied configuration. Now
   * that the values are separate, a partial application is a real thing the user asked for
   * rather than a bug, and the log below says which platform got what.
   */
  for (const platform of CHAT_PLATFORMS) {
    const proxy = proxies[platform.id] ?? ''
    const embedSession = session.fromPartition(platform.partition)
    try {
      if (proxy === '') await embedSession.setProxy({ mode: 'direct' })
      else await embedSession.setProxy({ proxyRules: proxy })
      await embedSession.closeAllConnections()
    } catch (error) {
      console.warn(`[settings] failed to apply embed proxy to ${platform.id}:`, (error as Error).message)
    }
  }
}

/**
 * Apply the app theme to Chromium itself, and to every embedded page.
 *
 * WHY `nativeTheme.themeSource` IS THE MAIN HALF OF THIS
 * -----------------------------------------------------
 * The app's own UI is themed with CSS variables and does not care. The EMBEDDED pages are
 * third-party sites that decide their own colours from `prefers-color-scheme`, which until
 * now reported the OPERATING SYSTEM — so switching this app to dark left every chat page
 * light, and there was nothing to see in a log, because no request, no DOM read and no state
 * anywhere in the app depends on it.
 *
 * `themeSource` is the one lever that reaches all of them at once. Electron's own docs are
 * explicit that setting it makes "the `prefers-color-scheme` CSS query match" the chosen
 * mode, and it is applied process-wide, so the four partitions cannot disagree.
 *
 * The second half is per page: a site whose appearance is PINNED to an explicit light/dark in
 * its own account settings ignores the media query entirely. That is what the injected theme
 * script is for — see `ChatGptEmbed.setTheme`.
 */
function applyAppTheme(theme: AppTheme): void {
  nativeTheme.themeSource = theme

  console.info(
    `[theme] app theme is ${theme}; embedded pages now answer prefers-color-scheme: ${theme} ` +
      `(shouldUseDarkColors=${nativeTheme.shouldUseDarkColors} views=${runtimes.size})`
  )

  for (const runtime of runtimes.values()) runtime.setTheme(theme)
}

function managedSessions(): ManagedSessionSummary[] {
  return [...runtimes.values()]
    .map((runtime) => runtime.summary())
    .sort((a, b) => a.createdAt - b.createdAt)
}

function broadcastManagedSessions(): void {
  if (!managerWindow || managerWindow.isDestroyed()) return
  managerWindow.webContents.send(IpcChannels.managerSessionsChanged, managedSessions())
}

function sshTransfers(): SshTransferTask[] {
  const items: SshTransferTask[] = []
  for (const runtime of runtimes.values()) {
    for (const task of runtime.ssh.getUploads()) {
      items.push({ sessionId: runtime.id, direction: 'upload', ...task })
    }
    for (const task of runtime.ssh.getDownloads()) {
      items.push({ sessionId: runtime.id, direction: 'download', ...task })
    }
  }
  return items.sort((a, b) => b.startedAt - a.startedAt)
}

function broadcastSshTransfers(): void {
  if (!managerWindow || managerWindow.isDestroyed()) return
  managerWindow.webContents.send(IpcChannels.sshTransfersChanged, sshTransfers())
}

function workspaceState(): WorkspaceState {
  return {
    view: currentSessionId ? 'session' : 'manager',
    sessionId: currentSessionId,
    openSshDialog: workspaceOpenSshDialog
  }
}

function broadcastWorkspaceState(): void {
  if (!managerWindow || managerWindow.isDestroyed()) return
  managerWindow.webContents.send(IpcChannels.workspaceChanged, workspaceState())
}

function persistWorkspaceState(): void {
  if (!store) return
  store.setSetting(SETTING_WORKSPACE_SESSION_ID, currentSessionId ?? '')
  store.setSetting(SETTING_WORKSPACE_OPEN_SSH_DIALOG, workspaceOpenSshDialog ? '1' : '0')
}

function showWorkspaceManager(): boolean {
  const firstId = runtimes.keys().next().value as string | undefined
  if (firstId) return selectSession(firstId)
  return createSession('local', true) !== null
}

function selectSession(id: string, openSshDialog = false): boolean {
  const runtime = runtimes.get(id)
  if (!runtime) return false
  if (currentSessionId && currentSessionId !== id) runtimes.get(currentSessionId)?.setActive(false)
  currentSessionId = id
  workspaceOpenSshDialog = openSshDialog
  runtime.setActive(true)
  persistWorkspaceState()
  broadcastWorkspaceState()
  if (managerWindow && !managerWindow.isDestroyed()) {
    /*
     * Two different situations reach this line, and they need different handling.
     *
     * During startup the splash is still up, so a bare show() here would put the main
     * window on screen mid-animation - the exact flash this whole mechanism exists to
     * avoid. Defer to showManagerWhenReady, which reveals it once the splash is gone.
     *
     * After startup (the user picked a session from the tray, or switched sessions) there
     * is no splash and this must stay an immediate show-and-focus, or the window would
     * appear to ignore the click.
     */
    if (splashWindow) {
      showManagerWhenReady()
    } else {
      if (managerWindow.isMinimized()) managerWindow.restore()
      managerWindow.show()
      managerWindow.focus()
    }
  }
  return true
}

function runtimeForEvent(event: IpcMainEvent | IpcMainInvokeEvent): SessionRuntime | null {
  if (!managerWindow || managerWindow.isDestroyed() || event.sender !== managerWindow.webContents) return null
  return currentSessionId ? runtimes.get(currentSessionId) ?? null : null
}

function isManagerEvent(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return Boolean(managerWindow && !managerWindow.isDestroyed() && event.sender === managerWindow.webContents)
}
/**
 * The Nacos console view, created on first use and kept for the window's lifetime.
 *
 * Lazy rather than eager: most sessions never open it, and a WebContentsView costs a
 * whole renderer process whether or not anyone looks at it.
 */
function nacosForWindow(window: BrowserWindow): NacosView {
  if (!nacosView) {
    nacosView = new NacosView({
      onState: (state): void => {
        if (!window.isDestroyed()) window.webContents.send(IpcChannels.nacosState, state)
      }
    })
  }
  return nacosView
}


function persistManagedSession(runtime: SessionRuntime): void {
  if (!store) return
  // A late async event (e.g. the SSH socket's close handler firing after dispose) can still
  // reach here with an already-torn-down runtime. Persisting it would read its cleared
  // embeds and throw, so drop the write instead.
  if (runtime.isDisposed()) return
  store.upsertManagedSession(runtime.persistentState())
}
function createSession(
  kind: 'local' | 'ssh' = 'local',
  activate = true,
  restored?: ReturnType<ConversationStore['listManagedSessions']>[number],
  platform: ChatPlatform = CHATGPT_PLATFORM
): SessionRuntime | null {
  if (!store) return null
  const savedMode = store.getSetting(SETTING_EXECUTION_MODE)
  const initialMode: ExecutionMode = savedMode === 'auto' ? 'auto' : 'manual'
  let runtime: SessionRuntime | null = null
  runtime = new SessionRuntime({
    platform,
    id: restored?.id,
    createdAt: restored?.createdAt,
    customTitle: restored?.title,
    initialUrl: restored?.url || undefined,
    initialConversationId: restored?.conversationId ?? null,
    initialPaused: restored?.paused ?? false,
    initialPromptInjectionEnabled: restored?.promptInjectionEnabled ?? true,
    initialLocalCwd: restored?.localCwd ?? '',
    initialSshHostId: restored?.sshHostId ?? '',
    initialSshAttached: restored?.sshAttached ?? false,
    initialSshReconnect: restored?.sshReconnect ?? false,
    initialSshCwd: restored?.sshCwd ?? '',
    initialSendDelaySeconds: restored?.sendDelaySeconds ?? 3,
    store,
    localMachineId,
    initialMode,
    settings: () => ({ ...settings }),
    onSummaryChanged: () => {
      if (runtime) persistManagedSession(runtime)
      broadcastManagedSessions()
    },
    onTransfersChanged: broadcastSshTransfers,
    onTerminalNotesSaved: (owner) => {
      for (const other of runtimes.values()) other.refreshTerminalNotesForOwner(owner)
    },
    onActivate: (id) => { selectSession(id) },
    /*
     * Ends the startup splash. Only the session the user is actually shown reports here,
     * so a restored-but-background session cannot end the animation early.
     */
    onEmbedReady: () => closeSplashWindow()
  })
  runtimes.set(runtime.id, runtime)
  persistManagedSession(runtime)
  // One line per session, naming the site and the URL: when two platforms are embedded at
  // once, "which view is failing" is the first question a log has to be able to answer.
  console.info(
    `[session] created ${runtime.id.slice(0, 8)} platform=${platform.id} url=${restored?.url || platform.homeUrl}`
  )
  if (managerWindow && !managerWindow.isDestroyed()) runtime.attach(managerWindow)
  broadcastManagedSessions()
  if (activate) selectSession(runtime.id, kind === 'ssh')
  return runtime
}

function destroySession(id: string): boolean {
  const runtime = runtimes.get(id)
  if (!runtime) return false

  const wasCurrent = currentSessionId === id
  if (wasCurrent) {
    currentSessionId = null
    workspaceOpenSshDialog = false
  }

  runtimes.delete(id)
  store?.removeManagedSession(id)
  runtime.dispose()
  broadcastManagedSessions()
  broadcastSshTransfers()
  if (wasCurrent) {
    const nextId = runtimes.keys().next().value as string | undefined
    if (nextId) selectSession(nextId)
    else createSession('local', true)
  }
  return true
}

function createTray(): void {
  if (tray) return

  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'tray-icon.png')
    : join(app.getAppPath(), 'build', 'icon.png')

  tray = new Tray(iconPath)
  tray.setToolTip(app.getName())
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => createManagerWindow() },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        quitting = true
        app.quit()
      }
    }
  ]))
  tray.on('click', () => createManagerWindow())
}

function createManagerWindow(): void {
  if (managerWindow && !managerWindow.isDestroyed()) {
    if (managerWindow.isMinimized()) managerWindow.restore()
    managerWindow.show()
    managerWindow.focus()
    return
  }

  const windowIconPath = app.isPackaged
    ? join(process.resourcesPath, 'tray-icon.png')
    : join(app.getAppPath(), 'build', 'icon.png')

  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1040,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0e14',
    icon: windowIconPath,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  managerWindow = window
  managerReadyToShow = false
  window.once('ready-to-show', () => {
    managerReadyToShow = true
    // Keep the main window completely hidden while the separate, frameless splash
    // window is visible. This prevents its native title bar from flashing first.
    // Wait for the fade to finish, not merely for the window to be destroyed: the main
    // window appearing under a half-faded splash is the same flash, just slower.
    if (!splashWindow && !splashClosing) showManagerWhenReady()
  })
  window.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    window.hide()
  })
  window.on('closed', () => {
    for (const runtime of runtimes.values()) runtime.dispose()
    runtimes.clear()
    currentSessionId = null
    workspaceOpenSshDialog = false
    // The console view is a child of THIS window, so it dies with it; dropping the
    // reference keeps a destroyed WebContentsView from being reused after a reopen.
    nacosView = null
    managerReadyToShow = false
    managerWindow = null
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) {
      event.preventDefault()
      void shell.openExternal(url)
    }
  })

  if (rendererDevServerUrl) void window.loadURL(rendererDevServerUrl)
  else void window.loadFile(join(__dirname, '../renderer/index.html'))
}

function registerIpcHandlers(): void {
  const fromManager = (event: IpcMainEvent | IpcMainInvokeEvent): boolean =>
    managerWindow !== null && !managerWindow.isDestroyed() && event.sender === managerWindow.webContents

  ipcMain.handle(IpcChannels.gitLog, async (_event, cwd: string): Promise<GitLogResult> => readGitLog(cwd))

  ipcMain.handle(
    IpcChannels.gitDiff,
    async (_event, cwd: string, path: string): Promise<GitFileDiff> => readGitDiff(cwd, path)
  )

  ipcMain.handle(IpcChannels.getAppInfo, (): AppInfo => ({
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    v8: process.versions.v8,
    platform: process.platform,
    arch: process.arch,
    isDev,
    usingDevServer: Boolean(rendererDevServerUrl),
    userDataPath: app.getPath('userData')
  }))

  ipcMain.handle(IpcChannels.managerSessionsList, (event): ManagedSessionSummary[] =>
    fromManager(event) ? managedSessions() : []
  )
  ipcMain.handle(IpcChannels.workspaceGetState, (event): WorkspaceState =>
    fromManager(event) ? workspaceState() : { view: 'manager', sessionId: null, openSshDialog: false }
  )
  ipcMain.handle(IpcChannels.workspaceShowManager, (event): boolean =>
    fromManager(event) ? showWorkspaceManager() : false
  )
  ipcMain.on(IpcChannels.workspaceSetOpenSshDialog, (event, open: boolean) => {
    if (!fromManager(event) || !currentSessionId) return
    workspaceOpenSshDialog = Boolean(open)
    persistWorkspaceState()
  })
  ipcMain.handle(IpcChannels.sshTransfersGet, (event): SshTransferTask[] =>
    fromManager(event) ? sshTransfers() : [])
  ipcMain.handle(
    IpcChannels.sshTransferCancel,
    (event, sessionId: string, direction: SshTransferDirection, id: string): boolean => {
      if (!fromManager(event)) return false
      const runtime = runtimes.get(String(sessionId ?? ''))
      if (!runtime) return false
      return direction === 'upload'
        ? runtime.ssh.cancelUpload(String(id ?? ''))
        : direction === 'download'
          ? runtime.ssh.cancelDownload(String(id ?? ''))
          : false
    }
  )

  ipcMain.handle(
    IpcChannels.managerSessionCreate,
    (event, kind: string): ManagedSessionSummary | null => {
      if (!fromManager(event)) return null
      /*
       * No platform parameter: a session is created for a purpose (this machine, or a host over
       * SSH) and the model is switched inside the chat. `DEFAULT_PLATFORM_ID` is used rather
       * than a literal so the default lives with the platform registry.
       */
      const runtime = createSession(
        kind === 'ssh' ? 'ssh' : 'local',
        true,
        undefined,
        platformById(DEFAULT_PLATFORM_ID) ?? CHATGPT_PLATFORM
      )
      return runtime?.summary() ?? null
    }
  )
  ipcMain.handle(IpcChannels.managerSessionOpen, (event, id: string): boolean => {
    if (!fromManager(event)) return false
    return selectSession(String(id))
  })
  ipcMain.handle(IpcChannels.managerSessionRename, (event, id: string, title: string): boolean => {
    if (!fromManager(event)) return false
    const runtime = runtimes.get(String(id))
    if (!runtime) return false
    runtime.setTitle(String(title))
    return true
  })
  ipcMain.handle(IpcChannels.managerSessionDestroy, (event, id: string): boolean => {
    if (!fromManager(event)) return false
    return destroySession(String(id))
  })
  ipcMain.handle(
    IpcChannels.sessionShowModelMenu,
    (event, currentId: string, anchor?: { x: number; y: number }): Promise<string | null> =>
      new Promise((resolve) => {
        const win = BrowserWindow.fromWebContents(event.sender)
        if (!win) {
          resolve(null)
          return
        }
        let settled = false
        const settle = (value: string | null): void => {
          if (settled) return
          settled = true
          resolve(value)
        }
        const menu = Menu.buildFromTemplate(
          CHAT_PLATFORMS.map((platform) => ({
            label: platform.label,
            type: 'radio' as const,
            checked: platform.id === currentId,
            click: () => settle(platform.id)
          }))
        )
        menu.popup({ window: win, ...(anchor && Number.isFinite(anchor.x) && Number.isFinite(anchor.y) ? { x: Math.round(anchor.x), y: Math.round(anchor.y) } : {}), callback: () => settle(null) })
      })
  )

  ipcMain.handle(IpcChannels.sessionSwitchPlatform, (event, platformId: string): boolean => {
    if (!fromManager(event)) return false
    const runtime = currentSessionId === null ? undefined : runtimes.get(currentSessionId)
    if (!runtime) return false
    /*
     * Only ids in the registry are accepted. Unlike session creation there is no sensible
     * fallback here: silently showing a different site than the one asked for would look like
     * the switch button doing nothing.
     */
    const platform = platformById(String(platformId ?? ''))
    if (!platform) return false
    const switched = runtime.switchPlatform(platform.id)
    // Persist immediately: the stored platformId/url is what a restart reopens, and a switch
    // that is not written back would come back as the old site.
    if (switched) persistManagedSession(runtime)
    return switched
  })

  ipcMain.on(IpcChannels.embedSetBounds, (event, bounds: EmbedBounds) => runtimeForEvent(event)?.setEmbedBounds(bounds))
  ipcMain.on(IpcChannels.embedSetVisible, (event, visible: boolean) => runtimeForEvent(event)?.setEmbedVisible(Boolean(visible)))
  ipcMain.on(IpcChannels.embedCommand, (event, command: EmbedCommand) => runtimeForEvent(event)?.sendEmbedCommand(command))
  ipcMain.on(IpcChannels.embedNavigate, (event, url: string) => runtimeForEvent(event)?.navigateEmbed(String(url)))
  ipcMain.handle(IpcChannels.embedGetState, (event): EmbedState => runtimeForEvent(event)?.embed.getState() ?? EMPTY_EMBED_STATE)
  ipcMain.on(IpcChannels.embedLoginWithEmail, (event) => runtimeForEvent(event)?.embed.navigate(EMBED_LOGIN_URL))
  ipcMain.handle(IpcChannels.embedImportSession, async (event, platformId: string, draft: SessionImportDraft): Promise<SessionImportResult> => {
    const runtime = runtimeForEvent(event)
    const platform = platformById(String(platformId ?? '')) ?? runtime?.chatPlatform
    if (!platform) return { ok: false, message: '请求不是来自应用窗口。', signedIn: false }
    /*
     * The TARGET PLATFORM comes from the argument, not from whichever session is in front.
     *
     * A partition belongs to a platform and every session of that platform shares it, so a login
     * state is global — routing by active session made the destination depend on which tab
     * happened to be visible, which is not a property of the login at all.
     *
     * The VIEW, separately, is only needed to confirm the result, so it is used when the session
     * in front happens to be showing the same platform and skipped otherwise. Writing is what
     * matters; verification is a bonus that must not decide the routing.
     */
    const contents = runtime && runtime.chatPlatform.id === platform.id ? runtime.embed.contents() : null
    return importSessionToken(platform, draft, contents, () => runtime?.embed.reloadAndWait() ?? Promise.resolve())
  })
  ipcMain.handle(IpcChannels.embedImportCookieSet, async (event, platformId: string, raw: string): Promise<SessionImportResult> => {
    const runtime = runtimeForEvent(event)
    const platform = platformById(String(platformId ?? '')) ?? runtime?.chatPlatform
    if (!platform) return { ok: false, message: '请求不是来自应用窗口。', signedIn: false }
    const contents = runtime && runtime.chatPlatform.id === platform.id ? runtime.embed.contents() : null
    return importCookieSet(platform, String(raw ?? ''), contents, () => runtime?.embed.reloadAndWait() ?? Promise.resolve())
  })
  ipcMain.handle(IpcChannels.embedPreviewSession, (event, draft: SessionImportDraft): SessionImportResult => {
    if (!runtimeForEvent(event)) return { ok: false, message: '请求不是来自应用窗口。', signedIn: false }
    return previewSessionImport(draft)
  })
  ipcMain.handle(IpcChannels.embedGetAuthState, async (event): Promise<EmbedAuthState> => {
    const runtime = runtimeForEvent(event)
    return runtime
      ? embedAuthState(runtime.chatPlatform, runtime.embed.contents())
      : { signedIn: false, cookieNames: [] }
  })

  /*
   * The Nacos console: the user's own server, embedded as a native view.
   *
   * Simpler than the chat embed by design — no scraping, no interception, no injected
   * script — so the whole surface is an address, a rectangle and four navigation buttons.
   */
  ipcMain.handle(IpcChannels.nacosOpen, async (event, url: string): Promise<NacosViewState> => {
    const window = managerWindow
    if (!window || window.isDestroyed() || event.sender !== window.webContents) return EMPTY_NACOS_VIEW_STATE
    const view = nacosForWindow(window)
    view.setTheme(settings.theme)
    await view.open(window, String(url))
    return view.getState()
  })
  ipcMain.handle(IpcChannels.nacosNavigate, async (event, url: string): Promise<NacosViewState> => {
    const window = managerWindow
    if (!window || window.isDestroyed() || event.sender !== window.webContents) return EMPTY_NACOS_VIEW_STATE
    const view = nacosForWindow(window)
    await view.open(window, String(url))
    return view.getState()
  })
  ipcMain.on(IpcChannels.nacosCommand, (event, command: EmbedCommand) => {
    const window = managerWindow
    if (!window || window.isDestroyed() || event.sender !== window.webContents) return
    nacosForWindow(window).command(command)
  })
  ipcMain.on(IpcChannels.nacosSetBounds, (event, bounds: EmbedBounds) => {
    const window = managerWindow
    if (!window || window.isDestroyed() || event.sender !== window.webContents) return
    nacosForWindow(window).setBounds(bounds)
  })
  ipcMain.on(IpcChannels.nacosSetVisible, (event, visible: boolean) => {
    const window = managerWindow
    if (!window || window.isDestroyed() || event.sender !== window.webContents) return
    nacosForWindow(window).setVisible(Boolean(visible))
  })
  ipcMain.handle(IpcChannels.nacosGetState, (event): NacosViewState => {
    const window = managerWindow
    if (!window || window.isDestroyed() || event.sender !== window.webContents) return EMPTY_NACOS_VIEW_STATE
    return nacosView ? nacosView.getState() : EMPTY_NACOS_VIEW_STATE
  })
  ipcMain.handle(IpcChannels.nacosClose, async (event): Promise<NacosViewState> => {
    const window = managerWindow
    if (!window || window.isDestroyed() || event.sender !== window.webContents) return EMPTY_NACOS_VIEW_STATE
    nacosView?.destroy(window)
    return EMPTY_NACOS_VIEW_STATE
  })
  ipcMain.on(IpcChannels.openChatgptExternal, (event) => {
    const runtime = runtimeForEvent(event)
    // The active session's OWN site: opening chatgpt.com from a DeepSeek session would
    // send the user somewhere they are not working.
    if (runtime) void shell.openExternal(runtime.chatPlatform.homeUrl)
  })

  ipcMain.handle(IpcChannels.conversationsList, (event): Conversation[] => runtimeForEvent(event)?.currentMachineConversations() ?? [])
  ipcMain.handle(IpcChannels.conversationMessagesList, (event, conversationId: string): ConversationMessage[] => {
    if (!runtimeForEvent(event) || !store) return []
    const id = typeof conversationId === 'string' ? conversationId : ''
    return id === '' ? [] : store.listConversationMessages(id)
  })
  ipcMain.handle(IpcChannels.conversationAttachmentRead, (event, attachmentId: string): string | null => {
    if (!runtimeForEvent(event) || !store) return null
    const id = typeof attachmentId === 'string' ? attachmentId : ''
    return id === '' ? null : store.readConversationAttachment(id)
  })

  ipcMain.handle(IpcChannels.conversationsSync, async (event): Promise<Conversation[]> => runtimeForEvent(event)?.refreshFromSidebar() ?? [])
  ipcMain.handle(IpcChannels.conversationsRemove, (event, id: string): Conversation[] => {
    const runtime = runtimeForEvent(event)
    if (!runtime || !store) return []
    store.remove(String(id))
    return runtime.currentMachineConversations()
  })
  ipcMain.handle(IpcChannels.conversationsMove, (event, id: string, projectId: string): Conversation[] => {
    const runtime = runtimeForEvent(event)
    if (!runtime || !store) return []
    const scope = runtime.environmentScope
    const hostId = scope.scope === 'local' ? localMachineId : scope.hostId
    store.moveToProject(String(id), String(projectId), scope.scope, hostId)
    return runtime.currentMachineConversations()
  })

  ipcMain.handle(IpcChannels.interceptorGetState, (event): InterceptorStatus => runtimeForEvent(event)?.embed.getInterceptorStatus() ?? FALLBACK_INTERCEPTOR_STATE)
  ipcMain.handle(IpcChannels.interceptorSetEnabled, (event, enabled: boolean): InterceptorStatus => runtimeForEvent(event)?.embed.setInterceptorEnabled(Boolean(enabled)) ?? FALLBACK_INTERCEPTOR_STATE)
  ipcMain.handle(IpcChannels.interceptorSetPromptInjectionEnabled, (event, enabled: boolean): InterceptorStatus => {
    const runtime = runtimeForEvent(event)
    if (!runtime || typeof enabled !== 'boolean') throw new Error('当前会话不可用。')
    return runtime.setPromptInjectionEnabled(enabled)
  })
  ipcMain.handle(IpcChannels.interceptorAnswerQuestion, async (event, messageId: string, answer: string): Promise<InterceptorStatus> => {
    const runtime = runtimeForEvent(event)
    if (!runtime || typeof messageId !== 'string' || typeof answer !== 'string') throw new Error('当前会话不可用。')
    return runtime.embed.answerQuestion(messageId, answer)
  })
  ipcMain.handle(IpcChannels.interceptorCancelQuestion, async (event, messageId: string): Promise<InterceptorStatus> => {
    const runtime = runtimeForEvent(event)
    if (!runtime || typeof messageId !== 'string') throw new Error('当前会话不可用。')
    return runtime.embed.cancelQuestion(messageId)
  })
  ipcMain.handle(IpcChannels.interceptorEndTask, async (event): Promise<InterceptorStatus> => {
    const runtime = runtimeForEvent(event)
    return runtime ? await runtime.endTask() : FALLBACK_INTERCEPTOR_STATE
  })

  ipcMain.handle(IpcChannels.automationGetState, (event): AutomationState => runtimeForEvent(event)?.runner.getAutomation() ?? FALLBACK_AUTOMATION)
  ipcMain.handle(IpcChannels.automationSetMode, (event, mode: string): AutomationState => runtimeForEvent(event)?.applyExecutionMode(mode === 'auto' ? 'auto' : 'manual') ?? FALLBACK_AUTOMATION)
  ipcMain.handle(IpcChannels.automationSetPaused, (event, paused: boolean): AutomationState => runtimeForEvent(event)?.setPaused(Boolean(paused)) ?? FALLBACK_AUTOMATION)
  ipcMain.handle(IpcChannels.automationCheckNow, async (event): Promise<AutomationState> => {
    const runtime = runtimeForEvent(event)
    if (!runtime) return FALLBACK_AUTOMATION
    await runtime.embed.checkForCommandNow()
    return runtime.runner.getAutomation()
  })

  ipcMain.handle(IpcChannels.executionList, (event, conversationId: string): ExecutionRecord[] => {
    if (!runtimeForEvent(event) || !store) return []
    const id = typeof conversationId === 'string' ? conversationId : ''
    return id === '' ? [] : store.listExecutions(id)
  })
  ipcMain.handle(IpcChannels.executionRun, (event, messageId: string): ExecutionRecord[] => {
    const runtime = runtimeForEvent(event)
    if (!runtime || !store) return []
    const id = String(messageId)
    const record = store.getExecution(id)
    if (!record) return []
    void runtime.runner.runExecution(id)
    return store.listExecutions(record.conversationId)
  })
  ipcMain.handle(IpcChannels.executionSkip, (event, messageId: string): ExecutionRecord[] => {
    const runtime = runtimeForEvent(event)
    if (!runtime || !store) return []
    const id = String(messageId)
    const record = store.getExecution(id)
    if (!record) return []
    runtime.runner.skipExecution(id)
    return store.listExecutions(record.conversationId)
  })

  ipcMain.handle(IpcChannels.terminalGetState, (event): TerminalState => runtimeForEvent(event)?.runner.getTerminalState() ?? FALLBACK_TERMINAL_STATE)
  ipcMain.handle(IpcChannels.terminalInput, (event, text: string): TerminalState => {
    const runtime = runtimeForEvent(event)
    if (!runtime) return FALLBACK_TERMINAL_STATE
    void runtime.runner.sendTerminalInput(String(text ?? ''))
    return runtime.runner.getTerminalState()
  })
  ipcMain.handle(IpcChannels.terminalInterrupt, async (event): Promise<TerminalState> => {
    const runtime = runtimeForEvent(event)
    if (!runtime) return FALLBACK_TERMINAL_STATE
    /*
     * Logged on BOTH sides of the await, because the failure this instruments is a HANG.
     *
     * `shell.interrupt()` waits for the process to close and has no timeout, so if 'close'
     * never arrives the whole promise chain stays unsettled: no IPC reply, no state update, and
     * a 中断 button that does nothing at all — with nothing in any log to say why. An
     * "interrupt: requested" with no matching "interrupt: completed" is precisely that case.
     */
    console.info('[interrupt] requested from the renderer')
    const sshState = runtime.ssh.getState()
    if (sshState.attached && sshState.status === 'connected') {
      const handled = await runtime.runner.interruptTerminal(true)
      if (!handled) runtime.ssh.interrupt()
    } else {
      await runtime.runner.interruptTerminal()
    }
    console.info('[interrupt] completed')
    return runtime.runner.getTerminalState()
  })
  ipcMain.handle(IpcChannels.terminalReset, (event): TerminalState => {
    const runtime = runtimeForEvent(event)
    if (!runtime) return FALLBACK_TERMINAL_STATE
    runtime.runner.resetTerminal()
    return runtime.runner.getTerminalState()
  })
  ipcMain.handle(IpcChannels.terminalSetCwd, async (event, path: string): Promise<TerminalState> => runtimeForEvent(event)?.setTerminalCwd(String(path ?? '')) ?? FALLBACK_TERMINAL_STATE)
  ipcMain.handle(IpcChannels.dialogSelectDirectory, async (event): Promise<string | null> => {
    const window = runtimeForEvent(event)?.window
    const result = window && !window.isDestroyed()
      ? await dialog.showOpenDialog(window, {
          properties: ['openDirectory'],
          title: '选择终端目录'
        })
      : await dialog.showOpenDialog({
          properties: ['openDirectory'],
          title: '选择终端目录'
        })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0] ?? null
  })
  ipcMain.handle(IpcChannels.terminalSetSendDelay, (event, seconds: number): TerminalState => runtimeForEvent(event)?.setTerminalSendDelay(Number(seconds ?? 0)) ?? FALLBACK_TERMINAL_STATE)
  ipcMain.handle(IpcChannels.environmentGet, (event) => ({ ...(runtimeForEvent(event)?.environment ?? FALLBACK_ENVIRONMENT) }))
  ipcMain.handle(IpcChannels.terminalNotesGet, (event): TerminalNotes => runtimeForEvent(event)?.currentNotes() ?? EMPTY_NOTES)
  ipcMain.handle(IpcChannels.terminalNotesSet, (event, text: string, owner: TerminalNotesOwner): TerminalNotes => {
    const runtime = runtimeForEvent(event)
    if (!runtime || typeof text !== 'string') throw new Error('当前会话不可用。')
    return runtime.applyTerminalNotes(text, owner)
  })
  ipcMain.handle(IpcChannels.mysqlConnList, (event): MysqlConnectionsState => runtimeForEvent(event)?.listMysqlConnections() ?? EMPTY_MYSQL)
  ipcMain.handle(IpcChannels.mysqlConnSave, (event, draft: MysqlConnectionDraft): MysqlSaveResult => runtimeForEvent(event)?.saveMysqlConnection(draft) ?? { ...EMPTY_MYSQL, id: '' })
  ipcMain.handle(IpcChannels.mysqlConnListDatabases, (event, draft: MysqlConnectionDraft): Promise<MysqlDatabaseList> => runtimeForEvent(event)?.listMysqlDatabases(draft) ?? Promise.resolve({ ok: false, databases: [], message: '当前会话不可用。' }))
  ipcMain.handle(IpcChannels.mysqlConnListTables, (event, draft: MysqlConnectionDraft, database: string): Promise<MysqlTableList> => runtimeForEvent(event)?.listMysqlTables(draft, database) ?? Promise.resolve({ ok: false, tables: [], message: '当前会话不可用。' }))
  ipcMain.handle(IpcChannels.mysqlConnQueryTable, (event, draft: MysqlConnectionDraft, database: string, table: string): Promise<MysqlTableData> => runtimeForEvent(event)?.queryMysqlTable(draft, database, table) ?? Promise.resolve({ ok: false, sql: '', columns: [], columnComments: [], columnCommentsMessage: '', rows: [], truncated: false, message: '当前会话不可用。' }))
  ipcMain.handle(IpcChannels.mysqlConnTableDdl, (event, draft: MysqlConnectionDraft, database: string, table: string): Promise<MysqlTableDdl> => runtimeForEvent(event)?.getMysqlTableDdl(draft, database, table) ?? Promise.resolve({ ok: false, ddl: '', message: '当前会话不可用。' }))
  ipcMain.handle(IpcChannels.mysqlConnRemove, (event, id: string): MysqlConnectionsState => runtimeForEvent(event)?.removeMysqlConnection(id) ?? EMPTY_MYSQL)

  ipcMain.handle(IpcChannels.sshGetState, (event): SshState => runtimeForEvent(event)?.ssh.getState() ?? { ...EMPTY_SSH_STATE })
  ipcMain.handle(IpcChannels.sshListHosts, (event): SshHost[] => runtimeForEvent(event)?.listSshHosts() ?? [])
  ipcMain.handle(IpcChannels.sshRemoveHost, (event, id: string): SshHost[] => runtimeForEvent(event)?.removeSshHost(String(id ?? '')) ?? [])
  ipcMain.handle(IpcChannels.sshConnect, (event, draft: SshHostDraft): SshState => runtimeForEvent(event)?.connectSsh(draft) ?? { ...EMPTY_SSH_STATE })
  ipcMain.handle(IpcChannels.sshDisconnect, (event): SshState => runtimeForEvent(event)?.ssh.disconnect() ?? { ...EMPTY_SSH_STATE })
  ipcMain.handle(IpcChannels.sshDismiss, (event): SshState => runtimeForEvent(event)?.ssh.dismiss() ?? { ...EMPTY_SSH_STATE })
  ipcMain.handle(IpcChannels.sshListFiles, async (event, path: string): Promise<SshFileEntry[]> => {
    const runtime = runtimeForEvent(event)
    if (!runtime) return []
    try {
      const dir = join(app.getPath('userData'), 'logs')
      mkdirSync(dir, { recursive: true })
      appendFileSync(join(dir, 'ssh-cwd-picker.log'), JSON.stringify({ time: new Date().toISOString(), event: 'list-files', path: String(path ?? '/') }) + '\n', 'utf8')
    } catch {
      /* Diagnostics must never interrupt directory listing. */
    }
    return runtime.ssh.listFiles(String(path ?? '/'))
  })
  ipcMain.on(IpcChannels.sshCwdDebugLog, (_event, message: string): void => {
    try {
      const dir = join(app.getPath('userData'), 'logs')
      mkdirSync(dir, { recursive: true })
      appendFileSync(join(dir, 'ssh-cwd-picker.log'), String(message ?? '') + '\n', 'utf8')
    } catch {
      /* Diagnostics must never interrupt the picker. */
    }
  })
  ipcMain.handle(IpcChannels.sshDownloadFile, async (event, remotePath: string): Promise<boolean> => {
    const runtime = runtimeForEvent(event)
    if (!runtime) return false
    const source = String(remotePath ?? '').trim()
    if (source === '') return false
    const window = runtime.window
    const options = { title: '保存 SSH 文件', defaultPath: posix.basename(source) || 'download' }
    const result = window && !window.isDestroyed()
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return false
    runtime.ssh.downloadFile(source, result.filePath)
    return true
  })
  ipcMain.handle(IpcChannels.sshDownloadsGet, (event): SshDownloadTask[] =>
    runtimeForEvent(event)?.ssh.getDownloads() ?? [])
  ipcMain.handle(IpcChannels.sshDownloadCancel, (event, id: string): boolean =>
    runtimeForEvent(event)?.ssh.cancelDownload(String(id ?? '')) ?? false)

  ipcMain.handle(IpcChannels.sshUploadFiles, async (event): Promise<SshState> => {
    const runtime = runtimeForEvent(event)
    if (!runtime) return { ...EMPTY_SSH_STATE }
    const window = runtime.window
    const result = window && !window.isDestroyed()
      ? await dialog.showOpenDialog(window, {
          properties: ['openFile', 'multiSelections'],
          title: '选择要上传到 SSH 的文件'
        })
      : await dialog.showOpenDialog({
          properties: ['openFile', 'multiSelections'],
          title: '选择要上传到 SSH 的文件'
        })
    if (result.canceled || result.filePaths.length === 0) return runtime.ssh.getState()
    return runtime.ssh.uploadFiles(result.filePaths)
  })
  ipcMain.handle(IpcChannels.sshUploadsGet, (event): SshUploadTask[] =>
    runtimeForEvent(event)?.ssh.getUploads() ?? [])
  ipcMain.handle(IpcChannels.sshUploadCancel, (event, id: string): boolean =>
    runtimeForEvent(event)?.ssh.cancelUpload(String(id ?? '')) ?? false)
  ipcMain.handle(IpcChannels.sshInput, async (event, text: string): Promise<SshState> => {
    const runtime = runtimeForEvent(event)
    if (!runtime) return { ...EMPTY_SSH_STATE }
    await runtime.ssh.write(String(text ?? ''))
    return runtime.ssh.getState()
  })

  ipcMain.handle(IpcChannels.settingsGet, (event): AppSettings => isManagerEvent(event) ? { ...settings } : { theme: 'light', embedProxy: {}, sshProxy: '', updateProxy: '', userAvatarDataUrl: '', userAvatarSourceDataUrl: '', userAvatarPositionX: 50, userAvatarPositionY: 50, userAvatarScale: 1 })
  ipcMain.handle(IpcChannels.settingsUpdate, async (event, patch: AppSettingsPatch): Promise<AppSettings> => {
    if (!isManagerEvent(event) || !store) return { ...settings }
    if (patch?.theme === 'light' || patch?.theme === 'dark') {
      settings = { ...settings, theme: patch.theme }
      store.setSetting(SETTING_THEME, patch.theme)
      /*
       * Applied here rather than only at the next page load: the user just flipped a switch,
       * and a chat page that keeps its old colours until something reloads it reads as a
       * broken setting. This reaches the open views; a view created later reads the theme
       * from `settings()` in `ensureEmbed`.
       */
      applyAppTheme(patch.theme)
    }
    if (patch?.embedProxy && typeof patch.embedProxy === 'object') {
      /*
       * Partial by design: the UI sends the whole map, but only the platforms it actually
       * mentions are touched, so a caller that knows about two sites cannot wipe the third.
       */
      const next: Record<string, string> = { ...settings.embedProxy }
      let changed = false
      for (const platform of CHAT_PLATFORMS) {
        const raw = patch.embedProxy[platform.id]
        if (typeof raw !== 'string') continue
        const proxy = normalizeProxy(raw)
        if (next[platform.id] === proxy) continue
        next[platform.id] = proxy
        store.setSetting(embedProxyKey(platform.id), proxy)
        changed = true
      }
      if (changed) {
        settings = { ...settings, embedProxy: next }
        await applyEmbedProxy(next)
        for (const runtime of runtimes.values()) runtime.embed.reload()
      }
    }
    if (typeof patch?.sshProxy === 'string') {
      const proxy = normalizeProxy(patch.sshProxy)
      settings = { ...settings, sshProxy: proxy }
      store.setSetting(SETTING_SSH_PROXY, proxy)
    }
    if (typeof patch?.updateProxy === 'string') {
      const proxy = normalizeProxy(patch.updateProxy)
      settings = { ...settings, updateProxy: proxy }
      store.setSetting(SETTING_UPDATE_PROXY, proxy)
      await applyUpdateProxy(proxy)
    }
    if (typeof patch?.userAvatarDataUrl === 'string') {
      settings = { ...settings, userAvatarDataUrl: patch.userAvatarDataUrl }
      store.setSetting(SETTING_USER_AVATAR, patch.userAvatarDataUrl)
    }
    if (typeof patch?.userAvatarSourceDataUrl === 'string') {
      settings = { ...settings, userAvatarSourceDataUrl: patch.userAvatarSourceDataUrl }
      store.setSetting(SETTING_USER_AVATAR_SOURCE, patch.userAvatarSourceDataUrl)
    }
    if (typeof patch?.userAvatarPositionX === 'number' && Number.isFinite(patch.userAvatarPositionX)) {
      const value = Math.max(0, Math.min(100, patch.userAvatarPositionX))
      settings = { ...settings, userAvatarPositionX: value }
      store.setSetting(SETTING_USER_AVATAR_POSITION_X, String(value))
    }
    if (typeof patch?.userAvatarPositionY === 'number' && Number.isFinite(patch.userAvatarPositionY)) {
      const value = Math.max(0, Math.min(100, patch.userAvatarPositionY))
      settings = { ...settings, userAvatarPositionY: value }
      store.setSetting(SETTING_USER_AVATAR_POSITION_Y, String(value))
    }
    if (typeof patch?.userAvatarScale === 'number' && Number.isFinite(patch.userAvatarScale)) {
      const value = Math.max(1, Math.min(4, patch.userAvatarScale))
      settings = { ...settings, userAvatarScale: value }
      store.setSetting(SETTING_USER_AVATAR_SCALE, String(value))
    }
    return { ...settings }
  })

  ipcMain.handle(IpcChannels.updateGetState, (): UpdateStatus => getUpdateStatus())
  ipcMain.handle(IpcChannels.updateCheck, (): Promise<UpdateStatus> => checkForUpdates())
  ipcMain.handle(IpcChannels.updateDownload, (): Promise<UpdateStatus> => downloadUpdate())
  ipcMain.handle(IpcChannels.updateInstall, (): void => installUpdate())
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => createManagerWindow())

  void app.whenReady().then(async () => {
    if (process.platform === 'win32') app.setAppUserModelId('com.example.gptweb2codexterminal')

    if (appLogFile) {
      console.info(`[app] logging this run to ${appLogFile}`)
      console.info(`[app] sessions are restored below; each prints its platform and url`)
    }
    if (netLogFile) {
      console.info(`[app] network log (tens of MB) → ${netLogFile}`)
      console.info('[app] analyse it with: node tools/diag/analyse-net-log.mjs "<that file>"')
    }
    /*
     * Say it out loud. A resolver rule that fails to apply is invisible — the only symptom is
     * the log noise coming back — so the run states which hosts it silenced, and why.
     */
    if (unresolvableHosts.length > 0) {
      console.info(
        `[app] not resolving (IPv6-only, unreachable from here): ${unresolvableHosts.join(', ')}`
      )
    }

    const conversationStore = new ConversationStore(join(app.getPath('userData'), 'conversations.db'))
    store = conversationStore
    localMachineId = conversationStore.getSetting(SETTING_LOCAL_MACHINE_ID) ?? ''
    if (localMachineId === '') {
      localMachineId = randomUUID()
      conversationStore.setSetting(SETTING_LOCAL_MACHINE_ID, localMachineId)
    }

    const purged = conversationStore.purgeInvalidIds(isConversationId)
    if (purged > 0) console.info(`[db] removed ${purged} non-conversation row(s)`)

    settings = {
      theme: conversationStore.getSetting(SETTING_THEME) === 'dark' ? 'dark' : 'light',
      embedProxy: readEmbedProxies(conversationStore),
      sshProxy: conversationStore.getSetting(SETTING_SSH_PROXY) ?? '',
      updateProxy: conversationStore.getSetting(SETTING_UPDATE_PROXY) ?? '',
      userAvatarDataUrl: conversationStore.getSetting(SETTING_USER_AVATAR) ?? '',
      userAvatarSourceDataUrl: conversationStore.getSetting(SETTING_USER_AVATAR_SOURCE) ?? conversationStore.getSetting(SETTING_USER_AVATAR) ?? '',
      userAvatarPositionX: readAvatarPosition(conversationStore.getSetting(SETTING_USER_AVATAR_POSITION_X)),
      userAvatarPositionY: readAvatarPosition(conversationStore.getSetting(SETTING_USER_AVATAR_POSITION_Y)),
      userAvatarScale: readAvatarScale(conversationStore.getSetting(SETTING_USER_AVATAR_SCALE))
    }
    /*
     * Before any window or view exists, so the first paint of every embedded page already has
     * the right `prefers-color-scheme` — including the splash, which takes the theme as a
     * query parameter for exactly the same reason.
     */
    applyAppTheme(settings.theme)
    await applyEmbedProxy(settings.embedProxy)
    setUpdaterBroadcast((status) => {
      if (managerWindow && !managerWindow.isDestroyed()) {
        managerWindow.webContents.send(IpcChannels.updateChanged, status)
      }
    })
    await applyUpdateProxy(settings.updateProxy)

    registerIpcHandlers()
    createTray()
    /*
     * Splash first, window second. Both are created without showing; the main window
     * paints as soon as React's first render is ready, and the splash sits on top of it
     * until the chat view reports its first finished load.
     */
    createSplashWindow()
    createManagerWindow()
    // First check fires immediately, then every 30 minutes (packaged builds only).
    startUpdateSchedule()
    const savedWorkspaceSessionId = conversationStore.getSetting(SETTING_WORKSPACE_SESSION_ID) ?? ''
    const savedWorkspaceOpenSshDialog = conversationStore.getSetting(SETTING_WORKSPACE_OPEN_SSH_DIALOG) === '1'
    const savedSessions = conversationStore.listManagedSessions()
    if (savedSessions.length === 0) createSession('local', true)
    else {
      for (const savedSession of savedSessions) {
        // Restore each session onto the site it was created on. An id this build does not
        // know (a row from a newer version, or a removed platform) falls back to the
        // default rather than throwing — a bad id must not make the app unopenable.
        const platform = platformById(savedSession.platformId) ?? CHATGPT_PLATFORM
        createSession('local', false, savedSession, platform)
      }
    }

    if (savedWorkspaceSessionId !== '' && runtimes.has(savedWorkspaceSessionId)) {
      selectSession(savedWorkspaceSessionId, savedWorkspaceOpenSshDialog)
    } else {
      const firstId = runtimes.keys().next().value as string | undefined
      if (firstId) selectSession(firstId)
    }

    app.on('activate', () => {
      createManagerWindow()
      if (runtimes.size === 0) createSession('local', true)
    })
  })
}

app.on('before-quit', () => {
  quitting = true
})

app.on('will-quit', () => {
  destroySplashWindow()
  tray?.destroy()
  tray = null
  for (const runtime of runtimes.values()) runtime.dispose()
  runtimes.clear()
  store?.close()
  store = null
})


