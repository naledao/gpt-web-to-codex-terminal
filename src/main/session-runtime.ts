import { randomUUID } from 'node:crypto'
import { BrowserWindow, Notification, safeStorage } from 'electron'
import {
  FALLBACK_ENVIRONMENT,
  IpcChannels,
  buildTerminalPrefix
} from '../shared/types'
import { CHAT_PLATFORMS } from '../shared/platforms'
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
import type { EmbedHandlers } from './embed'
import { parseRemoteEnvironment, parseWindowsEnvironment } from './environment'
import { resolvePowerShell } from './shell'
import { SshManager } from './ssh'
import type { RemoteShell } from './remote-shell'

const SETTING_EXECUTION_MODE = 'executionMode'
const SETTING_LOCAL_NOTES = 'localTerminalNotes'

/**
 * One platform's embedded view plus the state that must survive being hidden.
 *
 * `conversationId` and `url` are per-platform because each site has its own notion of "where
 * this session is" — the same session id means a ChatGPT `/c/<uuid>` and a DeepSeek
 * `/a/chat/s/<uuid>`, and neither is meaningful on the other site. Keeping one pair for the
 * session would make the two views overwrite each other's location on every switch.
 */
interface PlatformEmbed {
  readonly platform: ChatPlatform
  /** Created on first use; see `ensureEmbed`. */
  embed: ChatGptEmbed | null
  conversationId: string | null
  url: string
}

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
   * Which chat site this session starts on.
   *
   * Required. A default would let a DeepSeek session inherit ChatGPT's partition and URL
   * patterns, which fails as "signed into the wrong account" rather than as an error.
   *
   * This is the STARTING site, not a permanent property: the user can switch platforms from
   * inside the chat and both views stay alive. See `embeds`.
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
  initialSendDelaySeconds?: number
  store: ConversationStore
  localMachineId: string
  initialMode: ExecutionMode
  settings: () => { embedProxy: string; sshProxy: string }
  onSummaryChanged: () => void
  onTransfersChanged: () => void
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

  /**
   * One embedded view per chat platform, ALL kept alive.
   *
   * WHY NOT ONE VIEW THAT GETS REPLACED
   * -----------------------------------
   * The obvious design is to rebuild the session when the user switches models. That would
   * call `dispose()`, which tears down `ssh` and the terminal — so switching models would
   * silently drop a live SSH connection, clear the terminal scrollback, and lose the
   * conversation on both sides. `SessionRuntime` owns the machine (terminal, SSH, environment
   * probe) as well as the chat, so the chat is the part that must be swappable in place.
   *
   * Keeping both views alive costs one extra WebContents and makes switching a visibility
   * change: each platform keeps its own conversation, its own scroll position, and its own
   * in-flight reply. The same reasoning as "one terminal, not one per conversation" — the
   * expensive shared thing (the machine) does not move when only the model changes.
   */
  private readonly embeds = new Map<string, PlatformEmbed>()
  private activePlatformId: string
  private remoteShell: RemoteShell | null = null
  private customTitle: string
  private sshCwd: string
  private lastPersistedLocalCwd: string
  private disposed = false
  private active = false
  private lastSummaryTaskRunning = false
  private embedVisible = true
  /**
   * Last rectangle the renderer reported for the slot.
   *
   * Kept because a platform view can be created AFTER the renderer last measured: the
   * `ResizeObserver` only fires on a resize, so nothing would tell the new view where the slot
   * is and it would appear at its default size. Applying the remembered rectangle at creation
   * keeps that from depending on a second renderer round-trip.
   */
  private lastBounds: EmbedBounds | null = null
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
    this.sshCwd = options.initialSshCwd?.trim() ?? ''
    this.lastPersistedLocalCwd = options.initialLocalCwd?.trim() ?? ''
    this.activePlatformId = options.platform.id

    for (const platform of CHAT_PLATFORMS) {
      /*
       * Every platform gets a slot, but only the one being restored gets a live view. The
       * other is created on first switch (`ensureEmbed`) and stays alive from then on — which
       * is what preserves its conversation and scroll position across later switches.
       *
       * Not created up front because a session sitting in the manager would otherwise load two
       * sites nobody is looking at, which also means two sets of background beacons.
       */
      const isStarting = platform.id === options.platform.id
      this.embeds.set(platform.id, {
        platform,
        embed: null,
        conversationId: isStarting ? options.initialConversationId ?? null : null,
        url: isStarting ? options.initialUrl ?? '' : ''
      })
    }
    this.ensureEmbed(options.platform.id)

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
    this.runner.setSendDelay(options.initialSendDelaySeconds ?? 0)
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
    }, (downloads) => {
      this.send(IpcChannels.sshDownloadsChanged, downloads)
      this.options.onTransfersChanged()
    }, (uploads) => {
      this.send(IpcChannels.sshUploadsChanged, uploads)
      this.options.onTransfersChanged()
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

  /**
   * Handlers for ONE platform's view.
   *
   * `platform` is a parameter rather than read from `this`, because the closures are created
   * during construction — before `this.activePlatformId` means anything — and because a
   * handler that guessed its own platform would attribute a background page's events to
   * whichever view happens to be in front.
   */
  private embedHandlers(platform: ChatPlatform): EmbedHandlers {
    const record = (): PlatformEmbed => this.embeds.get(platform.id) as PlatformEmbed
    /*
     * A FUNCTION, not a captured boolean. The handlers outlive a platform switch and are how
     * the background view reports in, so "am I the visible one" has to be asked at event time
     * — capture it and the view in front would keep the old answer forever.
     */
    const isActive = (): boolean => platform.id === this.activePlatformId

    return {
      onState: (state) => {
        const entry = record()
        if (state.url !== '') entry.url = state.url

        /*
         * Only the visible view drives the UI. A background platform keeps its own state
         * (url, conversation id) so switching back lands where it was, but pushing its
         * `embed:state` would overwrite the address bar and status line of the view the
         * user is actually looking at.
         */
        if (isActive()) this.send(IpcChannels.embedState, state)

        if (state.conversationId !== entry.conversationId) {
          const previousConversationId = entry.conversationId
          entry.conversationId = state.conversationId
          const createdNewChat = previousConversationId === null && state.conversationId !== null
          /*
           * Arming the baseline on a background view would be wasted work, and skipping it
           * is safe: showing a platform again re-arms through `switchPlatform`.
           */
          if (!createdNewChat && isActive() && this.runner?.getAutomation().mode === 'auto') {
            // `entry.embed` exists whenever a handler can fire: the handlers are passed to the
            // embed's own constructor, so this event came from it.
            void entry.embed?.armCommandBaseline()
          }
        }
        this.options.onSummaryChanged()
      },
      onExternalAuth: (notice) => {
        this.externalAuthNotice = notice
        if (isActive()) this.send(IpcChannels.embedExternalAuth, notice)
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
        const taskRunning = status.taskStartedAt !== null && status.taskFinishedAt === null
        if (isActive() && taskRunning !== this.lastSummaryTaskRunning) {
          this.lastSummaryTaskRunning = taskRunning
          this.options.onSummaryChanged()
        }
        if (isActive()) this.send(IpcChannels.interceptorEvent, status)
      },
      onTaskCompleted: () => {
        if (isActive()) this.notifyTaskCompleted('任务已完成')
      },
      /*
       * ONLY the visible platform feeds the command loop.
       *
       * Not an optimisation — two live views with automation on would mean two sources of
       * "the model asked for this", and `executions.message_id` is the idempotency key that
       * makes a command run once. A hidden DeepSeek tab replaying its history into the same
       * terminal as the ChatGPT tab in front would be untraceable. Commands are recorded
       * under the conversation they were read from, so the visible one is the only correct
       * answer to "which conversation is this session driving".
       */
      onCommand: (command) => {
        /*
         * Logged on BOTH sides of the gate.
         *
         * "The page reported a command" and "the app acted on one" are different facts, and
         * `isActive()` is what sits between them: with another platform in front, a command read
         * from a background view is dropped here — deliberately, and until now invisibly. That is
         * the combination that makes "the model answered with JSON and nothing ran" impossible to
         * diagnose from a log, which is exactly how this was found.
         */
        if (!isActive()) {
          console.warn(
            `[session] command DROPPED, this session is not the visible one ${JSON.stringify({
              messageId: command.messageId,
              command: command.command
            })}`
          )
          return
        }
        console.info(
          `[session] command accepted ${JSON.stringify({
            messageId: command.messageId,
            description: command.description
          })}`
        )
        this.handleDetectedCommand(command)
      },
      onParseFailed: (text) => {
        console.warn(`[session] reply did not parse as a command ${JSON.stringify({ text })}`)
        if (isActive()) this.runner.noteParseFailure(text)
      }
    }
  }

  private activeEmbed(): PlatformEmbed {
    const entry = this.embeds.get(this.activePlatformId)
    if (entry) return entry
    // Unreachable unless a platform id was persisted that no longer exists; fall back rather
    // than throw, because a stored row must never be able to make a session unopenable.
    const fallback = [...this.embeds.values()][0]
    this.activePlatformId = fallback.platform.id
    return fallback
  }

  /**
   * Create one platform's view if it does not exist yet, and keep it from then on.
   *
   * Idempotent, because it is called from every path that needs the view to exist (construction,
   * attach, switch) and a second call must never create a second page for one platform — that
   * would put two views on the same partition and make `getState()` ambiguous.
   */
  private ensureEmbed(platformId: string): PlatformEmbed {
    const entry = this.embeds.get(platformId) as PlatformEmbed
    if (entry.embed) return entry

    entry.embed = new ChatGptEmbed(
      entry.platform,
      this.embedHandlers(entry.platform),
      entry.url || entry.platform.homeUrl
    )
    if (this.window && !this.window.isDestroyed()) {
      entry.embed.attach(this.window)
      entry.embed.setVisible(false)
    }
    // The renderer measured the slot long before this view existed; see `lastBounds`.
    if (this.lastBounds) entry.embed.setBounds(this.lastBounds)
    entry.embed.setBaselinePolicy(this.runner?.getAutomation().mode === 'auto')
    /*
     * A NEW EMBED STARTS WITH THE FALLBACK PROMPT, so the runtime's real one has to be pushed
     * into it here.
     *
     * `ChatGptEmbed` holds the prefix per view, and every other call site pushes it to the
     * ACTIVE view (`this.embed.setPromptPrefix(...)`). A view created later therefore keeps the
     * generic fallback — which does not describe this machine — and switching to it would
     * inject the wrong prompt, or (when the fallback is identical to what the page already has)
     * look like nothing was injected at all.
     */
    entry.embed.setPromptPrefix(buildTerminalPrefix(this.environment))
    return entry
  }

  /** The view the user is looking at. Kept for the many call sites that mean "the chat". */
  get embed(): ChatGptEmbed {
    const entry = this.activeEmbed()
    return entry.embed ?? this.ensureEmbed(entry.platform.id).embed!
  }

  attach(parent: BrowserWindow): void {
    if (this.window === parent && !parent.isDestroyed()) return
    this.window = parent
    /*
     * Only the view already in use is attached here. The other platform's view is created when
     * it is first switched to (`ensureEmbed` attaches it then), so a session that is never
     * switched loads exactly one site — attaching every platform here would put both sites on
     * the wire for every session the app restores.
     */
    this.ensureEmbed(this.activePlatformId)
    this.embed.attach(parent)
    this.embed.setVisible(false)
    this.options.onSummaryChanged()
    if (this.ssh.getState().status !== 'connecting') void this.probeEnvironment()
  }

  setActive(active: boolean): void {
    this.active = active
    this.applyVisibility()
  }

  /**
   * Show one platform's view and hide the other.
   *
   * Only the visible view is driveable, so this is also where the command baseline is re-armed:
   * the newly shown page has replies on screen that were written long ago, and without a fresh
   * baseline the next check would treat the last one as a live command and execute it.
   *
   * Refused while a task is running, and that guard is HERE rather than only on the button:
   * switching mid-task would hide the page whose reply the loop is waiting on, and the command
   * it eventually produces would be attributed to a conversation that is no longer in front.
   */
  switchPlatform(platformId: string): boolean {
    const entry = this.embeds.get(platformId)
    if (!entry || platformId === this.activePlatformId) return false
    if (this.taskRunning()) return false
    this.activePlatformId = platformId
    // Created here on first switch, and kept alive after that so its conversation survives.
    const created = this.ensureEmbed(platformId)
    const embed = created.embed as ChatGptEmbed
    /*
     * Re-pushed on every switch, not just at creation: this view may have been created before
     * the last environment probe or SSH handover, in which case its copy of the prompt is stale
     * and the page would inject a description of the wrong machine.
     */
    embed.setPromptPrefix(buildTerminalPrefix(this.environment))
    this.applyVisibility()
    void embed.armCommandBaseline()
    /*
     * One line naming the platform, the prompt length, and whether the environment behind it is
     * the real probe result or the generic fallback.
     *
     * The prompt is stored per view, so "this view has the wrong prompt" has no symptom other
     * than messages going out un-prefixed — which looks exactly like terminal mode being off.
     * `detected` is what separates a probed machine from `FALLBACK_ENVIRONMENT`; the length
     * alone does not, because the two can coincide.
     */
    const prefix = buildTerminalPrefix(this.environment)
    console.info(
      `[session] ${this.id.slice(0, 8)} switched to ${entry.platform.label} ` +
        `(prompt=${prefix.length} detected=${this.environment.detected} ` +
        `os=${JSON.stringify(this.environment.osCaption)})`
    )
    /*
     * Push the new view's state immediately instead of waiting for its next event: a page that
     * is already loaded and idle emits nothing, so the address bar and the interceptor panel
     * would keep describing the platform that is no longer on screen.
     */
    this.send(IpcChannels.embedState, embed.getState())
    this.send(IpcChannels.interceptorEvent, embed.getInterceptorStatus())
    this.options.onSummaryChanged()
    return true
  }

  /** Which platform this session is currently showing. */
  get activePlatform(): ChatPlatform {
    return this.activeEmbed().platform
  }

  private applyVisibility(): void {
    for (const entry of this.embeds.values()) {
      // A platform that was never switched to has no view yet, and must not get one merely
      // because visibility was recalculated.
      if (!entry.embed) continue
      const visible = this.active && this.embedVisible && entry.platform.id === this.activePlatformId
      entry.embed.setVisible(visible)
    }
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
    sendDelaySeconds: number
    createdAt: number
  } {
    const automation = this.runner.getAutomation()
    const terminal = this.runner.getTerminalState()
    const sshState = this.ssh.getState()
    const active = this.activeEmbed()
    return {
      id: this.id,
      title: this.customTitle,
      /*
       * The persisted url/conversationId/platformId are the ACTIVE platform's. One session
       * stores one location, so restoring must reopen the view the user last had in front —
       * storing the starting platform instead would reopen ChatGPT every time even if the
       * user had switched to DeepSeek and left it there.
       */
      url: active.url,
      conversationId: active.conversationId,
      platformId: active.platform.id,
      paused: automation.paused,
      localCwd: terminal.cwd,
      sshHostId: sshState.hostId,
      sshAttached: sshState.attached,
      sshReconnect: sshState.attached && sshState.status !== 'disconnected',
      sshCwd: this.sshCwd,
      sendDelaySeconds: terminal.sendDelaySeconds,
      createdAt: this.createdAt
    }
  }
  /**
   * Which chat site this session is currently showing.
   *
   * The ACTIVE one, not the starting one: the session-import and auth-state paths use this to
   * decide which site's cookies and login page they are talking about, and after a switch the
   * answer must be the view in front.
   */
  get chatPlatform(): ChatPlatform {
    return this.activeEmbed().platform
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
      platformId: this.activeEmbed().platform.id,
      taskRunning: this.taskRunning(),
      createdAt: this.createdAt
    }
  }

  setEmbedBounds(bounds: EmbedBounds): void {
    /*
     * Only the view in front is told the bounds. A hidden platform that was never switched to
     * has no view yet; and once created, `ensureEmbed` gives it the slot rectangle the first
     * time it is shown — so a stale rectangle cannot be applied to a view that is not there.
     */
    this.embed.setBounds(bounds)
    this.lastBounds = bounds
  }

  setEmbedVisible(visible: boolean): void {
    /*
     * Remembered rather than applied directly, because "visible" now has two inputs (is this
     * session in front, and is this platform the shown one). Applying `visible` to the active
     * view alone would lose the request when it arrives while the session is in the manager.
     */
    this.embedVisible = visible
    this.applyVisibility()
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
    /*
     * A deferred command is in limbo, and until now it was in limbo silently — if the
     * conversation id never arrives, it is simply never heard from again.
     */
    console.info(
      `[session] command DEFERRED until a conversation id exists ` +
        `${JSON.stringify({ messageId: command.messageId, waiting: this.deferredCommands.size })}`
    )
  }

  private flushDeferredCommands(conversationId: string): void {
    if (this.deferredCommands.size === 0) return
    const before = this.deferredCommands.size
    for (const [messageId, command] of this.deferredCommands) {
      if (this.runner.handleDetected(command, conversationId)) {
        this.deferredCommands.delete(messageId)
      }
    }
    console.info(
      `[session] flushed deferred commands for ${conversationId}: ` +
        `${before - this.deferredCommands.size}/${before} accepted, ` +
        `${this.deferredCommands.size} still waiting`
    )
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

  /** Pace the loop without touching any stored state or the environment probe. */
  setTerminalSendDelay(seconds: number): TerminalState {
    const state = this.runner.setSendDelay(seconds)
    this.options.onSummaryChanged()
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

  /** True once dispose() has run. Callers holding a runtime reference across an async boundary (e.g. a late SSH event) must check this before touching state. */
  isDisposed(): boolean {
    return this.disposed
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.active = false
    this.deferredCommands.clear()
    const window = this.window
    if (window && !window.isDestroyed()) {
      // Every view that exists, not just the active one: a platform switched away from owns a
      // live WebContents too, and destroying only the visible one would leak a running page.
      for (const entry of this.embeds.values()) entry.embed?.destroy(window)
    }
    this.ssh.dispose()
    this.embeds.clear()
    this.window = null
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
    if (this.active && window && !window.isDestroyed() && window.isFocused()) return
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