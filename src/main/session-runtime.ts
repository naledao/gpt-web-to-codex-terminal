import { randomUUID } from 'node:crypto'
import { BrowserWindow, Notification, safeStorage } from 'electron'
import {
  FALLBACK_ENVIRONMENT,
  IpcChannels,
  buildTerminalPrefix
} from '../shared/types'
import type { ChatPlatform } from '../shared/platforms'
import type {
  AutomationState,
  Conversation,
  EmbedBounds,
  EmbedCommand,
  EnvironmentInfo,
  ExecutionMode,
  ExternalAuthNotice,
  ManagedSessionSummary,
  ParsedCommand,
  SshHost,
  SshHostDraft,
  SshState,
  TerminalNotes,
  TerminalState
} from '../shared/types'
import { CommandRunner } from './commands'
import { ConversationStore } from './db'
import { ChatGptEmbed } from './embed'
import { parseRemoteEnvironment, parseWindowsEnvironment } from './environment'
import { resolvePowerShell } from './shell'
import { SshManager } from './ssh'
import type { RemoteShell } from './remote-shell'

const SETTING_EXECUTION_MODE = 'executionMode'
const SETTING_LOCAL_NOTES = 'localTerminalNotes'

export const EMPTY_SSH_STATE: SshState = {
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

export interface SessionRuntimeOptions {
  /**
   * Which chat site this session drives.
   *
   * Required. A default would let a DeepSeek session inherit ChatGPT's partition and URL
   * patterns, which fails as "signed into the wrong account" rather than as an error.
   */
  platform: ChatPlatform
  id?: string
  createdAt?: number
  customTitle?: string
  initialUrl?: string
  initialConversationId?: string | null
  initialPaused?: boolean
  initialLocalCwd?: string
  initialSshHostId?: string
  initialSshAttached?: boolean
  initialSshReconnect?: boolean
  initialSshCwd?: string
  store: ConversationStore
  localMachineId: string
  initialMode: ExecutionMode
  settings: () => { embedProxy: string; sshProxy: string }
  onSummaryChanged: () => void
  onActivate: (id: string) => void
}

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

function normalizeProxy(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '') return ''
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
}

export class SessionRuntime {
  readonly id: string
  readonly createdAt: number
  readonly embed: ChatGptEmbed
  readonly runner: CommandRunner
  readonly ssh: SshManager

  window: BrowserWindow | null = null
  externalAuthNotice: ExternalAuthNotice | null = null
  environment: EnvironmentInfo = { ...FALLBACK_ENVIRONMENT }
  environmentScope: Pick<TerminalNotes, 'scope' | 'hostId' | 'label'> = {
    scope: 'local',
    hostId: '',
    label: '本机'
  }

  private remoteShell: RemoteShell | null = null
  private lastConversationId: string | null
  private lastKnownUrl: string
  private customTitle: string
  private sshCwd: string
  private lastPersistedLocalCwd: string
  private disposed = false
  private active = false
  private readonly deferredCommands = new Map<string, ParsedCommand>()
  /**
   * The last thing the user asked for, held until the conversation has an id.
   *
   * The first message of a new chat is sent while the SPA is still at `/`; the `/c/<id>`
   * URL appears only AFTER the send. So the goal is captured on send and associated
   * here, and `onConversation` flushes it — the same ordering problem
   * `deferredCommands` exists for.
   */
  private pendingGoal = ''

  constructor(private readonly options: SessionRuntimeOptions) {
    this.id = options.id ?? randomUUID()
    this.createdAt = options.createdAt ?? Date.now()
    this.customTitle = options.customTitle?.trim() ?? ''
    this.lastKnownUrl = options.initialUrl ?? ''
    this.lastConversationId = options.initialConversationId ?? null
    this.sshCwd = options.initialSshCwd?.trim() ?? ''
    this.lastPersistedLocalCwd = options.initialLocalCwd?.trim() ?? ''

    this.embed = new ChatGptEmbed(options.platform, {
      onState: (state) => {
        if (state.url !== '') this.lastKnownUrl = state.url
        this.send(IpcChannels.embedState, state)

        if (state.conversationId !== this.lastConversationId) {
          const previousConversationId = this.lastConversationId
          this.lastConversationId = state.conversationId
          const createdNewChat = previousConversationId === null && state.conversationId !== null
          if (!createdNewChat && this.runner?.getAutomation().mode === 'auto') {
            void this.embed.armCommandBaseline()
          }
        }
        this.options.onSummaryChanged()
      },
      onExternalAuth: (notice) => {
        this.externalAuthNotice = notice
        this.send(IpcChannels.embedExternalAuth, notice)
      },
      onConversation: (conversation) => {
        this.options.store.upsert(conversation, this.currentConversationProject())
        this.flushDeferredCommands(conversation.id)
        this.flushPendingGoal(conversation.id)
        this.broadcastConversations()
      },
      onSynced: (scraped) => {
        this.options.store.upsertMany(scraped)
        this.broadcastConversations()
      },
      onInterceptor: (status) => {
        this.captureGoal(status.lastSentText)
        this.send(IpcChannels.interceptorEvent, status)
      },
      onTaskCompleted: () => this.notifyTaskCompleted('任务已完成'),
      onCommand: (command) => this.handleDetectedCommand(command),
      onParseFailed: (text) => this.runner.noteParseFailure(text)
    }, options.initialUrl || options.platform.homeUrl)

    this.runner = new CommandRunner({
      store: options.store,
      currentConversationId: () => this.embed.getState().conversationId,
      sendRawToPage: (text) => this.embed.sendRaw(text),
      remoteShell: () => this.remoteShell,
      onRemoteLine: (line) => this.ssh.pushModelLine(line),
      onRemoteOutput: (chunk) => this.ssh.pushModelOutput(chunk),
      onExecutionChanged: (records) => this.send(IpcChannels.executionChanged, records),
      onTerminalChanged: (state) => {
        this.send(IpcChannels.terminalChanged, state)
        if (state.cwd !== this.lastPersistedLocalCwd) {
          this.lastPersistedLocalCwd = state.cwd
          this.options.onSummaryChanged()
        }
      },
      onTaskCompleted: (description) => {
        void this.embed.endTask()
        this.notifyTaskCompleted(description.trim() || '任务已完成')
      }
    }, options.initialLocalCwd ?? '')

    this.runner.restoreMode(options.initialMode)
    this.runner.restorePaused(options.initialPaused ?? false)
    this.embed.setBaselinePolicy(options.initialMode === 'auto')

    this.ssh = new SshManager((state) => {
      this.send(IpcChannels.sshChanged, state)
      if (state.modelCwd !== '') this.sshCwd = state.modelCwd
      this.options.onSummaryChanged()

      const next = this.ssh.execShell()
      if (next !== this.remoteShell) {
        const previous = this.remoteShell
        this.remoteShell = next
        if (previous === null || next === null) void this.probeEnvironment()
      } else if (next === null && state.status === 'error') {
        void this.probeEnvironment()
      }
    })

    const restoredHostId = options.initialSshHostId?.trim() ?? ''
    if (options.initialSshAttached && restoredHostId !== '') {
      const host = options.store.listSshHosts().find((item) => item.id === restoredHostId)
      if (host) {
        const target = { hostId: host.id, name: host.name, host: host.host, port: host.port }
        const canReconnect = options.initialSshReconnect && decryptSecret(options.store.getSshSecret(host.id)) !== ''
        if (canReconnect) {
          this.connectSsh(
            {
              id: host.id,
              name: host.name,
              host: host.host,
              port: host.port,
              username: host.username,
              password: '',
              proxy: host.proxy
            },
            this.sshCwd
          )
        } else {
          this.ssh.restoreAttachment(target)
        }
      }
    }
  }

  attach(parent: BrowserWindow): void {
    if (this.window === parent && !parent.isDestroyed()) return
    this.window = parent
    this.embed.attach(parent)
    this.embed.setVisible(false)
    this.options.onSummaryChanged()
    if (this.ssh.getState().status !== 'connecting') void this.probeEnvironment()
  }

  setActive(active: boolean): void {
    this.active = active
    if (!active) this.embed.setVisible(false)
  }

  focus(): boolean {
    const window = this.window
    if (!window || window.isDestroyed()) return false
    this.options.onActivate(this.id)
    if (window.isMinimized()) window.restore()
    if (!window.isVisible()) window.show()
    window.focus()
    return true
  }

  setTitle(title: string): void {
    this.customTitle = title.trim()
    this.options.onSummaryChanged()
  }

  persistentState(): {
    id: string
    title: string
    url: string
    conversationId: string | null
    platformId: string
    paused: boolean
    localCwd: string
    sshHostId: string
    sshAttached: boolean
    sshReconnect: boolean
    sshCwd: string
    createdAt: number
  } {
    const automation = this.runner.getAutomation()
    const terminal = this.runner.getTerminalState()
    const sshState = this.ssh.getState()
    return {
      id: this.id,
      title: this.customTitle,
      url: this.lastKnownUrl,
      conversationId: this.lastConversationId,
      platformId: this.options.platform.id,
      paused: automation.paused,
      localCwd: terminal.cwd,
      sshHostId: sshState.hostId,
      sshAttached: sshState.attached,
      sshReconnect: sshState.attached && sshState.status !== 'disconnected',
      sshCwd: this.sshCwd,
      createdAt: this.createdAt
    }
  }
  /** Which chat site this session drives. */
  get chatPlatform(): ChatPlatform {
    return this.options.platform
  }

  summary(): ManagedSessionSummary {
    const state = this.embed.getState()
    const sshState = this.ssh.getState()
    const usingSsh = sshState.attached
    return {
      id: this.id,
      title: this.customTitle || state.title || '当前会话',
      kind: usingSsh ? 'ssh' : 'local',
      target: usingSsh ? sshState.name || sshState.target || 'SSH' : '本机',
      conversationId: state.conversationId,
      platformId: this.options.platform.id,
      createdAt: this.createdAt
    }
  }

  setEmbedBounds(bounds: EmbedBounds): void {
    this.embed.setBounds(bounds)
  }

  setEmbedVisible(visible: boolean): void {
    this.embed.setVisible(visible)
  }

  private taskRunning(): boolean {
    const status = this.embed.getInterceptorStatus()
    return status.taskStartedAt !== null && status.taskFinishedAt === null
  }

  sendEmbedCommand(command: EmbedCommand): void {
    if (this.taskRunning() && command !== 'stop') return
    this.embed.command(command)
  }

  navigateEmbed(url: string): void {
    if (this.taskRunning()) return
    this.embed.navigate(url)
  }

  async endTask() {
    this.deferredCommands.clear()
    const runner = this.runner.endTask()
    const status = await this.embed.endTask()
    await runner
    return status
  }

  private handleDetectedCommand(command: ParsedCommand): void {
    if (this.runner.handleDetected(command)) return

    // New chats navigate from '/' to /c/<id> asynchronously. A fast assistant
    // reply can therefore be detected before getState() exposes its conversation
    // id. Keep the command by message id and associate it when onConversation has
    // persisted the new chat, rather than losing it permanently.
    this.deferredCommands.set(command.messageId, command)
  }

  private flushDeferredCommands(conversationId: string): void {
    if (this.deferredCommands.size === 0) return
    for (const [messageId, command] of this.deferredCommands) {
      if (this.runner.handleDetected(command, conversationId)) {
        this.deferredCommands.delete(messageId)
      }
    }
  }

  /**
   * Remember what the user asked for.
   *
   * Called on EVERY interceptor push, because that is the only place the page reports
   * the user's own words — the main process never sees the composer. The comparison
   * against the previous value is what keeps it from being a write per event, and the
   * blank check matters because a `sent` report can legitimately carry nothing.
   */
  private captureGoal(sentText: string | null): void {
    const text = (sentText ?? '').trim()
    if (text === '' || text === this.pendingGoal) return
    this.pendingGoal = text

    const conversationId = this.embed.getState().conversationId
    if (conversationId) {
      this.flushPendingGoal(conversationId)
      return
    }

    // No id yet (the first message of a new chat): `onConversation` will fire once the
    // SPA assigns one, and flushPendingGoal() writes it then.
  }

  /** Persist the captured goal, if there is one and the conversation is known. */
  private flushPendingGoal(conversationId: string): void {
    if (this.pendingGoal === '') return
    if (this.options.store.setGoal(conversationId, this.pendingGoal)) {
      this.broadcastConversations()
    }
  }

  currentMachineConversations(): Conversation[] {
    const hostId = this.environmentScope.scope === 'local' ? this.options.localMachineId : this.environmentScope.hostId
    return this.options.store.list(this.environmentScope.scope, hostId)
  }

  async refreshFromSidebar(): Promise<Conversation[]> {
    const scraped = await this.embed.scrapeConversations()
    if (scraped.length > 0) this.options.store.upsertMany(scraped)
    return this.currentMachineConversations()
  }

  applyExecutionMode(mode: ExecutionMode): AutomationState {
    const state = this.runner.setMode(mode)
    this.options.store.setSetting(SETTING_EXECUTION_MODE, mode)
    this.embed.setBaselinePolicy(mode === 'auto')
    this.send(IpcChannels.automationChanged, state)
    return state
  }

  setPaused(paused: boolean): AutomationState {
    const state = this.runner.setPaused(paused)
    this.send(IpcChannels.automationChanged, state)
    this.options.onSummaryChanged()
    return state
  }

  async setTerminalCwd(path: string): Promise<TerminalState> {
    const state = await this.runner.setTerminalCwd(path)
    await this.probeEnvironment()
    return state
  }

  currentNotes(): TerminalNotes {
    return { ...this.environmentScope, text: this.readNotes() }
  }

  applyTerminalNotes(raw: string): TerminalNotes {
    const text = raw.trim() === '' ? '' : raw
    if (this.environmentScope.scope === 'ssh' && this.environmentScope.hostId !== '') {
      this.options.store.setSshNote(this.environmentScope.hostId, text)
    } else {
      this.options.store.setSetting(SETTING_LOCAL_NOTES, text)
    }
    this.environment = { ...this.environment, extraNotes: text }
    this.embed.setPromptPrefix(buildTerminalPrefix(this.environment))
    this.send(IpcChannels.terminalNotesChanged, this.currentNotes())
    this.send(IpcChannels.environmentChanged, { ...this.environment })
    return this.currentNotes()
  }

  listSshHosts(): SshHost[] {
    return this.options.store.listSshHosts()
  }

  removeSshHost(id: string): SshHost[] {
    this.options.store.removeSshHost(id)
    return this.options.store.listSshHosts()
  }

  connectSsh(draft: SshHostDraft, resumeCwd = ''): SshState {
    const host = String(draft?.host ?? '').trim()
    const username = String(draft?.username ?? '').trim()
    const name = String(draft?.name ?? '').trim() || host
    const rawPort = Number(draft?.port)
    const port = Number.isFinite(rawPort) && rawPort > 0 && rawPort < 65536 ? rawPort : 22
    const typed = typeof draft?.password === 'string' ? draft.password : ''
    const proxy = normalizeProxy(String(draft?.proxy ?? '') || this.options.settings().sshProxy)

    if (host === '' || username === '') {
      return {
        ...EMPTY_SSH_STATE,
        status: 'error',
        attached: true,
        message: '需要填写主机地址和用户名',
        lines: [{ kind: 'error', text: '需要填写主机地址和用户名' }]
      }
    }

    const id = typeof draft?.id === 'string' && draft.id !== '' ? draft.id : randomUUID()
    const previousSshState = this.ssh.getState()
    this.options.store.upsertSshHost({
      id,
      name,
      host,
      port,
      username,
      proxy: String(draft?.proxy ?? ''),
      secret: encryptSecret(typed)
    })

    const password = typed !== '' ? typed : decryptSecret(this.options.store.getSshSecret(id))
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

    const requestedCwd = resumeCwd.trim()
    const reconnectCwd =
      requestedCwd !== '' ? requestedCwd : previousSshState.hostId === id ? this.sshCwd : ''
    return this.ssh.connect({ hostId: id, name, host, port, username, password, proxy }, reconnectCwd)
  }

  async probeEnvironment(): Promise<EnvironmentInfo> {
    try {
      const { kind, result } = await this.runner.runEnvironmentProbe()
      if (result.rejected || result.interrupted || result.timedOut || result.sessionLost) {
        return { ...this.environment }
      }

      const sshState = this.ssh.getState()
      const info =
        kind === 'posix'
          ? parseRemoteEnvironment(result.output, sshState.name ?? '', sshState.target ?? '')
          : parseWindowsEnvironment(result.output, resolvePowerShell())

      this.environmentScope =
        kind === 'posix'
          ? {
              scope: 'ssh',
              hostId: sshState.hostId ?? '',
              label: sshState.name || sshState.target || '远端主机'
            }
          : { scope: 'local', hostId: '', label: '本机' }

      info.extraNotes = this.readNotes()
      this.environment = info
      this.embed.setPromptPrefix(buildTerminalPrefix(info))
      this.send(IpcChannels.environmentChanged, { ...this.environment })
      this.send(IpcChannels.terminalNotesChanged, this.currentNotes())
      this.broadcastConversations()
      this.options.onSummaryChanged()
      return info
    } catch (error) {
      console.warn(`[env:${this.id}] probe failed:`, (error as Error).message)
      return { ...this.environment }
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.active = false
    this.deferredCommands.clear()
    const window = this.window
    if (window && !window.isDestroyed()) this.embed.destroy(window)
    this.window = null
    this.ssh.dispose()
    this.remoteShell = null
    this.runner.disposeAll()
  }

  private readNotes(): string {
    return this.environmentScope.scope === 'ssh' && this.environmentScope.hostId !== ''
      ? this.options.store.getSshNote(this.environmentScope.hostId)
      : (this.options.store.getSetting(SETTING_LOCAL_NOTES) ?? '')
  }

  private currentConversationProject(): {
    machineScope: 'local' | 'ssh'
    hostId: string
    machineLabel: string
    name: string
    path: string
  } | null {
    const projectPath = this.environment.workingDirectory.trim()
    if (projectPath === '') return null
    const parts = projectPath.split(/[\\/]+/).filter((part) => part !== '')
    return {
      machineScope: this.environmentScope.scope,
      hostId: this.environmentScope.scope === 'local' ? this.options.localMachineId : this.environmentScope.hostId,
      machineLabel: this.environmentScope.label,
      name: parts[parts.length - 1] ?? projectPath,
      path: projectPath
    }
  }

  private broadcastConversations(): void {
    this.send(IpcChannels.conversationsChanged, this.currentMachineConversations())
  }

  private notifyTaskCompleted(body: string): void {
    const window = this.window
    if (window && !window.isDestroyed() && window.isFocused()) return
    if (!Notification.isSupported()) return
    const notification = new Notification({ title: 'GPT Web to Codex Terminal', body })
    notification.on('click', () => this.focus())
    notification.show()
  }

  private send(channel: string, payload: unknown): void {
    const window = this.window
    if (!this.active || !window || window.isDestroyed()) return
    window.webContents.send(channel, payload)
  }
}