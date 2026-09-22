import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app, BrowserWindow, ipcMain, safeStorage, session, shell } from 'electron'
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'
import {
  EMBED_PARTITION,
  FALLBACK_ENVIRONMENT,
  IpcChannels,
  buildTerminalPrefix,
  isConversationId
} from '../shared/types'
import type {
  AppInfo,
  AppSettings,
  AppSettingsPatch,
  AutomationState,
  Conversation,
  EmbedBounds,
  EmbedCommand,
  EmbedState,
  EnvironmentInfo,
  ExecutionMode,
  ExecutionRecord,
  InterceptorStatus,
  SshHost,
  SshHostDraft,
  SshState,
  TerminalNotes,
  TerminalState
} from '../shared/types'
import { ChatGptEmbed } from './embed'
import { ConversationStore } from './db'
import { CommandRunner } from './commands'
import { SshManager } from './ssh'
import { parseRemoteEnvironment, parseWindowsEnvironment } from './environment'
import { resolvePowerShell } from './shell'
import type { RemoteShell } from './remote-shell'

/** Set by `electron-vite dev`; absent in builds and in `electron-vite preview`. */
const rendererDevServerUrl = process.env['ELECTRON_RENDERER_URL']
const isDev = !app.isPackaged

let mainWindow: BrowserWindow | null = null
let store: ConversationStore | null = null
let runner: CommandRunner | null = null

/** Last conversation the embedded page reported, used to detect navigation. */
let lastConversationId: string | null = null

const SETTING_EXECUTION_MODE = 'executionMode'
const SETTING_EMBED_PROXY = 'embedProxy'
const SETTING_SSH_PROXY = 'sshProxy'
/** The note attached to the LOCAL machine; per-host notes live on the host row. */
const SETTING_LOCAL_NOTES = 'localTerminalNotes'

/**
 * What the terminal is currently pointed at, probed rather than assumed.
 *
 * The injected prompt is built from this instead of hard-coding "Windows 11 +
 * Windows PowerShell" — the model acts on whatever the prompt claims, so a wrong
 * claim sends it reaching for `&&` on 5.1, for ARM64 paths on x64, or for
 * `Get-ChildItem` on a Linux server it is actually connected to.
 */
let environment: EnvironmentInfo = { ...FALLBACK_ENVIRONMENT }

let ssh: SshManager | null = null

/**
 * The backend the model's commands run on once an SSH session has taken over.
 *
 * Kept here rather than inside the runner because the SSH manager owns the
 * session's lifetime — the runner only ever asks whether one exists. This is the
 * single value that both command routing and prompt building read, which is what
 * keeps them from ever disagreeing about the machine in charge.
 */
let remoteShell: RemoteShell | null = null

/**
 * Which machine `environment` currently describes.
 *
 * Tracked alongside the description rather than recomputed on demand, because the
 * note editor and the prompt must agree about whose note is whose: asking the SSH
 * manager separately would open a window where the two answers differ, and the
 * user would then be editing one machine's note while the model is told another's.
 */
let environmentScope: Pick<TerminalNotes, 'scope' | 'hostId' | 'label'> = {
  scope: 'local',
  hostId: '',
  label: '本机'
}

const EMPTY_SSH_STATE: SshState = {
  status: 'disconnected',
  attached: false,
  name: '',
  target: '',
  hostId: '',
  message: '',
  remoteExec: false,
  modelCwd: '',
  lines: []
}

/**
 * Passwords are stored with Electron's safeStorage — DPAPI-backed on Windows, so
 * the ciphertext is bound to the user account and useless if the database file is
 * copied elsewhere.
 *
 * When the OS cannot offer encryption the password is simply NOT stored, rather
 * than written in the clear: the user retypes it next time. The empty string is
 * the "nothing stored" signal throughout.
 */
function encryptSecret(password: string): string {
  if (password === '') return ''
  try {
    if (!safeStorage.isEncryptionAvailable()) return ''
    return safeStorage.encryptString(password).toString('base64')
  } catch {
    return ''
  }
}

function decryptSecret(secret: string): string {
  if (secret === '') return ''
  try {
    if (!safeStorage.isEncryptionAvailable()) return ''
    return safeStorage.decryptString(Buffer.from(secret, 'base64'))
  } catch {
    return ''
  }
}

/** In-memory mirror of the persisted settings, so reads need no database hit. */
let settings: AppSettings = { embedProxy: '', sshProxy: '' }

/**
 * Run the environment probe in the visible terminal and rebuild the prompt.
 *
 * Called at startup, whenever the terminal moves, and whenever an SSH session
 * takes over or releases the terminal. The working directory and the machine
 * itself are both part of what the model is told, so a prompt built before either
 * changed describes a state that no longer holds — and unlike a merely inaccurate
 * prompt, it actively points the model at the wrong tooling.
 */
async function probeEnvironment(): Promise<EnvironmentInfo> {
  if (!runner || !store) return { ...environment }
  try {
    const { kind, result } = await runner.runEnvironmentProbe()

    // One snapshot, used for both the description and the scope — see
    // environmentScope for why they must not be resolved separately.
    const sshState = ssh?.getState()

    const info =
      kind === 'posix'
        ? parseRemoteEnvironment(result.output, sshState?.name ?? '', sshState?.target ?? '')
        : parseWindowsEnvironment(result.output, resolvePowerShell())

    environmentScope =
      kind === 'posix'
        ? {
            scope: 'ssh',
            hostId: sshState?.hostId ?? '',
            label: sshState?.name || sshState?.target || '远端主机'
          }
        : { scope: 'local', hostId: '', label: '本机' }

    info.extraNotes = readNotes()
    environment = info
    embed.setPromptPrefix(buildTerminalPrefix(info))
    broadcastEnvironment()
    broadcastTerminalNotes()
    console.info(
      `[env] ${info.detected ? 'detected' : 'FALLBACK'}: ${info.kind} ${info.osCaption} ` +
        `${info.osVersion} ${info.architecture}` +
        (info.kind === 'posix'
          ? ` / ${info.shellPath} ${info.shellVersion}`
          : ` / ${info.powerShellExe} ${info.powerShellVersion}`) +
        (info.workingDirectory ? ` @ ${info.workingDirectory}` : '') +
        (info.extraNotes.trim() === '' ? '' : ' [+notes]')
    )
    return info
  } catch (error) {
    console.warn('[env] probe failed:', (error as Error).message)
    return { ...environment }
  }
}

/* ---------------- per-machine notes ---------------- */

/** The note belonging to whichever machine the terminal is currently driving. */
function readNotes(): string {
  if (!store) return ''
  return environmentScope.scope === 'ssh' && environmentScope.hostId !== ''
    ? store.getSshNote(environmentScope.hostId)
    : (store.getSetting(SETTING_LOCAL_NOTES) ?? '')
}

function currentNotes(): TerminalNotes {
  return { ...environmentScope, text: readNotes() }
}

function broadcastTerminalNotes(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send(IpcChannels.terminalNotesChanged, currentNotes())
}

/**
 * Store the note and re-apply it to the prompt immediately.
 *
 * No re-probe: the machine has not changed, only what the user wants to say about
 * it. Rebuilding the prefix here is what makes the change take effect on the very
 * next message instead of at the next SSH connect.
 */
function applyTerminalNotes(raw: string): TerminalNotes {
  const text = raw.trim() === '' ? '' : raw
  if (store) {
    if (environmentScope.scope === 'ssh' && environmentScope.hostId !== '') {
      store.setSshNote(environmentScope.hostId, text)
    } else {
      store.setSetting(SETTING_LOCAL_NOTES, text)
    }
  }

  environment = { ...environment, extraNotes: text }
  embed.setPromptPrefix(buildTerminalPrefix(environment))
  broadcastTerminalNotes()
  broadcastEnvironment()
  return currentNotes()
}

/**
 * Accept what a user naturally types. "127.0.0.1:7890" is a proxy address, not a
 * URL, and rejecting it over a missing scheme would be pure pedantry.
 */
function normalizeProxy(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '') return ''
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
}

/**
 * Route the EMBEDDED page — and nothing else — through a proxy.
 *
 * Scoped to the embed's own session on purpose. The proxy exists to reach
 * chatgpt.com; applying it app-wide (`app.commandLine.appendSwitch`) would drag
 * every other connection along, including things that must NOT be tunnelled.
 *
 * The setting is not persisted by Electron, so it is re-applied from the database
 * on every launch.
 */
async function applyEmbedProxy(proxy: string): Promise<void> {
  const embedSession = session.fromPartition(EMBED_PARTITION)

  try {
    if (proxy === '') {
      await embedSession.setProxy({ mode: 'direct' })
    } else {
      await embedSession.setProxy({ proxyRules: proxy })
    }
    // Sockets already open keep the old route, so drop them; the caller reloads
    // the page to make the change actually visible.
    await embedSession.closeAllConnections()
  } catch (error) {
    console.warn('[settings] failed to apply embed proxy:', (error as Error).message)
  }
}

/**
 * Apply the execution mode everywhere it matters: the runner's behaviour, the
 * persisted setting, and the page's baseline policy.
 */
function applyExecutionMode(mode: ExecutionMode): AutomationState | null {
  if (!runner || !store) return null

  const state = runner.setMode(mode)
  store.setSetting(SETTING_EXECUTION_MODE, mode)

  // NOTE: deliberately NOT calling armCommandBaseline() here. Switching the mode
  // is an explicit "go" signal about what is on screen right now; arming would
  // swallow the very reply the user wants executed. The baseline is only armed
  // when history is actually being restored — a conversation change or a reload.
  embed.setBaselinePolicy(mode === 'auto')

  broadcastAutomation(state)
  return state
}

const EMPTY_EMBED_STATE: EmbedState = {
  url: '',
  title: '',
  isLoading: false,
  canGoBack: false,
  canGoForward: false,
  conversationId: null
}

/** Returned to untrusted senders instead of the live interceptor state. */
const FALLBACK_INTERCEPTOR_STATE: InterceptorStatus = {
  enabled: false,
  installed: false,
  injectedCount: 0,
  lastSentText: null,
  prefix: ''
}

const FALLBACK_AUTOMATION: AutomationState = {
  mode: 'manual',
  paused: true
}

const FALLBACK_TERMINAL_STATE: TerminalState = {
  alive: false,
  cwd: '',
  lines: []
}

function broadcastAutomation(state: AutomationState): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send(IpcChannels.automationChanged, state)
}

/** Send the current conversation list to the renderer. */
function broadcastConversations(): void {
  if (!store || !mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send(IpcChannels.conversationsChanged, store.list())
}

function broadcastInterceptor(status: InterceptorStatus): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send(IpcChannels.interceptorEvent, status)
}

/**
 * Push the current environment description to the renderer.
 *
 * The settings dialog shows it, and it now changes while the app runs — attaching
 * an SSH session replaces it with the remote host — so a pull-on-open would leave
 * the user reading a description of a machine the model is no longer driving.
 */
function broadcastEnvironment(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send(IpcChannels.environmentChanged, { ...environment })
}

const embed = new ChatGptEmbed({
  onState: (state) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IpcChannels.embedState, state)
    }

    // Moving to another conversation: in auto mode whatever history it restores
    // must not be mistaken for fresh commands.
    if (state.conversationId !== lastConversationId) {
      const previousConversationId = lastConversationId
      lastConversationId = state.conversationId

      // Sending the first message of a new chat CREATES the conversation, so the
      // URL only picks up an id AFTER the send. That transition restores no
      // history, and resetting the injected script's state here would mark the
      // incoming answer as history so it never runs. Only the main process can
      // tell this apart from a real navigation, because only it sees the
      // previous conversation id.
      const createdNewChat = previousConversationId === null && state.conversationId !== null

      if (!createdNewChat && runner?.getAutomation().mode === 'auto') {
        void embed.armCommandBaseline()
      }

      // NOTE: nothing to do about the terminal here. It belongs to the machine,
      // not to the conversation, so moving between chats changes neither its
      // scrollback nor its working directory.
    }
  },

  // Auto-saved whenever the embedded page lands on a /c/<id> URL.
  onConversation: (conversation) => {
    if (!store) return
    store.upsert(conversation)
    broadcastConversations()
  },

  // Fired after a background sidebar scrape; the results are merged here so the
  // page is only ever scraped once per throttle window.
  onSynced: (scraped) => {
    if (!store) return
    store.upsertMany(scraped)
    broadcastConversations()
  },

  onInterceptor: broadcastInterceptor,

  // The model's reply contained a command; store it and maybe run it.
  onCommand: (command) => {
    runner?.handleDetected(command)
  },

  // A reply looked like a command but would not parse — never drop it quietly.
  onParseFailed: (text) => {
    runner?.noteParseFailure(text)
  }
})

async function refreshFromSidebar(): Promise<Conversation[]> {
  if (!store) return []
  const scraped = await embed.scrapeConversations()
  if (scraped.length > 0) store.upsertMany(scraped)
  return store.list()
}

function createWindow(): void {
  const appWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1040,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0e14',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // `sandbox: false` is required so the preload bundle can use Node built-ins.
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  mainWindow = appWindow

  // Avoid the white flash: only reveal the window once the first paint is ready.
  appWindow.once('ready-to-show', () => {
    appWindow.show()
  })

  appWindow.on('closed', () => {
    embed.destroy(appWindow)
    mainWindow = null
  })

  // Never let the app itself navigate to, or embed, remote content.
  appWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  appWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== appWindow.webContents.getURL()) {
      event.preventDefault()
      void shell.openExternal(url)
    }
  })

  if (rendererDevServerUrl) {
    void appWindow.loadURL(rendererDevServerUrl)
  } else {
    void appWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  embed.attach(appWindow)
}

function registerIpcHandlers(): void {
  ipcMain.handle(IpcChannels.getAppInfo, (): AppInfo => {
    return {
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
    }
  })

  /**
   * The embed channels drive a privileged native surface, so only accept them
   * from our own renderer — never from the embedded third-party page.
   */
  const fromAppWindow = (event: IpcMainEvent | IpcMainInvokeEvent): boolean =>
    mainWindow !== null && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents

  ipcMain.on(IpcChannels.embedSetBounds, (event, bounds: EmbedBounds) => {
    if (fromAppWindow(event)) embed.setBounds(bounds)
  })

  ipcMain.on(IpcChannels.embedSetVisible, (event, visible: boolean) => {
    if (fromAppWindow(event)) embed.setVisible(Boolean(visible))
  })

  ipcMain.on(IpcChannels.embedCommand, (event, command: EmbedCommand) => {
    if (fromAppWindow(event)) embed.command(command)
  })

  ipcMain.on(IpcChannels.embedNavigate, (event, url: string) => {
    if (fromAppWindow(event)) embed.navigate(String(url))
  })

  ipcMain.handle(IpcChannels.embedGetState, (event): EmbedState => {
    return fromAppWindow(event) ? embed.getState() : EMPTY_EMBED_STATE
  })

  ipcMain.handle(IpcChannels.conversationsList, (event): Conversation[] => {
    return fromAppWindow(event) && store ? store.list() : []
  })

  ipcMain.handle(IpcChannels.conversationsSync, async (event): Promise<Conversation[]> => {
    if (!fromAppWindow(event)) return []
    return refreshFromSidebar()
  })

  ipcMain.handle(IpcChannels.conversationsRemove, (event, id: string): Conversation[] => {
    if (!fromAppWindow(event) || !store) return []
    store.remove(String(id))
    return store.list()
  })

  ipcMain.handle(IpcChannels.interceptorGetState, (event): InterceptorStatus => {
    return fromAppWindow(event) ? embed.getInterceptorStatus() : FALLBACK_INTERCEPTOR_STATE
  })

  ipcMain.handle(
    IpcChannels.interceptorSetEnabled,
    (event, enabled: boolean): InterceptorStatus => {
      if (!fromAppWindow(event)) return FALLBACK_INTERCEPTOR_STATE
      return embed.setInterceptorEnabled(Boolean(enabled))
    }
  )

  /* ---------------- automation ---------------- */

  ipcMain.handle(IpcChannels.automationGetState, (event): AutomationState => {
    return fromAppWindow(event) && runner ? runner.getAutomation() : FALLBACK_AUTOMATION
  })

  ipcMain.handle(
    IpcChannels.automationSetMode,
    (event, mode: string): AutomationState => {
      if (!fromAppWindow(event)) return FALLBACK_AUTOMATION
      return applyExecutionMode(mode === 'auto' ? 'auto' : 'manual') ?? FALLBACK_AUTOMATION
    }
  )

  ipcMain.handle(IpcChannels.automationSetPaused, (event, paused: boolean): AutomationState => {
    if (!fromAppWindow(event) || !runner) return FALLBACK_AUTOMATION
    const state = runner.setPaused(Boolean(paused))
    broadcastAutomation(state)
    return state
  })

  ipcMain.handle(IpcChannels.automationCheckNow, async (event): Promise<AutomationState> => {
    if (!fromAppWindow(event) || !runner) return FALLBACK_AUTOMATION
    // User's escape hatch: re-read the last reply even though it was already
    // treated as pre-existing.
    await embed.checkForCommandNow()
    return runner.getAutomation()
  })

  /* ---------------- executions ---------------- */

  ipcMain.handle(IpcChannels.executionList, (event, conversationId: string): ExecutionRecord[] => {
    if (!fromAppWindow(event) || !store) return []
    const id = typeof conversationId === 'string' ? conversationId : ''
    return id === '' ? [] : store.listExecutions(id)
  })

  ipcMain.handle(IpcChannels.executionRun, (event, messageId: string): ExecutionRecord[] => {
    if (!fromAppWindow(event) || !runner || !store) return []
    const id = String(messageId)
    const record = store.getExecution(id)
    if (!record) return []
    // Deliberately not awaited: a command may take a minute, and progress is
    // pushed through executionChanged / terminalChanged instead.
    void runner.runExecution(id)
    return store.listExecutions(record.conversationId)
  })

  ipcMain.handle(IpcChannels.executionSkip, (event, messageId: string): ExecutionRecord[] => {
    if (!fromAppWindow(event) || !runner || !store) return []
    const id = String(messageId)
    const record = store.getExecution(id)
    if (!record) return []
    runner.skipExecution(id)
    return store.listExecutions(record.conversationId)
  })

  /* ---------------- terminal ---------------- */

  ipcMain.handle(IpcChannels.terminalGetState, (event): TerminalState => {
    return fromAppWindow(event) && runner ? runner.getTerminalState() : FALLBACK_TERMINAL_STATE
  })

  ipcMain.handle(IpcChannels.terminalInput, (event, text: string): TerminalState => {
    if (!fromAppWindow(event) || !runner) return FALLBACK_TERMINAL_STATE
    void runner.sendTerminalInput(String(text ?? ''))
    return runner.getTerminalState()
  })

  ipcMain.handle(IpcChannels.terminalReset, (event): TerminalState => {
    if (!fromAppWindow(event) || !runner) return FALLBACK_TERMINAL_STATE
    runner.resetTerminal()
    return runner.getTerminalState()
  })

  ipcMain.handle(
    IpcChannels.terminalSetCwd,
    async (event, path: string): Promise<TerminalState> => {
      if (!fromAppWindow(event) || !runner) return FALLBACK_TERMINAL_STATE
      const state = await runner.setTerminalCwd(String(path ?? ''))
      // Sequential, not parallel: the probe must see the NEW directory.
      await probeEnvironment()
      return state
    }
  )

  ipcMain.handle(IpcChannels.environmentGet, (event): EnvironmentInfo => {
    if (!fromAppWindow(event)) return { ...FALLBACK_ENVIRONMENT }
    return { ...environment }
  })

  /* ---------------- per-machine notes ---------------- */

  ipcMain.handle(IpcChannels.terminalNotesGet, (event): TerminalNotes => {
    return fromAppWindow(event) ? currentNotes() : { scope: 'local', hostId: '', label: '', text: '' }
  })

  ipcMain.handle(IpcChannels.terminalNotesSet, (event, text: string): TerminalNotes => {
    return fromAppWindow(event) ? applyTerminalNotes(String(text ?? '')) : currentNotes()
  })

  /* ---------------- ssh ---------------- */

  ipcMain.handle(IpcChannels.sshGetState, (event): SshState => {
    return fromAppWindow(event) && ssh ? ssh.getState() : { ...EMPTY_SSH_STATE }
  })

  ipcMain.handle(IpcChannels.sshListHosts, (event): SshHost[] => {
    return fromAppWindow(event) && store ? store.listSshHosts() : []
  })

  ipcMain.handle(IpcChannels.sshRemoveHost, (event, id: string): SshHost[] => {
    if (!fromAppWindow(event) || !store) return []
    store.removeSshHost(String(id ?? ''))
    return store.listSshHosts()
  })

  ipcMain.handle(IpcChannels.sshConnect, (event, draft: SshHostDraft): SshState => {
    if (!fromAppWindow(event) || !ssh || !store) return { ...EMPTY_SSH_STATE }

    const host = String(draft?.host ?? '').trim()
    const username = String(draft?.username ?? '').trim()
    const name = String(draft?.name ?? '').trim() || host
    const rawPort = Number(draft?.port)
    const port = Number.isFinite(rawPort) && rawPort > 0 && rawPort < 65536 ? rawPort : 22
    const typed = typeof draft?.password === 'string' ? draft.password : ''
    const proxy = normalizeProxy(String(draft?.proxy ?? '') || settings.sshProxy)

    if (host === '' || username === '') {
      return { ...EMPTY_SSH_STATE, status: 'error', attached: true, message: '需要填写主机地址和用户名' , lines: [{ kind: 'error', text: '需要填写主机地址和用户名' }] }
    }

    const id = typeof draft?.id === 'string' && draft.id !== '' ? draft.id : randomUUID()

    // Persist first so a stored password survives even a failed handshake.
    // An empty typed password means "keep whatever is already saved".
    store.upsertSshHost({
      id,
      name,
      host,
      port,
      username,
      proxy: String(draft?.proxy ?? ''),
      secret: encryptSecret(typed)
    })

    const password = typed !== '' ? typed : decryptSecret(store.getSshSecret(id))
    if (password === '') {
      const message = safeStorage.isEncryptionAvailable()
        ? '请输入密码（这台主机还没有保存过密码）'
        : '请输入密码（当前系统不支持安全保存密码，每次连接都需要重新输入）'
      return {
        ...EMPTY_SSH_STATE,
        status: 'error',
        attached: true,
        name,
        target: `${host}:${port}`,
        message,
        lines: [{ kind: 'error', text: message }]
      }
    }

    // Returns immediately with `connecting`; the outcome is pushed.
    return ssh.connect({ hostId: id, name, host, port, username, password, proxy })
  })

  ipcMain.handle(IpcChannels.sshDisconnect, (event): SshState => {
    if (!fromAppWindow(event) || !ssh) return { ...EMPTY_SSH_STATE }
    return ssh.disconnect()
  })

  ipcMain.handle(IpcChannels.sshDismiss, (event): SshState => {
    if (!fromAppWindow(event) || !ssh) return { ...EMPTY_SSH_STATE }
    return ssh.dismiss()
  })

  ipcMain.handle(IpcChannels.sshInput, (event, text: string): SshState => {
    if (!fromAppWindow(event) || !ssh) return { ...EMPTY_SSH_STATE }
    ssh.write(String(text ?? ''))
    return ssh.getState()
  })

  /* ---------------- settings ---------------- */

  ipcMain.handle(IpcChannels.settingsGet, (event): AppSettings => {
    if (!fromAppWindow(event)) return { embedProxy: '', sshProxy: '' }
    return { ...settings }
  })

  ipcMain.handle(
    IpcChannels.settingsUpdate,
    async (event, patch: AppSettingsPatch): Promise<AppSettings> => {
      if (!fromAppWindow(event) || !store) return { ...settings }

      if (typeof patch?.embedProxy === 'string') {
        const proxy = normalizeProxy(patch.embedProxy)
        settings = { ...settings, embedProxy: proxy }
        store.setSetting(SETTING_EMBED_PROXY, proxy)
        await applyEmbedProxy(proxy)
        // The page is already loaded over the old route; reload so the change is
        // actually observable instead of silently doing nothing.
        embed.reload()
      }

      if (typeof patch?.sshProxy === 'string') {
        // Only stored — SSH reads it when a connection is opened, so there is
        // nothing to re-apply and no page to reload.
        const proxy = normalizeProxy(patch.sshProxy)
        settings = { ...settings, sshProxy: proxy }
        store.setSetting(SETTING_SSH_PROXY, proxy)
      }

      return { ...settings }
    }
  )
}

// A second instance should focus the existing window instead of opening a new one.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  void app.whenReady().then(async () => {
    if (process.platform === 'win32') {
      app.setAppUserModelId('com.example.gptweb2codexterminal')
    }

    // The database lives beside the app's other user data, so it survives
    // reinstalls and stays per-user.
    const conversationStore = new ConversationStore(
      join(app.getPath('userData'), 'conversations.db')
    )
    store = conversationStore

    // Placeholder routes such as /c/WEB were storable before ids were validated
    // by shape; clear any that were already persisted.
    const purged = conversationStore.purgeInvalidIds(isConversationId)
    if (purged > 0) console.info(`[db] removed ${purged} non-conversation row(s)`)

    runner = new CommandRunner({
      store: conversationStore,
      currentConversationId: () => embed.getState().conversationId,
      sendRawToPage: (text) => embed.sendRaw(text),
      // Read on every use, never captured: an SSH session can attach or drop at
      // any moment, and a stale answer here means running the model's Linux
      // commands on Windows.
      remoteShell: () => remoteShell,
      // The pane shows the SSH transcript while attached, so the model's own
      // commands have to be mirrored into it or they would be invisible.
      onRemoteLine: (line) => ssh?.pushModelLine(line),
      onRemoteOutput: (chunk) => ssh?.pushModelOutput(chunk),
      onExecutionChanged: (records) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IpcChannels.executionChanged, records)
        }
      },
      onTerminalChanged: (state) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IpcChannels.terminalChanged, state)
        }
      }
    })

    // Restore the persisted execution mode before the window (and its page) exist,
    // so the very first load already knows whether to suppress its history.
    // restoreMode (not setMode) so a saved "auto" does not execute last
    // session's backlog on launch.
    const savedMode = conversationStore.getSetting(SETTING_EXECUTION_MODE)
    const initialMode: ExecutionMode = savedMode === 'auto' ? 'auto' : 'manual'
    runner.restoreMode(initialMode)
    embed.setBaselinePolicy(initialMode === 'auto')

    // Settings must be applied BEFORE the window exists, so the very first request
    // the embedded page makes already goes through the proxy.
    settings = {
      embedProxy: conversationStore.getSetting(SETTING_EMBED_PROXY) ?? '',
      sshProxy: conversationStore.getSetting(SETTING_SSH_PROXY) ?? ''
    }
    await applyEmbedProxy(settings.embedProxy)

    // The SSH pane pushes its own state. Command execution is deliberately
    // coupled to it: attaching a host hands the model's commands to that host,
    // and the prompt is rebuilt to describe it, in the same step.
    ssh = new SshManager((state) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IpcChannels.sshChanged, state)
      }

      /*
       * Identity, not status. The command channel can die and be reopened while
       * the connection itself stays up, and the connection can report `connected`
       * repeatedly for reasons that have nothing to do with execution. Comparing
       * the backend object catches exactly the transitions that matter, including
       * the gap where commands briefly fell back to the local machine.
       */
      const next = ssh?.execShell() ?? null
      if (next !== remoteShell) {
        remoteShell = next
        void probeEnvironment()
      }
    })

    registerIpcHandlers()
    createWindow()

    /*
     * Probe the machine through the terminal the user can see, then swap in the
     * real prompt.
     *
     * Deliberately NOT awaited: the window should not wait on a PowerShell
     * process to appear, and the prompt is only needed when the user actually
     * sends something. The pane pulls the accumulated output on mount, so nothing
     * is lost even if the probe finishes first.
     */
    void probeEnvironment()

    // macOS: re-create a window when the dock icon is clicked and none are open.
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

// macOS keeps the app alive after the last window closes; other platforms do not.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  // Close SSH sockets before the process goes away. This also disposes the
  // remote command channel, so no session outlives the window that drove it.
  ssh?.dispose()
  ssh = null
  remoteShell = null
  // Never leave orphaned PowerShell processes behind.
  runner?.disposeAll()
  runner = null
  store?.close()
  store = null
})
