import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import {
  EMBED_HOME_URL,
  EMBED_LOGIN_URL,
  EMBED_PARTITION,
  FALLBACK_ENVIRONMENT,
  IpcChannels,
  isConversationId
} from '../shared/types'
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
  SshState,
  TerminalNotes,
  TerminalState
} from '../shared/types'
import { embedAuthState, importSessionToken } from './session-import'
import { ConversationStore } from './db'
import { EMPTY_SSH_STATE, SessionRuntime } from './session-runtime'

const rendererDevServerUrl = process.env['ELECTRON_RENDERER_URL']
const isDev = !app.isPackaged
const SETTING_EXECUTION_MODE = 'executionMode'
const SETTING_EMBED_PROXY = 'embedProxy'
const SETTING_SSH_PROXY = 'sshProxy'
const SETTING_LOCAL_MACHINE_ID = 'localMachineId'

let managerWindow: BrowserWindow | null = null
let store: ConversationStore | null = null
let localMachineId = ''
let settings: AppSettings = { embedProxy: '', sshProxy: '' }
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
const FALLBACK_TERMINAL_STATE: TerminalState = { alive: false, cwd: '', lines: [] }
const EMPTY_NOTES: TerminalNotes = { scope: 'local', hostId: '', label: '', text: '' }

function normalizeProxy(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '') return ''
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
}

async function applyEmbedProxy(proxy: string): Promise<void> {
  const embedSession = session.fromPartition(EMBED_PARTITION)
  try {
    if (proxy === '') await embedSession.setProxy({ mode: 'direct' })
    else await embedSession.setProxy({ proxyRules: proxy })
    await embedSession.closeAllConnections()
  } catch (error) {
    console.warn('[settings] failed to apply embed proxy:', (error as Error).message)
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

function showWorkspaceManager(): boolean {
  if (currentSessionId) runtimes.get(currentSessionId)?.setActive(false)
  currentSessionId = null
  workspaceOpenSshDialog = false
  broadcastWorkspaceState()
  return true
}

function selectSession(id: string, openSshDialog = false): boolean {
  const runtime = runtimes.get(id)
  if (!runtime) return false
  if (currentSessionId && currentSessionId !== id) runtimes.get(currentSessionId)?.setActive(false)
  currentSessionId = id
  workspaceOpenSshDialog = openSshDialog
  runtime.setActive(true)
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

function createSession(kind: 'local' | 'ssh' = 'local', activate = true): SessionRuntime | null {
  if (!store) return null
  const savedMode = store.getSetting(SETTING_EXECUTION_MODE)
  const initialMode: ExecutionMode = savedMode === 'auto' ? 'auto' : 'manual'
  const runtime = new SessionRuntime({
    store,
    localMachineId,
    initialMode,
    settings: () => ({ ...settings }),
    onSummaryChanged: broadcastManagedSessions,
    onActivate: (id) => { selectSession(id) }
  })
  runtimes.set(runtime.id, runtime)
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
  runtime.dispose()
  broadcastManagedSessions()
  if (wasCurrent) broadcastWorkspaceState()
  return true
}

function createManagerWindow(): void {
  if (managerWindow && !managerWindow.isDestroyed()) {
    if (managerWindow.isMinimized()) managerWindow.restore()
    managerWindow.show()
    managerWindow.focus()
    return
  }

  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1040,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0e14',
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
  ipcMain.handle(
    IpcChannels.managerSessionCreate,
    (event, kind: string): ManagedSessionSummary | null => {
      if (!fromManager(event)) return null
      const runtime = createSession(kind === 'ssh' ? 'ssh' : 'local', true)
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
    return importSessionToken(draft, runtime.embed.contents(), () => runtime.embed.reloadAndWait())
  })
  ipcMain.handle(IpcChannels.embedGetAuthState, async (event): Promise<EmbedAuthState> => {
    const runtime = runtimeForEvent(event)
    return runtime ? embedAuthState(runtime.embed.contents()) : { signedIn: false, cookieNames: [] }
  })
  ipcMain.on(IpcChannels.openChatgptExternal, (event) => {
    if (runtimeForEvent(event)) void shell.openExternal(EMBED_HOME_URL)
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
  ipcMain.handle(IpcChannels.environmentGet, (event) => ({ ...(runtimeForEvent(event)?.environment ?? FALLBACK_ENVIRONMENT) }))
  ipcMain.handle(IpcChannels.terminalNotesGet, (event): TerminalNotes => runtimeForEvent(event)?.currentNotes() ?? EMPTY_NOTES)
  ipcMain.handle(IpcChannels.terminalNotesSet, (event, text: string): TerminalNotes => runtimeForEvent(event)?.applyTerminalNotes(String(text ?? '')) ?? EMPTY_NOTES)

  ipcMain.handle(IpcChannels.sshGetState, (event): SshState => runtimeForEvent(event)?.ssh.getState() ?? { ...EMPTY_SSH_STATE })
  ipcMain.handle(IpcChannels.sshListHosts, (event): SshHost[] => runtimeForEvent(event)?.listSshHosts() ?? [])
  ipcMain.handle(IpcChannels.sshRemoveHost, (event, id: string): SshHost[] => runtimeForEvent(event)?.removeSshHost(String(id ?? '')) ?? [])
  ipcMain.handle(IpcChannels.sshConnect, (event, draft: SshHostDraft): SshState => runtimeForEvent(event)?.connectSsh(draft) ?? { ...EMPTY_SSH_STATE })
  ipcMain.handle(IpcChannels.sshDisconnect, (event): SshState => runtimeForEvent(event)?.ssh.disconnect() ?? { ...EMPTY_SSH_STATE })
  ipcMain.handle(IpcChannels.sshDismiss, (event): SshState => runtimeForEvent(event)?.ssh.dismiss() ?? { ...EMPTY_SSH_STATE })
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
  ipcMain.handle(IpcChannels.sshInput, (event, text: string): SshState => {
    const runtime = runtimeForEvent(event)
    if (!runtime) return { ...EMPTY_SSH_STATE }
    runtime.ssh.write(String(text ?? ''))
    return runtime.ssh.getState()
  })

  ipcMain.handle(IpcChannels.settingsGet, (event): AppSettings => runtimeForEvent(event) ? { ...settings } : { embedProxy: '', sshProxy: '' })
  ipcMain.handle(IpcChannels.settingsUpdate, async (event, patch: AppSettingsPatch): Promise<AppSettings> => {
    if (!runtimeForEvent(event) || !store) return { ...settings }
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
    return { ...settings }
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => createManagerWindow())

  void app.whenReady().then(async () => {
    if (process.platform === 'win32') app.setAppUserModelId('com.example.gptweb2codexterminal')

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
      embedProxy: conversationStore.getSetting(SETTING_EMBED_PROXY) ?? '',
      sshProxy: conversationStore.getSetting(SETTING_SSH_PROXY) ?? ''
    }
    await applyEmbedProxy(settings.embedProxy)

    registerIpcHandlers()
    createManagerWindow()
    createSession('local', false)

    app.on('activate', () => {
      createManagerWindow()
      if (runtimes.size === 0) createSession('local', false)
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  for (const runtime of runtimes.values()) runtime.dispose()
  runtimes.clear()
  store?.close()
  store = null
})
