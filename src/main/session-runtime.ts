import { randomUUID } from 'node:crypto'
import { createConnection } from 'mysql2/promise'
import type { Connection } from 'mysql2/promise'
import { BrowserWindow, Notification, safeStorage } from 'electron'
import {
  FALLBACK_ENVIRONMENT,
  IpcChannels,
  buildTerminalPromptParts,
  toolPromptForPlatform,
  fileReadingPlatform,
  terminalNotesOwnerKey
} from '../shared/types'
import { CHAT_PLATFORMS, DEEPSEEK_PLATFORM } from '../shared/platforms'
import type { FileReadContext } from '../shared/file-requests'
import { prepareFiles } from './file-access'
import { homedir } from 'node:os'
import type { ChatPlatform } from '../shared/platforms'
import type {
  AppTheme,
  AutomationState,
  Conversation,
  ConversationImageAttachmentInput,
  EmbedBounds,
  EmbedCommand,
  EnvironmentInfo,
  ExecutionMode,
  InterceptorStatus,
  ManagedSessionSummary,
  MysqlConnectionDraft,
  MysqlConnectionsState,
  MysqlDatabaseList,
  MysqlTableData,
  MysqlTableDdl,
  MysqlTableList,
  MysqlSaveResult,
  NacosConnectionDraft,
  NacosConnectionsState,
  NacosSaveResult,
  ParsedAction,
  SshHost,
  SshHostDraft,
  SshState,
  TerminalNotes,
  TerminalNotesOwner,
  TerminalState
} from '../shared/types'
import { CommandRunner } from './commands'
import { ConversationStore } from './db'
import { normalizeNacosUrl } from './nacos-view'
import { ChatGptEmbed } from './embed'
import type { EmbedHandlers } from './embed'
import { parseRemoteEnvironment, parseWindowsEnvironment } from './environment'
import { resolvePowerShell } from './shell'
import { SshManager } from './ssh'
import type { RemoteShell } from './remote-shell'
import { normalizeTerminalNotesDirectory } from './terminal-notes'

const SETTING_EXECUTION_MODE = 'executionMode'
const SETTING_LOCAL_NOTES = 'localTerminalNotes'

/**
 * Whether a URL is worth storing as a session's location.
 *
 * A DENYLIST rather than an allowlist: sites add routes constantly, and an allowlist would make a
 * session with a novel-but-valid URL silently reopen at the home page. The cost of getting a
 * denylist wrong is only that a dead end opens somewhere useless — which is what it was doing
 * anyway.
 *
 * Two families are excluded, both redirects that a restart must never re-enter:
 *
 *   - **Auth dead ends.** `reauth=1` is an explicit "log out and start over" request, so loading
 *     it puts the app back into the auth flow — and Cloudflare re-challenges the protected auth
 *     host — every single launch. Measured on claude.ai: the session row held exactly such a URL
 *     and could never get past the challenge, while the same challenge cleared in ~24s when the
 *     page was entered at its normal URL.
 *   - **Bot-check interstitials.** `__cf_chl_` links are single-use and expire in minutes; a URL
 *     holding one is guaranteed to be stale by the next start.
 */
function isRestorableUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (/[?&]reauth=/.test(url.search)) return false
  if (url.searchParams.has('__cf_chl_tk') || url.searchParams.has('__cf_chl_rt_tk')) return false
  /*
   * `log-?in` / `log-?out` rather than the bare words, because the hyphenated spellings are
   * exactly the ones in use: OpenAI's sign-in page is `auth.openai.com/log-in`, and a first
   * version of this test asserted on it and failed. Cheap to cover both; the alternative is
   * discovering the hyphen one host at a time.
   */
  if (/^\/(log-?in|log-?out|sign-?in|sign-?up|register|auth)(\/|$)/i.test(url.pathname)) return false
  return true
}

/**
 * One platform's embedded view plus the state that must survive being hidden.
 *
 * `conversationId` and `url` are per-platform because each site has its own notion of "where
 * this session is" â€” the same session id means a ChatGPT `/c/<uuid>` and a DeepSeek
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
  ptyCwd: '',
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
  initialPromptInjectionEnabled?: boolean
  initialLocalCwd?: string
  initialSshHostId?: string
  initialSshAttached?: boolean
  initialSshReconnect?: boolean
  initialSshCwd?: string
  initialSendDelaySeconds?: number
  store: ConversationStore
  localMachineId: string
  initialMode: ExecutionMode
  /**
   * Only `sshProxy` and `theme` are read from here. The embed proxies are applied by
   * `index.ts` directly, per platform, and the theme is pushed to every view as it changes —
   * this callback is what a view created LATER reads, so it does not have to be told twice.
   * `embedProxy` is typed as the map it now is rather than omitting it, so this dependency
   * keeps mirroring `AppSettings` instead of becoming its own narrower shape that silently
   * drifts.
   */
  settings: () => { embedProxy: Record<string, string>; sshProxy: string; theme: AppTheme }
  onSummaryChanged: () => void
  onTransfersChanged: () => void
  onTerminalNotesSaved: (owner: TerminalNotesOwner) => void
  onActivate: (id: string) => void
  /**
   * The ACTIVE platform's view loaded its page for the first time.
   *
   * Startup uses this to close the splash window: the splash must not go away on a
   * timer, because a cold page on a slow network takes seconds and the user would
   * then stare at a blank workspace instead of the animation. Background platforms
   * deliberately do not report here - nobody is waiting on a page they cannot see.
   */
  onEmbedReady?: () => void
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

/**
 * Turn a mysql2 failure into one line a user can act on.
 *
 * mysql2 errors carry a `code` for the common causes (bad password, host unreachable,
 * unknown host) and a message that is already specific; the code is what makes the
 * difference between "it failed" and "the password is wrong". Anything without a code
 * falls back to the message, so an unexpected failure is still readable rather than blank.
 */
function mysqlErrorMessage(error: unknown): string {
  const record = error as { code?: unknown; message?: unknown }
  const message = typeof record?.message === 'string' ? record.message.trim() : ''
  switch (record?.code) {
    case 'ER_ACCESS_DENIED_ERROR':
      return `用户名或密码不正确。${message}`
    case 'ER_DBACCESS_DENIED_ERROR':
      return `当前用户没有查看数据库的权限。${message}`
    case 'ECONNREFUSED':
      return `无法连接：目标端口拒绝连接，请确认 MySQL 已启动并允许远程访问。${message}`
    case 'ETIMEDOUT':
    case 'PROTOCOL_SEQUENCE_TIMEOUT':
      return `连接超时：请确认主机地址、端口和防火墙设置。${message}`
    case 'ENOTFOUND':
      return `找不到主机：请检查主机地址是否正确。${message}`
    case 'ER_NOT_SUPPORTED_AUTH_MODE':
      return `服务器要求的认证方式不受支持。${message}`
    default:
      return message === '' ? '连接失败，请检查连接信息。' : message
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
   * call `dispose()`, which tears down `ssh` and the terminal â€” so switching models would
   * silently drop a live SSH connection, clear the terminal scrollback, and lose the
   * conversation on both sides. `SessionRuntime` owns the machine (terminal, SSH, environment
   * probe) as well as the chat, so the chat is the part that must be swappable in place.
   *
   * Keeping both views alive costs one extra WebContents and makes switching a visibility
   * change: each platform keeps its own conversation, its own scroll position, and its own
   * in-flight reply. The same reasoning as "one terminal, not one per conversation" â€” the
   * expensive shared thing (the machine) does not move when only the model changes.
   */
  private readonly embeds = new Map<string, PlatformEmbed>()
  private activePlatformId: string
  private preferredSendDelaySeconds: number
  private promptInjectionEnabled: boolean
  private remoteShell: RemoteShell | null = null
  private customTitle: string
  private sshCwd: string
  private lastPersistedLocalCwd: string
  private lastDirectoryNotes: TerminalNotes | null = null
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
  private readonly deferredCommands = new Map<string, ParsedAction>()
  /**
   * The last thing the user asked for, held until the conversation has an id.
   *
   * The first message of a new chat is sent while the SPA is still at `/`; the `/c/<id>`
   * URL appears only AFTER the send. So the goal is captured on send and associated
   * here, and `onConversation` flushes it â€” the same ordering problem
   * `deferredCommands` exists for.
   */
  private pendingGoal = ''
  /** Clean chat turns waiting for a brand-new conversation to receive its URL/id. */
  private readonly pendingConversationMessages = new Map<
    string,
    Array<{
      role: 'user' | 'assistant'
      text: string
      sourceMessageId: string | null
      attachments: ConversationImageAttachmentInput[]
    }>
  >()

  constructor(private readonly options: SessionRuntimeOptions) {
    this.id = options.id ?? randomUUID()
    this.createdAt = options.createdAt ?? Date.now()
    this.customTitle = options.customTitle?.trim() ?? ''
    this.sshCwd = options.initialSshCwd?.trim() ?? ''
    this.lastPersistedLocalCwd = options.initialLocalCwd?.trim() ?? ''
    this.activePlatformId = options.platform.id
    this.preferredSendDelaySeconds = options.initialSendDelaySeconds ?? 0
    this.promptInjectionEnabled = options.initialPromptInjectionEnabled ?? true

    for (const platform of CHAT_PLATFORMS) {
      /*
       * Every platform gets a slot, but only the one being restored gets a live view. The
       * other is created on first switch (`ensureEmbed`) and stays alive from then on â€” which
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
      fileContext: () => this.fileReadContext(),
      filePlatform: () => fileReadingPlatform(this.activePlatform.id),
      prepareFiles: (request, signal) => prepareFiles(request, signal, (path, limit, abort) => this.ssh.readFileForModel(path, request.context.hostId, limit, abort), fileReadingPlatform(this.activePlatform.id)?.id),
      sendFilesToPage: (result, token, current, signal) => this.embed.sendFileResult(result, token, current, signal),
      terminalModeEnabled: () => this.embed.getInterceptorStatus().enabled,
      remoteShell: () => this.remoteShell,
      onRemoteLine: (line) => this.ssh.pushModelLine(line),
      onRemoteOutput: (chunk) => this.ssh.pushModelOutput(chunk),
      onExecutionChanged: (records) => this.send(IpcChannels.executionChanged, records),
      onTerminalChanged: (state) => {
        this.send(IpcChannels.terminalChanged, state)
        this.refreshDirectoryNotes()
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
    this.runner.setSendDelay(options.platform.id === DEEPSEEK_PLATFORM.id ? 4 : this.preferredSendDelaySeconds)
    this.embed.setBaselinePolicy(options.initialMode === 'auto')

    this.ssh = new SshManager((state) => {
      this.send(IpcChannels.sshChanged, state)
      if (state.modelCwd !== '') this.sshCwd = state.modelCwd
      this.options.onSummaryChanged()

      const next = this.ssh.execShell()
      if (next !== this.remoteShell) {
        const previous = this.remoteShell
        this.remoteShell = next
        this.refreshDirectoryNotes()
        if (previous === null || next === null) void this.probeEnvironment()
      } else if (next === null && state.status === 'error') {
        this.refreshDirectoryNotes()
        void this.probeEnvironment()
      } else {
        this.refreshDirectoryNotes()
      }
    }, (downloads) => {
      this.send(IpcChannels.sshDownloadsChanged, downloads)
      this.options.onTransfersChanged()
    }, (uploads) => {
      this.send(IpcChannels.sshUploadsChanged, uploads)
      this.options.onTransfersChanged()
    })

    this.refreshDirectoryNotes()
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
   * during construction â€” before `this.activePlatformId` means anything â€” and because a
   * handler that guessed its own platform would attribute a background page's events to
   * whichever view happens to be in front.
   */
  private embedHandlers(platform: ChatPlatform): EmbedHandlers {
    const record = (): PlatformEmbed => this.embeds.get(platform.id) as PlatformEmbed
    /*
     * A FUNCTION, not a captured boolean. The handlers outlive a platform switch and are how
     * the background view reports in, so "am I the visible one" has to be asked at event time
     * â€” capture it and the view in front would keep the old answer forever.
     */
    const isActive = (): boolean => platform.id === this.activePlatformId

    return {
      onState: (state) => {
        const entry = record()
        /*
         * Remember the URL ONLY when it is one a restart should reopen.
         *
         * This used to store any non-empty URL, and that is how a session got stuck: claude.ai
         * redirected through an involuntary logout to
         * `/login?from=logout&reauth=1&returnTo=%2Fnew%3F`, that URL was written to the session
         * row, and every later start loaded it again. Loading a `reauth=1` URL asks the site to
         * log out and start over — so the app re-entered the auth flow (and its Cloudflare
         * challenge) on every launch instead of entering at the clean URL a probe used, where the
         * same challenge cleared in ~24 seconds.
         *
         * A persisted URL is a promise that reopening it is useful. A redirect dead end is not.
         */
        if (state.url !== '' && isRestorableUrl(state.url)) entry.url = state.url

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
          // The first send creates its conversation id; keep that task's injection.
          // A real conversation change starts with an unused prompt in every execution mode.
          if (!createdNewChat) entry.embed?.resetTaskPrompt()
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
      onReady: () => {
        /*
         * Same rule as the state push above: only the visible view decides that startup
         * is over. A background platform finishing its load says nothing about the page
         * the user is looking at.
         */
        if (isActive()) this.options.onEmbedReady?.()
      },
      onConversation: (conversation) => {
        this.options.store.upsert(conversation, this.currentConversationProject())
        this.flushDeferredCommands(conversation.id)
        this.flushPendingGoal(conversation.id)
        this.flushPendingConversationMessages(platform.id, conversation.id)
        this.broadcastConversations()
      },
      onSynced: (scraped) => {
        this.options.store.upsertMany(scraped)
        this.broadcastConversations()
      },
      onUserMessage: (text, attachments) => {
        this.captureConversationMessage(platform.id, 'user', text, null, attachments)
      },
      onAssistantMessage: (messageId, text) => {
        this.captureConversationMessage(platform.id, 'assistant', text, messageId)
      },
      onAssistantHistoryMarkdown: (messageId, text) => {
        const conversationId = record().conversationId
        if (conversationId) this.options.store.refreshAssistantMessageMarkdown(conversationId, messageId, text)
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
       * Not an optimisation â€” two live views with automation on would mean two sources of
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
         * from a background view is dropped here â€” deliberately, and until now invisibly. That is
         * the combination that makes "the model answered with JSON and nothing ran" impossible to
         * diagnose from a log, which is exactly how this was found.
         */
        if (!isActive()) {
          console.warn(
            `[session] command DROPPED, this session is not the visible one ${JSON.stringify({
              messageId: command.messageId,
              command: 'command' in command ? command.command : command.files.map((file) => file.path)
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
   * attach, switch) and a second call must never create a second page for one platform â€” that
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
    entry.embed.setPromptInjectionEnabled(this.promptInjectionEnabled)
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
     * ACTIVE view (`this.embed.setPromptParts(...)`). A view created later therefore keeps the
     * generic fallback â€” which does not describe this machine â€” and switching to it would
     * inject the wrong prompt, or (when the fallback is identical to what the page already has)
     * look like nothing was injected at all.
     */
    entry.embed.setPromptParts(buildTerminalPromptParts(this.environment, toolPromptForPlatform(entry.platform.id)))
    /*
     * Same reasoning as the prompt above, one line down: the theme lives per VIEW, so a view
     * created after the last theme change would otherwise come up wearing the old one — and
     * the only way to notice would be to switch platform and look.
     */
    entry.embed.setTheme(this.options.settings().theme)
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
     * switched loads exactly one site â€” attaching every platform here would put both sites on
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
   * Push an app-theme change into every view of this session.
   *
   * Every view, not just the visible one: the hidden platform's page is still rendered, and a
   * view whose theme was never updated is a page that comes up in the wrong colours the next
   * time it is switched to. Views that do not exist yet are covered by `ensureEmbed`, which
   * reads the theme from settings.
   */
  setTheme(theme: AppTheme): void {
    for (const entry of this.embeds.values()) entry.embed?.setTheme(theme)
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
    this.runner.setSendDelay(platformId === DEEPSEEK_PLATFORM.id ? 4 : this.preferredSendDelaySeconds)
    // Created here on first switch, and kept alive after that so its conversation survives.
    const created = this.ensureEmbed(platformId)
    const embed = created.embed as ChatGptEmbed
    /*
     * Re-pushed on every switch, not just at creation: this view may have been created before
     * the last environment probe or SSH handover, in which case its copy of the prompt is stale
     * and the page would inject a description of the wrong machine.
     */
    const prompts = buildTerminalPromptParts(this.environment, toolPromptForPlatform(entry.platform.id))
    embed.setPromptParts(prompts)
    this.applyVisibility()
    void embed.armCommandBaseline()
    /*
     * One line naming the platform, the prompt length, and whether the environment behind it is
     * the real probe result or the generic fallback.
     *
     * The prompt is stored per view, so "this view has the wrong prompt" has no symptom other
     * than messages going out un-prefixed â€” which looks exactly like terminal mode being off.
     * `detected` is what separates a probed machine from `FALLBACK_ENVIRONMENT`; the length
     * alone does not, because the two can coincide.
     */
    const prefix = prompts.prefix
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
    promptInjectionEnabled: boolean
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
       * stores one location, so restoring must reopen the view the user last had in front â€”
       * storing the starting platform instead would reopen ChatGPT every time even if the
       * user had switched to DeepSeek and left it there.
       */
      url: active.url,
      conversationId: active.conversationId,
      platformId: active.platform.id,
      paused: automation.paused,
      promptInjectionEnabled: this.promptInjectionEnabled,
      localCwd: terminal.cwd,
      sshHostId: sshState.hostId,
      sshAttached: sshState.attached,
      sshReconnect: sshState.attached && sshState.status !== 'disconnected',
      sshCwd: this.sshCwd,
      sendDelaySeconds: this.preferredSendDelaySeconds,
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
     * time it is shown â€” so a stale rectangle cannot be applied to a view that is not there.
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

  private handleDetectedCommand(command: ParsedAction): void {
    if (this.runner.handleDetected(command)) return

    // New chats navigate from '/' to /c/<id> asynchronously. A fast assistant
    // reply can therefore be detected before getState() exposes its conversation
    // id. Keep the command by message id and associate it when onConversation has
    // persisted the new chat, rather than losing it permanently.
    this.deferredCommands.set(command.messageId, command)
    /*
     * A deferred command is in limbo, and until now it was in limbo silently â€” if the
     * conversation id never arrives, it is simply never heard from again.
     */
    console.info(
      `[session] command DEFERRED until a conversation id exists ` +
        `${JSON.stringify({ messageId: command.messageId, waiting: this.deferredCommands.size })}`
    )
  }

  private fileReadContext(): FileReadContext {
    if (!fileReadingPlatform(this.activePlatform.id)) throw new Error('当前平台尚未适配 read_files。')
    const ssh = this.ssh.getState()
    if (ssh.attached) {
      return { scope: 'ssh', hostId: ssh.hostId ?? '', cwd: this.remoteShell?.cwd || this.sshCwd }
    }
    return { scope: 'local', hostId: '', cwd: this.runner.getTerminalState().cwd || homedir() }
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

  private captureConversationMessage(
    platformId: string,
    role: 'user' | 'assistant',
    text: string,
    sourceMessageId: string | null,
    attachments: ConversationImageAttachmentInput[] = []
  ): void {
    if (text.trim() === '' && attachments.length === 0) return
    const conversationId = this.embeds.get(platformId)?.conversationId ?? null
    if (conversationId) {
      this.options.store.appendConversationMessage(
        conversationId,
        role,
        text,
        sourceMessageId,
        Date.now(),
        attachments
      )
      return
    }
    const pending = this.pendingConversationMessages.get(platformId) ?? []
    pending.push({ role, text, sourceMessageId, attachments })
    this.pendingConversationMessages.set(platformId, pending)
  }

  private flushPendingConversationMessages(platformId: string, conversationId: string): void {
    const pending = this.pendingConversationMessages.get(platformId)
    if (!pending || pending.length === 0) return
    for (const message of pending) {
      this.options.store.appendConversationMessage(
        conversationId,
        message.role,
        message.text,
        message.sourceMessageId,
        Date.now(),
        message.attachments
      )
    }
    this.pendingConversationMessages.delete(platformId)
  }
  /**
   * Remember what the user asked for.
   *
   * Called on EVERY interceptor push, because that is the only place the page reports
   * the user's own words â€” the main process never sees the composer. The comparison
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

  /** Apply to this session's current/cached platforms, and persist with its row. */
  setPromptInjectionEnabled(enabled: boolean): InterceptorStatus {
    this.promptInjectionEnabled = enabled
    for (const entry of this.embeds.values()) entry.embed?.setPromptInjectionEnabled(enabled)
    this.options.onSummaryChanged()
    return this.embed.getInterceptorStatus()
  }

  async setTerminalCwd(path: string): Promise<TerminalState> {
    const target = path.trim()
    const remote = this.remoteShell
    const previousRemoteCwd = remote?.cwd ?? ''
    const state = await this.runner.setTerminalCwd(path)

    // SSH has separate model-exec and interactive PTY channels. Mirror the cwd only
    // when the model-side cd actually changed directory, or selected the current one.
    if (remote !== null && remote === this.remoteShell && remote.alive) {
      const nextRemoteCwd = remote.cwd
      if (nextRemoteCwd !== '' && (nextRemoteCwd !== previousRemoteCwd || target === nextRemoteCwd)) {
        await this.ssh.setPtyCwd(nextRemoteCwd)
      }
    }

    await this.probeEnvironment()
    return state
  }

  /** Pace the loop without touching any stored state or the environment probe. */
  setTerminalSendDelay(seconds: number): TerminalState {
    const value = Number.isFinite(seconds) ? Math.min(Math.max(Math.floor(seconds), 0), 600) : 0
    this.preferredSendDelaySeconds = value
    const state = this.runner.setSendDelay(this.activePlatformId === DEEPSEEK_PLATFORM.id ? 4 : value)
    this.options.onSummaryChanged()
    return state
  }

  /** The live command shell determines the owner, rather than a stale environment probe. */
  private notesTarget(): Omit<TerminalNotes, 'text' | 'legacyText'> {
    const ssh = this.ssh?.getState()
    if (ssh?.attached) {
      const directory = this.remoteShell?.alive ? this.remoteShell.cwd || ssh.modelCwd : ''
      return {
        scope: 'ssh', hostId: ssh.hostId ?? '', label: ssh.name || ssh.target || '远端主机',
        directory, directoryKey: normalizeTerminalNotesDirectory('ssh', directory)
      }
    }
    const directory = this.runner?.getTerminalState().cwd ?? this.lastPersistedLocalCwd
    return {
      scope: 'local', hostId: this.options.localMachineId, label: '本机',
      directory, directoryKey: normalizeTerminalNotesDirectory('local', directory)
    }
  }

  currentNotes(): TerminalNotes {
    const target = this.notesTarget()
    const saved = this.options.store.getDirectoryNote(target.scope, target.hostId, target.directoryKey)
    const legacyText = saved === null
      ? target.scope === 'ssh' ? this.options.store.getSshNote(target.hostId) : this.options.store.getSetting(SETTING_LOCAL_NOTES) ?? ''
      : ''
    return { ...target, text: saved ?? '', legacyText }
  }

  /** Called after cwd changes and after another session saves this same directory. */
  private refreshDirectoryNotes(force = false): void {
    if (this.disposed) return
    const notes = this.currentNotes()
    const previous = this.lastDirectoryNotes
    if (!force && previous && terminalNotesOwnerKey(previous) === terminalNotesOwnerKey(notes)
      && previous.text === notes.text && previous.legacyText === notes.legacyText
      && previous.directory === notes.directory && previous.label === notes.label) return
    this.lastDirectoryNotes = notes
    this.environment = { ...this.environment, workingDirectory: notes.directory, extraNotes: notes.text }
    for (const entry of this.embeds.values()) {
      entry.embed?.setPromptParts(buildTerminalPromptParts(this.environment, toolPromptForPlatform(entry.platform.id)))
    }
    this.send(IpcChannels.terminalNotesChanged, notes)
    this.send(IpcChannels.environmentChanged, { ...this.environment })
  }

  refreshTerminalNotesForOwner(owner: TerminalNotesOwner): void {
    if (!this.disposed && terminalNotesOwnerKey(this.notesTarget()) === terminalNotesOwnerKey(owner)) this.refreshDirectoryNotes()
  }

  applyTerminalNotes(raw: string, expectedOwner: TerminalNotesOwner): TerminalNotes {
    const target = this.notesTarget()
    if (!target.directoryKey || !target.hostId) throw new Error('当前机器或工作目录尚未确定，无法保存说明。')
    if (!expectedOwner || terminalNotesOwnerKey(expectedOwner) !== terminalNotesOwnerKey(target)) {
      throw new Error('工作目录已变化，请确认当前目录后重新保存说明。')
    }
    const text = raw.trim() === '' ? '' : raw
    this.options.store.setDirectoryNote(target.scope, target.hostId, target.directoryKey, text)
    this.refreshDirectoryNotes()
    this.options.onTerminalNotesSaved(target)
    return this.currentNotes()
  }

  /**
   * Every saved MySQL connection for whichever machine the terminal is driving.
   *
   * Connections describe ONE database on ONE machine, and a machine keeps a list of
   * them. The passwords are decrypted here so the dialog can show them back; they
   * never leave this process except on their way into that dialog.
   */
  listMysqlConnections(): MysqlConnectionsState {
    return this.readMysqlConnectionsState()
  }

  /**
   * Persist one connection for the machine in charge.
   *
   * A draft with no id is a new connection and gets one here, before the write — the id
   * is generated rather than read back, so the caller can open a tab on it without a
   * second round trip. An empty password keeps the stored secret.
   */
  saveMysqlConnection(draft: MysqlConnectionDraft): MysqlSaveResult {
    const machineKey = this.environmentScope.scope === 'local' ? this.options.localMachineId : this.environmentScope.hostId
    const id = typeof draft?.id === 'string' && draft.id.trim() !== '' ? draft.id.trim() : randomUUID()
    const typed = String(draft?.password ?? '')
    this.options.store.upsertMysqlConnection({
      id,
      scope: this.environmentScope.scope,
      hostId: machineKey,
      name: String(draft?.name ?? '').trim(),
      host: String(draft?.host ?? '').trim(),
      port: Number.isFinite(Number(draft?.port)) ? Math.max(1, Math.min(65535, Math.trunc(Number(draft.port)))) : 3306,
      username: String(draft?.username ?? '').trim(),
      secret: typed === '' ? '' : encryptSecret(typed),
      database: String(draft?.database ?? '').trim()
    })
    const state = this.readMysqlConnectionsState()
    this.send(IpcChannels.mysqlConnChanged, state)
    return { ...state, id }
  }

  removeMysqlConnection(id: string): MysqlConnectionsState {
    this.options.store.removeMysqlConnection(String(id ?? ''))
    const state = this.readMysqlConnectionsState()
    this.send(IpcChannels.mysqlConnChanged, state)
    return state
  }

  /** Read every stored connection for the machine in charge and decrypt its password. */
  /**
   * Ask one connection which databases it can see.
   *
   * This is the first thing in the app that actually talks to MySQL. It opens a
   * short-lived connection, runs SHOW DATABASES, and closes it — nothing is cached and
   * nothing is written, so a failure here cannot leave the stored connection changed.
   *
   * An empty password means "use the stored one" for an existing row, the same rule the
   * save path uses, so the dropdown works on a connection that was opened without
   * retyping its password.
   */
  async listMysqlDatabases(draft: MysqlConnectionDraft): Promise<MysqlDatabaseList> {
    const machineKey = this.environmentScope.scope === 'local' ? this.options.localMachineId : this.environmentScope.hostId
    const host = String(draft?.host ?? '').trim()
    if (host === '') return { ok: false, databases: [], message: '请先填写主机地址。' }

    const typed = String(draft?.password ?? '')
    let password = typed
    if (password === '' && typeof draft?.id === 'string' && draft.id.trim() !== '') {
      const stored = this.options.store
        .listMysqlConnections(this.environmentScope.scope, machineKey)
        .find((row) => row.id === draft.id.trim())
      password = stored && stored.secret !== '' ? decryptSecret(stored.secret) : ''
    }

    const rawPort = Number(draft?.port)
    const port = Number.isFinite(rawPort) && rawPort > 0 ? Math.trunc(rawPort) : 3306
    let connection: Connection | null = null
    try {
      connection = await createConnection({
        host,
        port,
        user: String(draft?.username ?? '').trim(),
        password,
        // No database: the point is to list them, and naming one that does not exist
        // would fail the connection outright.
        connectTimeout: 8000
      })
      const [rows] = await connection.query('SHOW DATABASES')
      const databases = (Array.isArray(rows) ? rows : [])
        .map((row) => {
          const record = row as Record<string, unknown>
          const value = record.Database ?? Object.values(record)[0]
          return typeof value === 'string' ? value : ''
        })
        .filter((name) => name !== '')
        .sort((left, right) => left.localeCompare(right))
      return { ok: true, databases, message: '' }
    } catch (error) {
      return { ok: false, databases: [], message: mysqlErrorMessage(error) }
    } finally {
      if (connection) await connection.end().catch(() => undefined)
    }
  }
  /**
   * Resolve the password to use for one connection draft.
   *
   * An empty password on a SAVED row means "use the stored one", the same rule the save
   * path uses. Shared by every query below so the three of them cannot drift apart.
   */
  private mysqlPasswordFor(draft: MysqlConnectionDraft): string {
    const typed = String(draft?.password ?? '')
    if (typed !== '') return typed
    const id = typeof draft?.id === 'string' ? draft.id.trim() : ''
    if (id === '') return ''
    const machineKey = this.environmentScope.scope === 'local' ? this.options.localMachineId : this.environmentScope.hostId
    const stored = this.options.store
      .listMysqlConnections(this.environmentScope.scope, machineKey)
      .find((row) => row.id === id)
    return stored && stored.secret !== '' ? decryptSecret(stored.secret) : ''
  }

  /**
   * List the tables and views inside one database.
   *
   * INFORMATION_SCHEMA rather than SHOW TABLES, because the type and the comment are
   * part of what the list has to show and SHOW TABLES returns neither. The database name
   * is bound as a parameter, not interpolated, so it cannot break the query.
   */
  async listMysqlTables(draft: MysqlConnectionDraft, database: string): Promise<MysqlTableList> {
    const host = String(draft?.host ?? '').trim()
    const db = String(database ?? '').trim()
    if (host === '') return { ok: false, tables: [], message: '请先填写主机地址。' }
    if (db === '') return { ok: false, tables: [], message: '请先选择默认数据库。' }
    const rawPort = Number(draft?.port)
    const port = Number.isFinite(rawPort) && rawPort > 0 ? Math.trunc(rawPort) : 3306
    let connection: Connection | null = null
    try {
      connection = await createConnection({
        host,
        port,
        user: String(draft?.username ?? '').trim(),
        password: this.mysqlPasswordFor(draft),
        database: db,
        connectTimeout: 8000
      })
      const [rows] = await connection.query(
        'SELECT TABLE_NAME, TABLE_TYPE, TABLE_COMMENT FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
        [db]
      )
      const tables = (Array.isArray(rows) ? rows : []).map((row) => {
        const record = row as Record<string, unknown>
        return {
          name: String(record.TABLE_NAME ?? ''),
          type: String(record.TABLE_TYPE ?? ''),
          comment: String(record.TABLE_COMMENT ?? '')
        }
      })
      return { ok: true, tables: tables.filter((table) => table.name !== ''), message: '' }
    } catch (error) {
      return { ok: false, tables: [], message: mysqlErrorMessage(error) }
    } finally {
      if (connection) await connection.end().catch(() => undefined)
    }
  }

  /**
   * Read a page of rows from one table.
   *
   * Capped deliberately. A viewer that pulled an entire table would hang the renderer on
   * the first large one, and the row count is not known before the query runs. Identifiers
   * are quoted with backticks and any backtick inside them is doubled, which is the escape
   * MySQL defines; a value cannot be bound in place of a table name.
   */
  async queryMysqlTable(draft: MysqlConnectionDraft, database: string, table: string): Promise<MysqlTableData> {
    const host = String(draft?.host ?? '').trim()
    const db = String(database ?? '').trim()
    const target = String(table ?? '')
    const empty = { sql: '', columns: [], columnComments: [], columnCommentsMessage: '', rows: [], truncated: false }
    if (host === '') return { ...empty, ok: false, message: '请先填写主机地址。' }
    if (db === '') return { ...empty, ok: false, message: '请先选择默认数据库。' }
    if (target.trim() === '') return { ...empty, ok: false, message: '请先选择要查看的表。' }
    const limit = 200
    const quote = (name: string): string => '`' + name.replace(/`/g, '``') + '`'
    const rawPort = Number(draft?.port)
    const port = Number.isFinite(rawPort) && rawPort > 0 ? Math.trunc(rawPort) : 3306
    let connection: Connection | null = null
    let executedSql = ''
    try {
      connection = await createConnection({
        host,
        port,
        user: String(draft?.username ?? '').trim(),
        password: this.mysqlPasswordFor(draft),
        database: db,
        connectTimeout: 8000
      })
      executedSql = `SELECT * FROM ${quote(db)}.${quote(target)} LIMIT ${limit + 1}`
      const [rows, fields] = await connection.query({ sql: executedSql, timeout: 8000 })
      const raw = Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : []
      const truncated = raw.length > limit
      const page = truncated ? raw.slice(0, limit) : raw
      const columns = (fields ?? []).map((field) => field.name)
      const comments = new Map<string, string>()
      let columnCommentsMessage = ''
      try {
        const [metadata] = await connection.query({
          sql: 'SELECT COLUMN_NAME AS name, COLUMN_COMMENT AS comment FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
          values: [db, target],
          timeout: 8000
        })
        for (const record of Array.isArray(metadata) ? metadata as Array<Record<string, unknown>> : []) {
          comments.set(String(record.name ?? ''), String(record.comment ?? ''))
        }
      } catch (error) {
        columnCommentsMessage = `字段注释读取失败：${mysqlErrorMessage(error)}`
      }
      const columnComments = columns.map((column) => comments.get(column) ?? '')
      const cells = page.map((row) =>
        columns.map((column) => {
          const value = row[column]
          if (value === null || value === undefined) return null
          if (value instanceof Date) return value.toISOString()
          if (Buffer.isBuffer(value)) return '<' + value.length + ' bytes>'
          if (typeof value === 'object') return JSON.stringify(value)
          return String(value)
        })
      )
      return { ok: true, sql: executedSql, columns, columnComments, columnCommentsMessage, rows: cells, truncated, message: '' }
    } catch (error) {
      return { ...empty, ok: false, sql: executedSql, message: mysqlErrorMessage(error) }
    } finally {
      if (connection) await connection.end().catch(() => undefined)
    }
  }

  /** Read the CREATE statement returned by MySQL, including view definitions. */
  async getMysqlTableDdl(draft: MysqlConnectionDraft, database: string, table: string): Promise<MysqlTableDdl> {
    const host = String(draft?.host ?? '').trim()
    const db = String(database ?? '').trim()
    const target = String(table ?? '')
    if (host === '') return { ok: false, ddl: '', message: '请先填写主机地址。' }
    if (db === '') return { ok: false, ddl: '', message: '请先选择默认数据库。' }
    if (target.trim() === '') return { ok: false, ddl: '', message: '请先选择要查看的表。' }
    const quote = (name: string): string => '`' + name.replace(/`/g, '``') + '`'
    const rawPort = Number(draft?.port)
    const port = Number.isFinite(rawPort) && rawPort > 0 ? Math.trunc(rawPort) : 3306
    let connection: Connection | null = null
    try {
      connection = await createConnection({
        host,
        port,
        user: String(draft?.username ?? '').trim(),
        password: this.mysqlPasswordFor(draft),
        database: db,
        connectTimeout: 8000
      })
      const [rows] = await connection.query({
        sql: `SHOW CREATE TABLE ${quote(db)}.${quote(target)}`,
        timeout: 8000
      })
      const record = Array.isArray(rows) ? rows[0] as Record<string, unknown> | undefined : undefined
      const ddl = record?.['Create Table'] ?? record?.['Create View']
      if (typeof ddl !== 'string' || ddl.trim() === '') {
        return { ok: false, ddl: '', message: '服务器未返回该表的 DDL。' }
      }
      return { ok: true, ddl, message: '' }
    } catch (error) {
      return { ok: false, ddl: '', message: mysqlErrorMessage(error) }
    } finally {
      if (connection) await connection.end().catch(() => undefined)
    }
  }

  /* ---------------- nacos connections ---------------- */

  /** Every saved Nacos console for whichever machine the terminal is driving. */
  listNacosConnections(): NacosConnectionsState {
    return this.readNacosConnectionsState()
  }

  /**
   * Persist one console for the machine in charge.
   *
   * Same id rule as MySQL: a draft with no id is new and gets one here, so the caller can
   * open its tab without a second round trip. The address is normalized before it is
   * stored, so a saved row is always a URL the view can actually load.
   */
  saveNacosConnection(draft: NacosConnectionDraft): NacosSaveResult {
    const machineKey = this.environmentScope.scope === 'local' ? this.options.localMachineId : this.environmentScope.hostId
    const id = typeof draft?.id === 'string' && draft.id.trim() !== '' ? draft.id.trim() : randomUUID()
    const url = normalizeNacosUrl(String(draft?.url ?? '')) ?? ''
    this.options.store.upsertNacosConnection({
      id,
      scope: this.environmentScope.scope,
      hostId: machineKey,
      name: String(draft?.name ?? '').trim(),
      url,
      namespace: String(draft?.namespace ?? '').trim()
    })
    const state = this.readNacosConnectionsState()
    this.send(IpcChannels.nacosConnChanged, state)
    return { ...state, id }
  }

  removeNacosConnection(id: string): NacosConnectionsState {
    this.options.store.removeNacosConnection(String(id ?? ''))
    const state = this.readNacosConnectionsState()
    this.send(IpcChannels.nacosConnChanged, state)
    return state
  }

  private readNacosConnectionsState(): NacosConnectionsState {
    const machineKey = this.environmentScope.scope === 'local' ? this.options.localMachineId : this.environmentScope.hostId
    const connections = this.options.store.listNacosConnections(this.environmentScope.scope, machineKey).map((row) => ({
      id: row.id,
      scope: this.environmentScope.scope,
      hostId: machineKey,
      name: row.name,
      url: row.url,
      namespace: row.namespace,
      updatedAt: row.updatedAt
    }))
    return { machineLabel: this.environmentScope.label, connections }
  }

  private readMysqlConnectionsState(): MysqlConnectionsState {
    const machineKey = this.environmentScope.scope === 'local' ? this.options.localMachineId : this.environmentScope.hostId
    const connections = this.options.store.listMysqlConnections(this.environmentScope.scope, machineKey).map((row) => ({
      id: row.id,
      scope: this.environmentScope.scope,
      hostId: machineKey,
      name: row.name,
      host: row.host,
      port: row.port,
      username: row.username,
      password: row.secret === '' ? '' : decryptSecret(row.secret),
      database: row.database,
      updatedAt: row.updatedAt
    }))
    return { machineLabel: this.environmentScope.label, connections }
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
    const backend = this.remoteShell
    try {
      const { kind, result } = await this.runner.runEnvironmentProbe()
      if (this.disposed || backend !== this.remoteShell || result.rejected || result.interrupted || result.timedOut || result.sessionLost) {
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

      this.environment = info
      this.refreshDirectoryNotes(true)
      this.broadcastConversations()
      this.options.onSummaryChanged()
      return { ...this.environment }
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
