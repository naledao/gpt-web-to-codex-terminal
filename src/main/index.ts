import { join, posix } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell, Tray } from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import {
  EMBED_LOGIN_URL,
  FALLBACK_ENVIRONMENT,
  IpcChannels,
  isConversationId
} from '../shared/types'
import { CHAT_PLATFORMS, CHATGPT_PLATFORM, DEFAULT_PLATFORM_ID, platformById } from '../shared/platforms'
import type { ChatPlatform } from '../shared/platforms'
import type {
  AppInfo,
  AppSettings,
  AppSettingsPatch,
  AutomationState,
  Conversation,
  EmbedAuthState,
  EmbedBounds,
  EmbedCommand,
  EmbedState,
  ExecutionMode,
  ExecutionRecord,
  ExternalAuthNotice,
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
  TerminalState,
  UpdateStatus
} from '../shared/types'
import { embedAuthState, importSessionToken, previewSessionImport } from './session-import'
import { ConversationStore } from './db'
import { EMPTY_SSH_STATE, SessionRuntime } from './session-runtime'
import { installAppLog, installNetLog } from './app-log'
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
const SETTING_EMBED_PROXY = 'embedProxy'
const SETTING_SSH_PROXY = 'sshProxy'
const SETTING_UPDATE_PROXY = 'updateProxy'
const SETTING_LOCAL_MACHINE_ID = 'localMachineId'
const SETTING_WORKSPACE_SESSION_ID = 'workspaceSessionId'
const SETTING_WORKSPACE_OPEN_SSH_DIALOG = 'workspaceOpenSshDialog'

let managerWindow: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
let store: ConversationStore | null = null
let localMachineId = ''
let settings: AppSettings = { theme: 'light', embedProxy: '', sshProxy: '', updateProxy: '' }
const runtimes = new Map<string, SessionRuntime>()
let currentSessionId: string | null = null
let workspaceOpenSshDialog = false

const EMPTY_EMBED_STATE: EmbedState = {
  url: '',
  title: '',
  isLoading: false,
  canGoBack: false,
  canGoForward: false,
  conversationId: null
}

const FALLBACK_INTERCEPTOR_STATE: InterceptorStatus = {
  enabled: false,
  installed: false,
  injectedCount: 0,
  lastSentText: null,
  taskStartedAt: null,
  taskFinishedAt: null,
  prefix: ''
}

const FALLBACK_AUTOMATION: AutomationState = { mode: 'manual', paused: true }
const FALLBACK_TERMINAL_STATE: TerminalState = { alive: false, cwd: '', lines: [], sendDelaySeconds: 0 }
const EMPTY_NOTES: TerminalNotes = { scope: 'local', hostId: '', label: '', text: '' }

function normalizeProxy(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '') return ''
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
}

async function applyEmbedProxy(proxy: string): Promise<void> {
  /*
   * Applied to EVERY platform's partition, not just the active one.
   *
   * Each embedded site has its own Electron session, so a proxy set on one of them
   * leaves the other going direct — which looks like "the proxy works for ChatGPT but
   * not DeepSeek" and is really just half-applied configuration.
   */
  for (const platform of CHAT_PLATFORMS) {
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
    if (managerWindow.isMinimized()) managerWindow.restore()
    managerWindow.show()
    managerWindow.focus()
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
    onActivate: (id) => { selectSession(id) }
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
  window.once('ready-to-show', () => window.show())
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
  ipcMain.handle(IpcChannels.embedGetExternalAuth, (event): ExternalAuthNotice | null => runtimeForEvent(event)?.externalAuthNotice ?? null)
  ipcMain.on(IpcChannels.embedLoginWithEmail, (event) => runtimeForEvent(event)?.embed.navigate(EMBED_LOGIN_URL))
  ipcMain.handle(IpcChannels.embedImportSession, async (event, draft: SessionImportDraft): Promise<SessionImportResult> => {
    const runtime = runtimeForEvent(event)
    if (!runtime) return { ok: false, message: '请求不是来自应用窗口。', signedIn: false }
    return importSessionToken(runtime.chatPlatform, draft, runtime.embed.contents(), () =>
      runtime.embed.reloadAndWait()
    )
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
  ipcMain.on(IpcChannels.openChatgptExternal, (event) => {
    const runtime = runtimeForEvent(event)
    // The active session's OWN site: opening chatgpt.com from a DeepSeek session would
    // send the user somewhere they are not working.
    if (runtime) void shell.openExternal(runtime.chatPlatform.homeUrl)
  })

  ipcMain.handle(IpcChannels.conversationsList, (event): Conversation[] => runtimeForEvent(event)?.currentMachineConversations() ?? [])
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
    await runtime.runner.interruptTerminal()
    return runtime.runner.getTerminalState()
  })
  ipcMain.handle(IpcChannels.terminalReset, (event): TerminalState => {
    const runtime = runtimeForEvent(event)
    if (!runtime) return FALLBACK_TERMINAL_STATE
    runtime.runner.resetTerminal()
    return runtime.runner.getTerminalState()
  })
  ipcMain.handle(IpcChannels.terminalSetCwd, async (event, path: string): Promise<TerminalState> => runtimeForEvent(event)?.setTerminalCwd(String(path ?? '')) ?? FALLBACK_TERMINAL_STATE)
  ipcMain.handle(IpcChannels.terminalSetSendDelay, (event, seconds: number): TerminalState => runtimeForEvent(event)?.setTerminalSendDelay(Number(seconds ?? 0)) ?? FALLBACK_TERMINAL_STATE)
  ipcMain.handle(IpcChannels.environmentGet, (event) => ({ ...(runtimeForEvent(event)?.environment ?? FALLBACK_ENVIRONMENT) }))
  ipcMain.handle(IpcChannels.terminalNotesGet, (event): TerminalNotes => runtimeForEvent(event)?.currentNotes() ?? EMPTY_NOTES)
  ipcMain.handle(IpcChannels.terminalNotesSet, (event, text: string): TerminalNotes => runtimeForEvent(event)?.applyTerminalNotes(String(text ?? '')) ?? EMPTY_NOTES)

  ipcMain.handle(IpcChannels.sshGetState, (event): SshState => runtimeForEvent(event)?.ssh.getState() ?? { ...EMPTY_SSH_STATE })
  ipcMain.handle(IpcChannels.sshListHosts, (event): SshHost[] => runtimeForEvent(event)?.listSshHosts() ?? [])
  ipcMain.handle(IpcChannels.sshRemoveHost, (event, id: string): SshHost[] => runtimeForEvent(event)?.removeSshHost(String(id ?? '')) ?? [])
  ipcMain.handle(IpcChannels.sshConnect, (event, draft: SshHostDraft): SshState => runtimeForEvent(event)?.connectSsh(draft) ?? { ...EMPTY_SSH_STATE })
  ipcMain.handle(IpcChannels.sshDisconnect, (event): SshState => runtimeForEvent(event)?.ssh.disconnect() ?? { ...EMPTY_SSH_STATE })
  ipcMain.handle(IpcChannels.sshDismiss, (event): SshState => runtimeForEvent(event)?.ssh.dismiss() ?? { ...EMPTY_SSH_STATE })
  ipcMain.handle(IpcChannels.sshListFiles, async (event, path: string): Promise<SshFileEntry[]> => {
    const runtime = runtimeForEvent(event)
    if (!runtime) return []
    return runtime.ssh.listFiles(String(path ?? '/'))
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

  ipcMain.handle(IpcChannels.settingsGet, (event): AppSettings => isManagerEvent(event) ? { ...settings } : { theme: 'light', embedProxy: '', sshProxy: '', updateProxy: '' })
  ipcMain.handle(IpcChannels.settingsUpdate, async (event, patch: AppSettingsPatch): Promise<AppSettings> => {
    if (!isManagerEvent(event) || !store) return { ...settings }
    if (patch?.theme === 'light' || patch?.theme === 'dark') {
      settings = { ...settings, theme: patch.theme }
      store.setSetting(SETTING_THEME, patch.theme)
    }
    if (typeof patch?.embedProxy === 'string') {
      const proxy = normalizeProxy(patch.embedProxy)
      settings = { ...settings, embedProxy: proxy }
      store.setSetting(SETTING_EMBED_PROXY, proxy)
      await applyEmbedProxy(proxy)
      for (const runtime of runtimes.values()) runtime.embed.reload()
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
      embedProxy: conversationStore.getSetting(SETTING_EMBED_PROXY) ?? '',
      sshProxy: conversationStore.getSetting(SETTING_SSH_PROXY) ?? '',
      updateProxy: conversationStore.getSetting(SETTING_UPDATE_PROXY) ?? ''
    }
    await applyEmbedProxy(settings.embedProxy)
    setUpdaterBroadcast((status) => {
      if (managerWindow && !managerWindow.isDestroyed()) {
        managerWindow.webContents.send(IpcChannels.updateChanged, status)
      }
    })
    await applyUpdateProxy(settings.updateProxy)

    registerIpcHandlers()
    createTray()
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
  tray?.destroy()
  tray = null
  for (const runtime of runtimes.values()) runtime.dispose()
  runtimes.clear()
  store?.close()
  store = null
})
