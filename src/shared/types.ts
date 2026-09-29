/**
 * Types shared between the Electron main process, the preload bridge and the
 * React renderer. Keep this module free of runtime dependencies on `electron`
 * so it can be imported from every process.
 */

export const IpcChannels = {
  getAppInfo: 'app:get-info',
  embedSetBounds: 'embed:set-bounds',
  embedSetVisible: 'embed:set-visible',
  embedCommand: 'embed:command',
  embedNavigate: 'embed:navigate',
  embedGetState: 'embed:get-state',
  embedState: 'embed:state',
  embedLoginWithEmail: 'embed:login-with-email',
  embedImportSession: 'embed:import-session',
  /**
   * Import a whole browser cookie SET rather than one token — the Google/Gemini route.
   *
   * A separate channel because the input is a different SHAPE, not a different value: the token
   * route takes one cookie, reassembled from NextAuth chunks, while a Google session is a set of
   * cookies with no chunking and no single name that decides anything.
   */
  embedImportCookieSet: 'embed:import-cookie-set',
  embedPreviewSession: 'embed:preview-session',
  embedGetAuthState: 'embed:get-auth-state',
  openChatgptExternal: 'app:open-chatgpt-external',
  conversationsList: 'conversations:list',
  conversationMessagesList: 'conversation-messages:list',
  conversationAttachmentRead: 'conversation-attachment:read',
  conversationsSync: 'conversations:sync',
  conversationsRemove: 'conversations:remove',
  conversationsMove: 'conversations:move',
  conversationsChanged: 'conversations:changed',
  interceptorGetState: 'interceptor:get-state',
  interceptorSetEnabled: 'interceptor:set-enabled',
  interceptorEndTask: 'interceptor:end-task',
  interceptorEvent: 'interceptor:event',
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  environmentGet: 'environment:get',
  environmentChanged: 'environment:changed',
  automationGetState: 'automation:get-state',
  automationSetMode: 'automation:set-mode',
  automationSetPaused: 'automation:set-paused',
  automationCheckNow: 'automation:check-now',
  automationChanged: 'automation:changed',
  executionList: 'execution:list',
  executionRun: 'execution:run',
  executionSkip: 'execution:skip',
  executionChanged: 'execution:changed',
  terminalGetState: 'terminal:get-state',
  terminalInput: 'terminal:input',
  terminalInterrupt: 'terminal:interrupt',
  terminalReset: 'terminal:reset',
  terminalSetCwd: 'terminal:set-cwd',
  terminalSetSendDelay: 'terminal:set-send-delay',
  terminalChanged: 'terminal:changed',
  terminalNotesGet: 'terminal-notes:get',
  terminalNotesSet: 'terminal-notes:set',
  terminalNotesChanged: 'terminal-notes:changed',
  sshGetState: 'ssh:get-state',
  sshListHosts: 'ssh:list-hosts',
  sshConnect: 'ssh:connect',
  sshDisconnect: 'ssh:disconnect',
  sshDismiss: 'ssh:dismiss',
  sshRemoveHost: 'ssh:remove-host',
  sshInput: 'ssh:input',
  sshUploadFiles: 'ssh:upload-files',
  sshUploadsGet: 'ssh:uploads-get',
  sshUploadCancel: 'ssh:upload-cancel',
  sshUploadsChanged: 'ssh:uploads-changed',
  sshListFiles: 'ssh:list-files',
  sshDownloadFile: 'ssh:download-file',
  sshDownloadsGet: 'ssh:downloads-get',
  sshDownloadCancel: 'ssh:download-cancel',
  sshDownloadsChanged: 'ssh:downloads-changed',
  sshTransfersGet: 'ssh:transfers-get',
  sshTransferCancel: 'ssh:transfer-cancel',
  sshTransfersChanged: 'ssh:transfers-changed',
  sshChanged: 'ssh:changed',
  managerSessionsList: 'manager:sessions-list',
  managerSessionCreate: 'manager:session-create',
  managerSessionOpen: 'manager:session-open',
  managerSessionRename: 'manager:session-rename',
  managerSessionDestroy: 'manager:session-destroy',
  managerSessionsChanged: 'manager:sessions-changed',
  sessionSwitchPlatform: 'session:switch-platform',
  sessionShowModelMenu: 'session:show-model-menu',
  workspaceGetState: 'workspace:get-state',
  workspaceShowManager: 'workspace:show-manager',
  workspaceSetOpenSshDialog: 'workspace:set-open-ssh-dialog',
  workspaceChanged: 'workspace:changed',
  updateGetState: 'update:get-state',
  updateCheck: 'update:check',
  updateDownload: 'update:download',
  updateInstall: 'update:install',
  updateChanged: 'update:changed',
  gitLog: 'git:log',
  gitDiff: 'git:diff'
} as const

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels]

/**
 * Live state of the application updater.
 *
 * `phase` drives the settings UI:
 *   idle      — nothing checked yet, or the check is done and we are current
 *   checking  — asking GitHub for the latest release
 *   available — a newer version exists and can be downloaded
 *   downloading — download in progress (`percent` is 0..100)
 *   downloaded — ready to install; `install()` restarts into it
 *   error     — see `message`
 */
export interface UpdateStatus {
  phase: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error'
  /** Version offered by the server, when known. */
  version: string
  /** Download progress, 0..100. Only meaningful while downloading. */
  percent: number
  /** Human-readable detail for the error phase. */
  message: string
}

/** State of the single-window workspace shell. */
export interface WorkspaceState {
  view: 'manager' | 'session'
  sessionId: string | null
  openSshDialog: boolean
}

export interface ManagedSessionSummary {
  id: string
  title: string
  kind: 'local' | 'ssh'
  target: string
  conversationId: string | null
  /**
   * Which chat site this session drives (`'chatgpt'` / `'deepseek'` / `'claude'`).
   *
   * Persisted, not inferred: a session restored after a restart must reopen the site its
   * conversation actually lives on, and the id is also what the manager UI labels the
   * card with. Unknown ids resolve to the default platform rather than failing, so a row
   * written by a future version cannot make the app unopenable.
   */
  platformId: string
  /** True while this session has an unfinished model task. */
  taskRunning: boolean
  createdAt: number
}


/** Page the embedded view opens on. */
export const EMBED_HOME_URL = 'https://chatgpt.com/'

/**
 * Where "改用邮箱登录" sends the embedded view.
 *
 * `auth.openai.com` is inside the embed's allowlist, so this hop stays in the
 * embedded session — which is the point. Email/OTP is the ONE sign-in route that
 * can complete inside an embedded user-agent: Google and Apple both refuse it
 * outright (verified: accounts.google.com answers `/v3/signin/rejected` even with a
 * patched UA and a corrected Sec-CH-UA brand list), so a provider login can never
 * establish the session the embedded view needs.
 */
export const EMBED_LOGIN_URL = 'https://auth.openai.com/log-in'

/**
 * The session cookie an imported login is written as.
 *
 * ChatGPT runs NextAuth, and the session token is the same bearer credential the
 * browser sends — it is not bound to Chrome, so a copy of it works from anywhere
 * that presents it over HTTPS on the right domain.
 *
 * `__Secure-` is part of the NAME, not a flag: a cookie by this name is only
 * accepted when it is also set `Secure`, which is why the import path always sets
 * `secure: true` and can only ever write over https.
 */
export const SESSION_COOKIE_NAME = '__Secure-next-auth.session-token'

/** What the user pastes out of their browser's DevTools. */
export interface SessionImportDraft {
  /** Cookie name. Defaults to SESSION_COOKIE_NAME in the UI. */
  name: string
  /** Cookie value, verbatim. Held in memory for the length of one call only. */
  value: string
}

/** Result of importing a browser session into the embedded partition. */
export interface SessionImportResult {
  ok: boolean
  /** Human-readable outcome, shown in the settings dialog. */
  message: string
  /**
   * Whether the embedded page looks signed in after reloading.
   *
   * A cookie can be accepted by the partition and still be expired or revoked
   * server-side, so this is the only signal that actually means "you are in".
   */
  signedIn: boolean
}

/** Whether the embedded page is currently signed in, as far as the UI can tell. */
export interface EmbedAuthState {
  signedIn: boolean
  /** Cookie names present for chatgpt.com/openai.com — never their values. */
  cookieNames: string[]
}

/** Origin used to turn the sidebar's relative `href` values into absolute URLs. */
export const CHATGPT_ORIGIN = 'https://chatgpt.com'

/**
 * Session partition for the embedded page.
 *
 * Single source of truth: the view is created with it and the proxy is applied to
 * it. Those are two different files, and a typo in either would silently give the
 * embed its own default session — no proxy, no shared cookies — with nothing
 * failing loudly. Keep it here.
 */
export const EMBED_PARTITION = 'persist:chatgpt'

/**
 * A real conversation id, by SHAPE — never "whatever slug is in the path".
 *
 * Two shapes, because two sites use them and BOTH are real:
 *
 *   UUID      `6ab156eb-1b00-83e8-b973-a6a59295a353`   ChatGPT `/c/<uuid>`, DeepSeek likewise
 *   16 hex    `d536e21cb916e6a8`                        Gemini `/app/<16 hex>`
 *
 * The Gemini shape was measured, not assumed: ten ids came back from one probe run — eight from
 * the sidebar, two from the address bar — and every one matched `^[0-9a-f]{16}$`
 * (tools/diag/gemini-dom-probe.js, 2026-09-29).
 *
 * WHY WIDENING THIS IS NOT COSMETIC. It is not only `conversationIdFromPath` that consults it:
 * `purgeInvalidIds(isConversationId)` runs at startup and DELETES rows that fail it, and the
 * sidebar scrape filters with it. A Gemini id rejected here would therefore have its stored
 * conversations removed on the next launch, and every scraped one silently dropped — which looks
 * like a broken sync rather than a validation rule.
 *
 * `google.com`-style routes also serve placeholders, so the check stays anchored and exact; the
 * path prefix in each platform's `conversationIdFromPath` is what keeps a bare 16-hex string
 * from matching somewhere it should not.
 */
const CONVERSATION_ID_RE =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16})$/i

/** True when `value` is a genuine conversation id (a UUID), not a placeholder. */
export function isConversationId(value: string): boolean {
  return CONVERSATION_ID_RE.test(value)
}

/** Extract the conversation id from an absolute URL, or null if it is not one. */
export function conversationIdFromUrl(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }

  const host = parsed.hostname.toLowerCase()
  if (host !== 'chatgpt.com' && !host.endsWith('.chatgpt.com')) return null

  const match = /^\/c\/([^/?#]+)/.exec(parsed.pathname)
  if (!match) return null

  const id = decodeURIComponent(match[1])
  return isConversationId(id) ? id : null
}

/** Payload returned by the `app:get-info` IPC handler. */
export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
  v8: string
  platform: string
  arch: string
  /** True when the app is running unpackaged (`app.isPackaged === false`). */
  isDev: boolean
  /** True only when the renderer was served by the Vite dev server (HMR active). */
  usingDevServer: boolean
  userDataPath: string
}

/** Persisted user settings, edited from the in-app settings dialog. */
export type AppTheme = 'light' | 'dark'

export interface AppSettings {
  /** Overall appearance of the application chrome. */
  theme: AppTheme
  /**
   * HTTP proxy for the EMBEDDED chat views, PER PLATFORM, keyed by `ChatPlatform['id']`.
   *
   * One value per site rather than one shared value. They are different destinations reached
   * through different routes — a proxy that gets to chatgpt.com is not automatically the right
   * way to reach claude.ai, and the single shared setting this replaces made that impossible to
   * express. A missing key means direct, which is also what the empty string means, so a
   * platform added later starts with no proxy rather than silently inheriting someone else's.
   *
   * Still scoped to the embed's sessions rather than the whole app: routing everything through
   * it would drag the app's own traffic along with it.
   */
  embedProxy: Record<string, string>
  /**
   * Default proxy for SSH connections.
   *
   * A separate setting from `embedProxy` on purpose — the two are unrelated
   * mechanisms (an Electron session proxy versus a socket this app dials itself),
   * and a proxy that reaches chatgpt.com is not automatically the right way to
   * reach a particular server. Individual hosts may override this.
   *
   * Empty string means direct.
   */
  sshProxy: string
  /**
   * Proxy used ONLY when downloading application updates.
   *
   * Separate from the two above because an update download hits github.com,
   * while the embed and SSH proxies point at entirely different destinations.
   * Empty string means direct.
   */
  updateProxy: string
  /** User-selected avatar stored as an image data URL. Empty string uses the default icon. */
  userAvatarDataUrl: string
  /** Original image used by the visual avatar crop editor. */
  userAvatarSourceDataUrl: string
  /** Avatar crop position inside the circular frame, as percentages. */
  userAvatarPositionX: number
  userAvatarPositionY: number
  /** Zoom level used by the visual avatar crop editor. */
  userAvatarScale: number
}

/** Everything the renderer may change; every field is optional. */
export type AppSettingsPatch = Partial<AppSettings>

/**
 * Where the embedded page should sit, in CSS pixels relative to the top-left of
 * the window's content area. The native view is NOT a DOM element, so React
 * measures a placeholder and reports its rectangle here.
 */
export interface EmbedBounds {
  x: number
  y: number
  width: number
  height: number
}

export type EmbedCommand = 'back' | 'forward' | 'reload' | 'stop' | 'home'

/** Snapshot of the embedded view, pushed from main to the renderer. */
export interface EmbedState {
  url: string
  title: string
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** Set when the current URL is a conversation (`/c/<id>`). */
  conversationId: string | null
  /**
   * Set while the view is parked on a bot-check interstitial rather than the site itself.
   *
   * WHY THE UI HAS TO KNOW. Such a page is a NORMAL first-visit state, not a failure: measured on
   * claude.ai from an empty partition, Cloudflare's challenge took ~24 seconds to clear on its
   * own and then navigated to the real page. But an interstitial looks exactly like the site
   * having failed to load — no content, no error — so without this the only honest reading a user
   * (or an agent reading the log) can reach is "it is broken". That misreading already cost
   * several rounds here.
   *
   * Epoch milliseconds when the check was first seen, or null when there is none.
   */
  botCheckSince: number | null
}

/** The machine + working-directory project a conversation belongs to. */
export interface ConversationProject {
  id: string
  machineScope: 'local' | 'ssh'
  hostId: string
  machineLabel: string
  name: string
  path: string
}

/** A conversation row persisted in SQLite. */
export interface Conversation {
  id: string
  url: string
  title: string
  project: ConversationProject | null
  /**
   * What the USER last asked for, verbatim.
   *
   * Deliberately not derivable from anything else: the per-command `description` is
   * the model's own one-liner about a single command, and the injected prompt text is
   * what the app wraps around the message. The user's own words exist only at the
   * moment the composer is submitted, so they are captured there and stored.
   */
  goal: string
  /** Epoch milliseconds. */
  updatedAt: number
}

/** Image bytes captured from the embedded chat page after a user send. */
export interface ConversationImageAttachmentInput {
  fileName: string
  mimeType: string
  dataBase64: string
  width: number | null
  height: number | null
  sizeBytes: number
}

/** Persisted metadata for one message attachment. The bytes stay on disk. */
export interface ConversationAttachment {
  id: string
  messageId: string
  kind: 'image'
  mimeType: string
  fileName: string
  sha256: string
  width: number | null
  height: number | null
  sizeBytes: number
  ordinal: number
}
/** One clean user/assistant turn persisted for the app-owned conversation view. */
export interface ConversationMessage {
  id: string
  conversationId: string
  role: 'user' | 'assistant'
  sourceMessageId: string | null
  content: string
  attachments: ConversationAttachment[]
  createdAt: number
}
/** One entry scraped out of the page's own sidebar markup. */
export interface ScrapedConversation {
  id: string
  url: string
  title: string
}

/* ------------------------------------------------------------------ *
 * Terminal mode: the injected system prompt
 * ------------------------------------------------------------------ */

/**
 * Which dialect the machine in charge speaks — and therefore which prompt is
 * built for it.
 *
 * This is NOT the local platform: once an SSH session is attached, the machine
 * the model is driving is the remote one, and the prompt has to describe that
 * machine instead. Getting this wrong is worse than saying nothing, because the
 * model writes commands in whatever dialect the prompt claims.
 */
export type EnvironmentKind = 'windows' | 'posix'

/**
 * What the app learned about the machine the terminal is currently driving — by
 * actually asking it, rather than assuming.
 *
 * The prompt used to hard-code "Windows 11 + Windows PowerShell". That is a guess
 * about the machine, and a wrong one on Windows 10, on a Server SKU, on ARM64,
 * wherever PowerShell 7 is installed, and on every remote host reached over SSH —
 * and the model acts on it, reaching for `&&` that 5.1 rejects or for `Get-ChildItem`
 * on a Linux box.
 */
export interface EnvironmentInfo {
  /** Which prompt variant describes this machine. */
  kind: EnvironmentKind
  /** Windows: "Microsoft Windows 11 家庭中文版". POSIX: "Ubuntu 22.04.5 LTS". */
  osCaption: string
  /** Windows: "10.0.22631". POSIX: the kernel release. */
  osVersion: string
  /** Windows build number; empty on POSIX. */
  buildNumber: string
  /** e.g. "64-bit" / "x86_64". */
  architecture: string
  /** e.g. "5.1.22621.6133"; empty on POSIX. */
  powerShellVersion: string
  /** "Desktop" for 5.1, "Core" for 7+; empty on POSIX. */
  powerShellEdition: string
  /** The executable the LOCAL shell runs, e.g. "powershell.exe". */
  powerShellExe: string
  /** POSIX shell path, e.g. "/bin/bash"; empty on Windows. */
  shellPath: string
  /** POSIX shell version banner, e.g. "GNU bash, version 5.1.16(1)-release". */
  shellVersion: string
  /**
   * Where the terminal was standing when it was probed.
   *
   * Part of the environment on purpose: the user can retarget the terminal, and
   * the prompt has to describe where it now is.
   */
  workingDirectory: string
  /**
   * Display name of the SSH host, when this describes a remote machine.
   *
   * For the UI ONLY — `describeTarget()` in the settings dialog. **Never
   * interpolate this into the prompt**: it is whatever the user called the
   * machine, and that label is frequently more revealing than the address.
   */
  remoteName: string
  /**
   * "user@host:port" of the SSH host, when this describes a remote machine.
   *
   * For the UI only, for the same reason as `remoteName`. The model gains nothing
   * from knowing the address, and it would be handed to a third-party chat.
   */
  remoteTarget: string
  /** False when detection failed; the descriptive fields are then placeholders. */
  detected: boolean
  /**
   * Free-form text the user attached to THIS machine.
   *
   * Appended to the very end of the prompt and given precedence over the generic
   * guidance — see `buildTerminalPrompt`. '' means nothing was written.
   */
  extraNotes: string
}

export const FALLBACK_ENVIRONMENT: EnvironmentInfo = {
  kind: 'windows',
  osCaption: 'Windows',
  osVersion: '',
  buildNumber: '',
  architecture: '',
  powerShellVersion: '',
  powerShellEdition: '',
  powerShellExe: 'powershell.exe',
  shellPath: '',
  shellVersion: '',
  workingDirectory: '',
  remoteName: '',
  remoteTarget: '',
  detected: false,
  extraNotes: ''
}

/**
 * The part of the prompt that does not depend on which machine is in charge.
 *
 * Shared deliberately. This section is the contract the app parses, and two
 * copies of it would eventually drift — at which point one dialect silently stops
 * round-tripping and the model looks like it is ignoring instructions.
 *
 * NOTE: the JSON example is deliberately VALID (`"description":""`). The app
 * parses the model's replies, so a malformed example would be copied verbatim and
 * break parsing.
 *
 * Inserted verbatim into the composer, so the user sees it in the input box.
 */
const OUTPUT_FORMAT_SECTION = [
  '【工作协议】',
  '按“目标→一条命令→真实结果→下一步”循环；每轮只推进一个可验证步骤，等结果再继续，不猜结果、不重复成功命令。',
  '',
  '【需要执行时】',
  '只输出一个 ```json 代码块，外面不要有文字：',
  '```json',
  '{"command":"...","description":"...","timeout_seconds":120}',
  '```',
  'command 是当前 shell 可直接执行的一条命令；有依赖的动作在其中用 shell 连接符。description 用中文一句话说明目的，不要只复制命令；timeout_seconds 为按工作量估算的 1–1800 整数。',
  'JSON 必须合法：双引号、反斜杠、换行正确转义；命令中的 _、$、* 原样保留。',
  '',
  '【读取结果】',
  '以用户回传的命令、输出、目录、退出码为真实状态；0 继续，非 0/超时/中断/断线先诊断并给最小修正。空输出不等于失败。',
  '',
  '【任务完成】',
  '目标满足且完成必要验证后结束；不输出 JSON，第一行写【任务完成】，随后用中文简述完成内容、验证结果和注意事项。'
].join('\n')

/** Keep terminal mode from turning every kind of request into a shell command. */
const TASK_ROUTING_SECTION = [
  '【任务路由】',
  '终端只处理本机/远程机器、项目文件、进程、依赖、构建、测试、Git、SSH，或用户明确要求执行的命令。',
  '互联网/时效查询、问答、解释、翻译、写作、总结、规划、分析：优先网页搜索、内置工具或技能，不启动 PowerShell、bash、grep、curl、Invoke-WebRequest 等终端搜索。',
  '“搜索一下”未指明本机内容时按资料搜索；明确本机/项目才用终端。需查资料后改本机时先查资料再操作；无对应工具就说明限制。非终端路线直接调用工具或用中文回答，不输出 command JSON。'
].join('\n')

/**
 * Shared by both dialects: when the model should stop and ask instead of acting.
 *
 * It rides on the mechanism the output section already established — answer in
 * plain text with no JSON, and the loop stops and hands control back to the user.
 *
 * One section rather than one per case, because these are instances of a single
 * rule, and a model that has the rule generalises to cases nobody wrote down. The
 * two named here are the common ones and the expensive ones to get wrong: an
 * underspecified task (guessing burns a round trip, usually more) and a tool that
 * is not installed (installing unasked changes the user's machine).
 *
 * It lives in its own labelled section rather than being tacked onto 【工作协议】
 * because the model has to act on it, and a rule buried at the end of a long
 * section about something else is a rule that gets skimmed past.
 *
 * The "look it up first" line is not decoration. Framed as a bare permission, this
 * reads as "ask whenever anything is unknown" — and a model that asks about things
 * it could have checked itself is worse than one that never asks, because the loop
 * exists precisely to save the user that round trip.
 */
const ASK_USER_SECTION = [
  '【判断与确认】',
  '目标明确且可逆时直接推进；先只读核实路径、文件、版本和状态。',
  '目标含糊、缺少用户信息、方案会改变结果或工具未安装时，先用中文说明事实/不确定点/方案/建议并提问；不擅自安装或选差方案。',
  '删除、覆盖、格式化、改权限、发布、发消息、付费等不可逆动作，范围不明先确认；目标明确的代码修改、构建、测试可直接做。提问不输出 JSON，答复后恢复。'
].join('\n')

/** The parts of the prompt only true of a Windows PowerShell session. */
function buildWindowsPrompt(env: EnvironmentInfo): string {
  const osName = env.osCaption.trim() === '' ? 'Windows' : env.osCaption.trim()
  const osDetail = [env.osVersion.trim(), env.architecture.trim()]
    .filter((part) => part !== '')
    .join('，')

  const executable = env.powerShellExe.trim() || 'powershell.exe'
  const shell = [executable, env.powerShellVersion.trim()]
    .filter((part) => part !== '')
    .join(' ')

  // `&&` and `||` arrived in PowerShell 7; in 5.1 they are a syntax error, so
  // telling the model to avoid them is only correct on the older one.
  //
  // When the version could not be read, the executable name still tells us which
  // one it is — assuming 5.1 purely because the probe failed would be wrong on any
  // machine that has pwsh installed.
  const major = Number.parseInt(env.powerShellVersion.split('.')[0] ?? '', 10)
  const knownVersion = Number.isFinite(major)
  const supportsChaining = knownVersion ? major >= 7 : /^pwsh/i.test(executable)
  const isWindowsPowerShell51 =
    major === 5 ||
    env.powerShellEdition.trim().toLowerCase() === 'desktop' ||
    (!knownVersion && !/^pwsh/i.test(executable))

  const chainingRule = supportsChaining
    ? '支持 &&、|| 和 ;。'
    : 'PowerShell 5.1 不支持 &&/||；顺序用 ;，按成功继续用 if ($?)。'

  const fileIoIntro = isWindowsPowerShell51
    ? '【文件读写】PowerShell 5.1 的 Get-Content/Set-Content/Out-File 默认是系统代码页（GBK），会把无 BOM UTF-8 静默读写成乱码。'
    : `【文件读写】${shell} 也必须显式使用 UTF-8（无 BOM）。`
  const fileIoWholeFileRule = isWindowsPowerShell51
    ? '不要用 Get-Content ... | Set-Content/Out-File 改整文件，也不要用 -Encoding utf8（会加 BOM 和额外行尾）。'
    : '不要用 Get-Content ... | Set-Content/Out-File 改整文件，以免改变换行、编码或 BOM。'
  const fileIoSection = [
    fileIoIntro,
    '读：$s = [IO.File]::ReadAllText($p, [Text.UTF8Encoding]::new($false))；写：$s = $s.Replace($old, $new); [IO.File]::WriteAllText($p, $s, [Text.UTF8Encoding]::new($false))。',
    fileIoWholeFileRule,
    "新文件用 [IO.File]::WriteAllText；多行内容用 $src = @' ... '@，引号、$、反引号原样保留。"
  ]

  return [
    '【角色】',
    '你是 PowerShell 终端助手；仅终端路线每轮输出一条命令。',
    '',
    TASK_ROUTING_SECTION,
    '',
    OUTPUT_FORMAT_SECTION,
    '',
    ASK_USER_SECTION,
    '',
    '【执行环境】',
    `- 操作系统：${osName}${osDetail === '' ? '' : `（${osDetail}）`}`,
    `- Shell：${shell}；持久会话。`,
    ...(env.workingDirectory.trim() === '' ? [] : [`- 起始目录：${env.workingDirectory.trim()}`]),
    '- 变量、函数、模块、pushd、当前目录跨命令保留；用变量传递中间结果，不要落盘。',
    '- 不要用 exit（会结束会话）；stdin 为空，勿用交互命令。',
    '',
    '【命令规范】',
    '直接写 PowerShell，不要包 powershell -Command。',
    chainingRule,
    '语法符号用半角 ASCII；中文可写但不能用全角标点。',
    '管道末尾不要 Format-Table/List/Wide（会等完整输入而触发无输出超时）；让对象直接输出或 Select-Object。全仓搜索排除 node_modules/.git/out。',
    '反斜杠加双引号 (\\") 不是转义；用反引号、单引号或 here-string，不要用 [char]39 拼接。字面匹配前把 CRLF 归一化为 LF。',
    '',
    ...fileIoSection,
    '',
    '【优先使用】',
    '- 系统/硬件用 Get-CimInstance，不用 wmic；结构化数据用 ConvertTo-Json/ConvertFrom-Json。',
    ...notesSection(env.extraNotes)
  ].join('\n')
}

/**
 * The prompt for a POSIX machine — in practice a remote host reached over SSH.
 *
 * It is a different prompt rather than the Windows one with a substitute
 * environment line: the whole vocabulary changes (cmdlets, `$env:`, `-Recurse`),
 * and a model told "Linux" while still being shown PowerShell idioms reaches for
 * a mixture of both.
 */
function buildPosixPrompt(env: EnvironmentInfo): string {
  const osName = env.osCaption.trim() === '' ? 'Linux' : env.osCaption.trim()
  const osDetail = [env.osVersion.trim(), env.architecture.trim()]
    .filter((part) => part !== '')
    .join('，')

  const shell = [env.shellPath.trim() || '/bin/sh', env.shellVersion.trim()]
    .filter((part) => part !== '')
    .join(' ')

  const isRoot = /^(root|\/root)/.test(env.workingDirectory.trim())

  return [
    '【角色】',
    '你是 Linux 终端助手；仅终端路线每轮输出一条命令。',
    '',
    TASK_ROUTING_SECTION,
    '',
    OUTPUT_FORMAT_SECTION,
    '',
    ASK_USER_SECTION,
    '',
    '【执行环境】',
    /*
     * Nothing about WHERE this machine is, or how the app reached it.
     *
     * `remoteName` and `remoteTarget` are not interpolated, and neither is any
     * mention of SSH. The prompt is pasted into a third-party chat with every
     * message, so whatever is written here stays there — and the machine's
     * identity is none of the model's business. The name is whatever the user
     * called it ("梯子服务器" says a great deal) and the address identifies it
     * outright, while the transport is an implementation detail of this app
     * rather than of the task.
     *
     * What the model actually needs is the dialect it may write in, and
     * "Linux + bash + this directory" answers that completely.
     */
    `- 操作系统：${osName}${osDetail === '' ? '' : `（${osDetail}）`}`,
    `- Shell：${shell}；持久会话。`,
    ...(env.workingDirectory.trim() === '' ? [] : [`- 起始目录：${env.workingDirectory.trim()}`]),
    `- 当前用户：${isRoot ? 'root（有完整权限，但仍要谨慎）' : '普通用户'}`,
    '- 变量、函数、当前目录跨命令保留；用变量传递中间结果，不要落盘。',
    '- 不要用 exit（会结束会话）；stdin 为空，勿用交互命令。sudo 要密码时停下让用户手动执行。',
    '',
    '【命令规范】',
    '直接写命令，不要包 bash -c/sh -c；可用 &&、||、;。语法符号半角，中文不能代替语法标点。',
    '路径用正斜杠且区分大小写，空格路径加引号。避免 sort/uniq/column -t/tac 等收齐输入的管道；全仓搜索排除 node_modules/.git/out。',
    '',
    '【编码】',
    '文件一律按 UTF-8 处理，不依赖 terminal locale。',
    '',
    '【优先使用】',
    '- 这是 Linux，禁用 PowerShell/cmd 语法（Get-ChildItem、Get-CimInstance、$env:、dir /s、Remove-Item）；用 ls/cat/grep/find/sed/awk。',
    '- 包管理按发行版用 apt-get、dnf/yum 或 apk；结构化数据用 jq 或 python3。',
    ...notesSection(env.extraNotes)
  ].join('\n')
}

/**
 * Build the system prompt for whichever machine the terminal is currently driving.
 *
 * It is rebuilt whenever that answer changes — at startup, after the working
 * directory moves, and when an SSH session takes over or releases the terminal.
 */
export function buildTerminalPrompt(env: EnvironmentInfo): string {
  return env.kind === 'posix' ? buildPosixPrompt(env) : buildWindowsPrompt(env)
}

/**
 * The user's own note about this machine, appended last.
 *
 * Two deliberate choices:
 *
 *   - **It goes last, not first.** Prompt text near the end carries more weight,
 *     and this is the most specific instruction in the whole prompt.
 *   - **It is explicitly given precedence.** The generic sections above contain
 *     concrete advice ("use apt-get", "keep intermediate values in variables")
 *     that is right on average and can be wrong on one particular machine — which
 *     is exactly why the user wrote something. Without the precedence line the
 *     model treats the note as one more suggestion among many and follows the
 *     generic rule instead, which makes the feature look broken.
 *
 * Empty notes add nothing at all: a bare heading with no content would just be
 * noise in every message.
 */
function notesSection(notes: string): string[] {
  const text = notes.trim()
  if (text === '') return []

  return [
    '',
    '【用户补充】',
    '与通用约定冲突时，以这台机器的补充说明为准：',
    text
  ]
}

/** Blank line separating the injected prompt from what the user typed. */
export const TERMINAL_PROMPT_SEPARATOR = '\n\n'

export function buildTerminalPrefix(env: EnvironmentInfo): string {
  return buildTerminalPrompt(env) + TERMINAL_PROMPT_SEPARATOR
}

/** Aggregated interceptor state kept by the main process. */
export interface InterceptorStatus {
  enabled: boolean
  /** True once the injected script has installed itself in the page. */
  installed: boolean
  injectedCount: number
  lastSentText: string | null
  /** Epoch milliseconds when the current user goal was successfully sent. */
  taskStartedAt: number | null
  /** Epoch milliseconds when the final non-command assistant reply settled. */
  taskFinishedAt: number | null
  prefix: string
}

/**
 * One control in the composer's toolbar, as reported by the injected script.
 *
 * The same shape `tools/diag/chatgpt-dom-probe.js` prints for its `composer toolbar buttons`
 * section, so a failure inside the app and a probe run can be read side by side. That is the
 * point: the replacement selector for a button the app failed to click is supposed to come
 * from one of these, and never from a guess.
 */
export interface InterceptorControl {
  tag: string
  testid: string
  aria: string
  disabled: boolean
  cls: string
}

/** Events reported by the injected page script (over the console bridge). */
export interface InterceptorPageEvent {
  event:
    | 'installed'
    | 'configured'
    | 'injected'
    | 'sent'
    | 'user-message'
    | 'user-image-capture'
    | 'assistant-message'
    | 'assistant-history-markdown'
    | 'task-finished'
    | 'send-failed'
    | 'send-recovery'
    | 'end-task'
    | 'inject-failed'
    | 'command'
    | 'parse-failed'
    | 'scan'
    | 'sent-raw'
    | 'raw-busy'
    /** Reported by the injected theme script; see src/main/injected/theme.js. */
    | 'theme'
  count?: number
  text?: string
  /** Token for a page-side batch of user image attachments, on user-message. */
  attachmentToken?: string
  /** Capture diagnostics: where the image was found and how many were read. */
  phase?: 'draft' | 'sent-turn'
  enabled?: boolean
  prefixLength?: number
  /**
   * Opening words of the prompt the PAGE holds, on `injected`.
   *
   * The prompt is stored per view in the main process, so the page can end up configured with an
   * older or generic one. Comparing this with main's own prefix is the only way to see that from
   * a log — otherwise the symptom is just "messages go out without the prompt", which is
   * indistinguishable from terminal mode being off.
   */
  prefixHead?: string
  /** Present on `command` events. */
  messageId?: string
  command?: string
  description?: string
  /** Present on command events: absolute runtime limit selected for this command, in seconds. */
  timeoutSeconds?: number
  /** Present on `command` events: true when it answers a message we just sent. */
  live?: boolean
  /** Present on `task-finished`: true only for an explicitly marked completed task. */
  completed?: boolean

  /*
   * Why a submit did not happen, on `send-failed` and `send-recovery`.
   *
   * The page already knows all of this — whether a send button existed, whether it was
   * disabled, what was left in the composer, whether a stop button was on screen, and what the
   * composer's toolbar actually contained — and used to discard every part of it, leaving the
   * main process to report a bare "stuck". That is what made "the result is in the box and
   * never sent" take a round of guessing even to describe. Diagnostic payload: nothing branches
   * on it.
   */
  attempts?: number
  /** Which recovery action the failing pass used, or null when none had run yet. */
  recoveryTried?: string | null
  composerKind?: string | null
  /** What was still sitting in the composer, truncated. */
  composerLeft?: string
  sendButtonFound?: boolean
  sendButtonDisabled?: boolean | null
  sendButton?: InterceptorControl | null
  stopButtonFound?: boolean
  /** Present on `end-task`: what the stop button was, when one was found at all. */
  stopButton?: InterceptorControl | null
  /** Present on `end-task`: which of `stopButtonSelectors` actually matched. */
  matchedBy?: string[]
  /**
   * Present on `end-task`: the composer control the structural fallback clicked, when no stop
   * selector matched. Null means it did not run — either a selector matched, or the guards
   * (a reply pending, and an empty composer) were not satisfied.
   */
  primaryFallback?: InterceptorControl | null
  toolbar?: InterceptorControl[]
  /** How many controls the toolbar held, when `toolbar` is a window onto both its ends. */
  toolbarCount?: number
  /** Present on `send-recovery`: the action about to be attempted. */
  action?: string

  /*
   * Present on `scan`: why a settled reply produced no command.
   *
   * Every early return between "the reply is on screen" and "a command ran" is silent, so
   * without these a model that answers with a perfectly good JSON block and gets nothing back
   * leaves no evidence anywhere. `reason` names the bail; the rest is whatever that bail needs
   * to be read — the marker a turn failed to match, the text that parsed to nothing, whether the
   * braces had balanced yet.
   */
  reason?: string
  textHead?: string
  bracesBalanced?: boolean
  /**
   * Present on `parse-failed`: how long the reply was, how many `{…}` were found in it, and the
   * candidate the JSON parser was actually given.
   *
   * `text` used to be capped at 300 characters and the user-facing hint guessed at the cause
   * ("多半是引号没转义"). That guess is wrong often enough to send the model — and the reader —
   * after the wrong thing, and 300 characters did not even reach the end of the `command` value.
   */
  textLength?: number
  objectCount?: number
  lastObject?: string | null
  /** Present on `scan`/`not-assistant-turn`: the selectors that failed to match. */
  wanted?: string[]
  selectors?: string[]
  tag?: string
  cls?: string
  /** Present on `end-task`: the page-side flags at the moment the task was stopped. */
  awaitingReply?: boolean
  taskActive?: boolean

  /*
   * Present on `theme`: what the app asked the page for, what the page actually looks like,
   * and what was done about it.
   *
   * A page that ignores the app's theme and a page that has been themed correctly are
   * IDENTICAL in every other signal this app has — nothing else reads a colour or a class,
   * so "the theme sync silently did nothing" has no symptom. These fields are the symptom:
   * `page` is measured from the page's computed colours, `lever` names the hook that
   * provably moved it, and `tried` lists the hooks that did not, with what they measured.
   * `hints` is the discovery half — the site's own theme-shaped localStorage entries, which
   * is where a durable storage rule comes from.
   */
  want?: string
  page?: string
  applied?: string
  /**
   * The declared DOM mutation the page was put into, as `body/class:dark=true`.
   *
   * `mutations` lists the whole applied set: DeepSeek's dark mode is three coordinated
   * changes, and a report naming only the first would read as if one class were the whole
   * mechanism.
   */
  mutation?: string | null
  mutations?: string[]
  tried?: string[]
  declared?: number
  evidence?: string
  hints?: string[]
  storageKeys?: string[]
  retry?: number
  /** What the page believes the OS preference is; on `theme`, not `scan`. */
  query?: string
}

/* ------------------------------------------------------------------ *
 * Commands, executions and the per-conversation terminal
 * ------------------------------------------------------------------ */

export type ExecutionStatus =
  | 'pending'
  | 'blocked'
  | 'running'
  | 'interrupted'
  | 'done'
  | 'failed'
  | 'timeout'
  | 'skipped'

/** One command lifted out of an assistant reply, and what happened to it. */
export interface ExecutionRecord {
  /** ChatGPT's own assistant message id — the idempotency key. */
  messageId: string
  conversationId: string
  command: string
  description: string
  /** Absolute runtime limit selected for this command, in seconds. */
  timeoutSeconds: number
  status: ExecutionStatus
  exitCode: number | null
  output: string
  createdAt: number
  /** Epoch milliseconds when the command actually started running. */
  startedAt: number | null
  finishedAt: number | null
}

/** A command the injected script found in the page but main has not stored yet. */
export interface ParsedCommand {
  messageId: string
  command: string
  description: string
  /** Absolute runtime limit selected for this command, in seconds. */
  timeoutSeconds: number
  /**
   * The only thing that matters for safety: is this reply an answer to a message
   * the app just sent, or is it history that happened to be on screen?
   *
   * Only `live` commands are ever executed automatically. History is still
   * stored and shown, so the user can run it by hand.
   */
  live: boolean
}

/**
 * How detected commands are handled.
 *
 * - `manual` — every command is stored and waits for a click on 运行.
 * - `auto`   — commands run as soon as they arrive.
 *
 * In BOTH modes the result is handed back to the model, and in both modes a
 * command that was already on screen when the conversation was opened is never
 * run automatically (see `armBaseline` in the injected script).
 */
export type ExecutionMode = 'auto' | 'manual'

/** Terminal-mode automation state. */
export interface AutomationState {
  mode: ExecutionMode
  /** Global stop: no command runs and no result is sent while this is true. */
  paused: boolean
}

export type TerminalLineKind = 'command' | 'output' | 'notice' | 'error'

export interface TerminalLine {
  kind: TerminalLineKind
  text: string
}

/**
 * Snapshot of the local shell session, pushed to the renderer.
 *
 * There is exactly ONE local terminal for the whole app — not one per
 * conversation. It is a window onto a machine, and the machine does not change
 * when you click a different chat: per-conversation shells made sending the first
 * message of a new chat clear the screen and move the model to the home
 * directory, while the prompt still claimed the directory the user had chosen.
 * That is why this carries no conversation id: it does not belong to one.
 */
export interface TerminalState {
  /** True while the shell can accept commands. */
  alive: boolean
  /** Current working directory reported by the shell, when known. */
  cwd: string
  lines: TerminalLine[]
  /**
   * Seconds to wait after a model-driven command finishes, before its output is
   * handed back to the model. 0 sends it straight away.
   *
   * In-memory and per session on purpose: it paces the loop, it is not a stored
   * preference, and a restart going back to 0 is the safe default.
   */
  sendDelaySeconds: number
}

/* ------------------------------------------------------------------ *
 * SSH
 * ------------------------------------------------------------------ */

/**
 * A stored SSH target.
 *
 * The password is NOT part of this: it lives encrypted in the database, and all
 * the renderer ever learns is whether one is stored.
 */
export interface SshHost {
  id: string
  /** What the user calls this machine. */
  name: string
  host: string
  port: number
  username: string
  /**
   * Per-host proxy override. Empty means "follow the sshProxy setting".
   * (There is deliberately no way to force direct while a default is set — the
   * distinction is not worth a third state in the UI.)
   */
  proxy: string
  /** True when an encrypted password is on file for this host. */
  hasPassword: boolean
  updatedAt: number
}

/** What the connect form submits. `id` is present when updating a stored host. */
export interface SshHostDraft {
  id: string | null
  name: string
  host: string
  port: number
  username: string
  /** Empty means "use the stored password", or prompt-free failure if none. */
  password: string
  /** Empty means "use the sshProxy setting". */
  proxy: string
}

export type SshStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface SshFileEntry {
  /** Absolute remote path, also used as the FileManager id. */
  id: string
  name: string
  type: 'file' | 'folder'
  size: number
  /** Unix epoch milliseconds. */
  modifiedAt: number
}

export type SshUploadStatus = 'uploading' | 'completed' | 'cancelled' | 'failed'

export interface SshUploadTask {
  id: string
  name: string
  localPath: string
  remotePath: string
  status: SshUploadStatus
  transferred: number
  total: number
  startedAt: number
  finishedAt: number | null
  error: string
}

export type SshDownloadStatus = 'downloading' | 'completed' | 'cancelled' | 'failed'

export interface SshDownloadTask {
  id: string
  name: string
  remotePath: string
  localPath: string
  status: SshDownloadStatus
  transferred: number
  total: number
  startedAt: number
  finishedAt: number | null
  error: string
}

export type SshTransferDirection = 'upload' | 'download'

export interface SshTransferTask {
  sessionId: string
  direction: SshTransferDirection
  id: string
  name: string
  localPath: string
  remotePath: string
  status: SshUploadStatus | SshDownloadStatus
  transferred: number
  total: number
  startedAt: number
  finishedAt: number | null
  error: string
}

export interface SshState {
  status: SshStatus
  /**
   * True from the moment a connection is attempted until the user dismisses it.
   *
   * The pane keeps showing the SSH transcript while attached — including after a
   * failure, so the error is readable instead of vanishing.
   */
  attached: boolean
  /** Display name / address of the attached host, for the header. */
  name: string
  target: string
  /**
   * Id of the stored host this session came from, or '' when there is none.
   *
   * The host picker marks the active row by id rather than by address: two saved
   * entries may well point at the same machine under different users or ports, and
   * "which of these am I currently on" has to have exactly one answer.
   */
  hostId: string
  /** Human-readable status or failure reason. */
  message: string
  /**
   * True once this host has taken over command execution.
   *
   * From that moment the model's commands run HERE, not on the local machine, and
   * the injected prompt describes this host. The two must agree: a prompt that
   * says Linux while PowerShell executes would send the model straight into
   * commands that cannot work.
   */
  remoteExec: boolean
  /**
   * Working directory of the shell that runs the MODEL's commands.
   *
   * Shown separately from the interactive prompt because they are two different
   * sessions: typing `cd /tmp` in the pane does not move the model's shell.
   */
  modelCwd: string
  lines: TerminalLine[]
}

/* ------------------------------------------------------------------ *
 * Per-machine notes
 * ------------------------------------------------------------------ */

/**
 * Free-form text the user attaches to ONE machine, appended to that machine's
 * system prompt.
 *
 * Scoped to the machine rather than to the app because the content that makes
 * this worth having is machine-specific — "the project lives in /srv/app", "do
 * not touch /data", "use the internal npm registry". Carrying it to a different
 * host would be worse than having no note at all.
 */
export interface TerminalNotes {
  /** Which kind of machine owns this note. */
  scope: 'local' | 'ssh'
  /** The saved host id when `scope` is 'ssh'; '' for the local machine. */
  hostId: string
  /** Who it belongs to, for the editor's title. */
  label: string
  /** The note itself. '' when nothing has been written. */
  text: string
}

/* ------------------------------------------------------------------ *
 * Renderer API surface
 * ------------------------------------------------------------------ */

/**
 * The API surface exposed on `window.api` by the preload script.
 * This is the single source of truth: the preload implements it and the
 * renderer consumes it, so the two can never drift apart.
 */
export interface AppApi {
  getAppInfo(): Promise<AppInfo>
  /** Read the Git history of the repository that contains `cwd`. */
  getGitLog(cwd: string): Promise<GitLogResult>
  /** Read the unified diff of one changed path. */
  getGitDiff(cwd: string, path: string): Promise<GitFileDiff>
  /** Sessions currently owned by the outer manager. */
  listManagedSessions(): Promise<ManagedSessionSummary[]>
  /**
   * Create a managed session.
   *
   * A session is created for a PURPOSE — this machine, or a host over SSH — and the model it
   * talks to is chosen inside the chat (see `switchSessionPlatform`). So the platform is not a
   * parameter: every new session starts on the default and the user switches from there.
   */
  createManagedSession(kind: 'local' | 'ssh'): Promise<ManagedSessionSummary | null>
  openManagedSession(id: string): Promise<boolean>
  renameManagedSession(id: string, title: string): Promise<boolean>
  destroyManagedSession(id: string): Promise<boolean>
  /**
   * Show a different chat platform inside the CURRENT session.
   *
   * Both platforms' views stay alive, so this preserves the SSH connection, the terminal
   * scrollback and each side's conversation. What it does NOT do is move a conversation from
   * one site to the other — the sites have separate accounts and separate history, so each
   * keeps its own and switching is a change of which one is in front.
   */
  switchSessionPlatform(platformId: string): Promise<boolean>
  /** Pop a native menu of the chat platforms; resolves to the chosen id, or null when dismissed. */
  showModelMenu(currentId: string): Promise<string | null>
  onManagedSessionsChanged(listener: (items: ManagedSessionSummary[]) => void): () => void
  getWorkspaceState(): Promise<WorkspaceState>
  showWorkspaceManager(): Promise<boolean>
  setWorkspaceSshDialogOpen(open: boolean): void
  onWorkspaceChanged(listener: (state: WorkspaceState) => void): () => void
  /** Upload and download tasks across every managed SSH session. */
  getSshTransfers(): Promise<SshTransferTask[]>
  /** Cancel one global transfer by owning session, direction and task id. */
  cancelSshTransfer(sessionId: string, direction: SshTransferDirection, id: string): Promise<boolean>
  onSshTransfersChanged(listener: (items: SshTransferTask[]) => void): () => void
  /** Position the native embedded view under the renderer's placeholder. */
  setEmbedBounds(bounds: EmbedBounds): void
  /** Hide/show the native view (needed while a modal covers it). */
  setEmbedVisible(visible: boolean): void
  sendEmbedCommand(command: EmbedCommand): void
  navigateEmbed(url: string): void
  /** Current embed snapshot; call once on mount to cover events fired before subscribing. */
  getEmbedState(): Promise<EmbedState>
  /** Subscribe to embed state; returns an unsubscribe function. */
  onEmbedState(listener: (state: EmbedState) => void): () => void
  /**
   * Point the embedded view at the email/OTP sign-in page.
   *
   * The only route that can sign in inside the embed: provider OAuth is refused by
   * the provider, and the system browser cannot hand its session back.
   */
  loginWithEmail(): void
  /**
   * Write a session cookie copied out of a normal browser into the embed's
   * partition, then reload and report whether the page is signed in.
   *
   * The escape hatch for accounts that cannot sign in any other way: a ChatGPT
   * account created with Google has no password, and Google refuses embedded
   * sign-in — so the only credential that can be moved into this app is the
   * session token the browser already holds.
   */
  importSession(platformId: string, draft: SessionImportDraft): Promise<SessionImportResult>
  /**
   * Report what a paste WOULD import, without writing anything.
   *
   * The user should not have to guess whether they copied the right row out of DevTools.
   * Side-effect free, so the dialog can call it as they type.
   */
  previewSessionImport(draft: SessionImportDraft): Promise<SessionImportResult>
  /**
   * Import a whole pasted cookie set into ONE PLATFORM's partition.
   *
   * `platformId`, not "the current session", because the login state is global: a partition is
   * per PLATFORM and every session of that platform shares it. Routing this through the active
   * session made the target depend on which tab happened to be in front, which is not a fact
   * about the login at all.
   *
   * `raw` is whatever came out of DevTools — a bare `name=value; …` line, a whole `cookie:`
   * header line, or "Copy as cURL". The parser accepts all three, because asking the user to
   * reformat is asking for a failed import.
   *
   * The value is held in memory for the length of one call and never logged or echoed back.
   */
  importCookieSet(platformId: string, raw: string): Promise<SessionImportResult>
  /** Whether the embedded page is signed in (cookie names only, never values). */
  getEmbedAuthState(): Promise<EmbedAuthState>
  /** Open ChatGPT in the user's normal browser. */
  openChatgptExternal(): void

  /** All stored conversations, newest first. */
  listConversations(): Promise<Conversation[]>
  /** Clean user/assistant transcript for one conversation, oldest first. */
  listConversationMessages(conversationId: string): Promise<ConversationMessage[]>
  /** Read one persisted attachment as a data URL for renderer display. */
  readConversationAttachment(attachmentId: string): Promise<string | null>
  /** Scrape the page's sidebar and merge it into the database. */
  syncConversations(): Promise<Conversation[]>
  removeConversation(id: string): Promise<Conversation[]>
  /** Move a conversation into another project folder on the current machine. */
  moveConversation(id: string, projectId: string): Promise<Conversation[]>
  /** Fires whenever the stored set changes (auto-saved or synced). */
  onConversationsChanged(listener: (items: Conversation[]) => void): () => void

  /** Terminal-mode send interceptor. */
  getInterceptorStatus(): Promise<InterceptorStatus>
  setInterceptorEnabled(enabled: boolean): Promise<InterceptorStatus>
  /** Stop the current model/terminal loop and mark the task as manually ended. */
  endTask(): Promise<InterceptorStatus>
  onInterceptorEvent(listener: (status: InterceptorStatus) => void): () => void

  /** Persisted app settings (currently just the embed proxy). */
  getSettings(): Promise<AppSettings>
  updateSettings(patch: AppSettingsPatch): Promise<AppSettings>

  /** What the startup probe found out about this machine. */
  getEnvironment(): Promise<EnvironmentInfo>
  /**
   * Fires whenever the description of the machine in charge changes — the probe
   * finishing at startup, the terminal moving, or an SSH session taking over.
   */
  onEnvironmentChanged(listener: (info: EnvironmentInfo) => void): () => void

  /** Terminal-mode automation (execution mode + pause). */
  getAutomationState(): Promise<AutomationState>
  setAutomationMode(mode: ExecutionMode): Promise<AutomationState>
  setAutomationPaused(paused: boolean): Promise<AutomationState>
  /** Re-scan the last reply right now, ignoring the "already seen" guard. */
  checkLastReply(): Promise<AutomationState>
  onAutomationChanged(listener: (state: AutomationState) => void): () => void

  /** Command executions for a conversation, oldest first. */
  listExecutions(conversationId: string): Promise<ExecutionRecord[]>
  /** Run a command that is waiting (blocked or pending). */
  runExecution(messageId: string): Promise<ExecutionRecord[]>
  /** Mark a waiting command as skipped. */
  skipExecution(messageId: string): Promise<ExecutionRecord[]>
  onExecutionChanged(listener: (records: ExecutionRecord[]) => void): () => void

  /** The terminal belonging to the current conversation. */
  getTerminalState(): Promise<TerminalState>
  /** Type a command straight into the conversation's shell. */
  sendTerminalInput(text: string): Promise<TerminalState>
  /** Stop the command currently running in the execution shell. */
  interruptTerminal(): Promise<TerminalState>
  /** Kill the shell and start a fresh one. */
  resetTerminal(): Promise<TerminalState>
  /**
   * Move the terminal to another directory.
   *
   * Changing where the terminal lives changes the environment the model is told
   * about, so the probe is re-run and the prompt rebuilt.
   */
  setTerminalCwd(path: string): Promise<TerminalState>
  /**
   * How long to wait after a model-driven command finishes before its output goes
   * back to the model. Clamped to 0..600 seconds; 0 disables the wait.
   */
  setTerminalSendDelay(seconds: number): Promise<TerminalState>
  onTerminalChanged(listener: (state: TerminalState) => void): () => void

  /**
   * The note attached to whichever machine the terminal is driving right now.
   *
   * Resolved in the main process against the live backend, so the renderer never
   * has to work out which machine is in charge — the same value the prompt is
   * built from.
   */
  getTerminalNotes(): Promise<TerminalNotes>
  setTerminalNotes(text: string): Promise<TerminalNotes>
  onTerminalNotesChanged(listener: (notes: TerminalNotes) => void): () => void

  /** Saved SSH targets, newest first. */
  listSshHosts(): Promise<SshHost[]>
  /** Connect (saving or updating the host first). */
  connectSsh(draft: SshHostDraft): Promise<SshState>
  disconnectSsh(): Promise<SshState>
  /** Close the SSH transcript and go back to the local terminal. */
  dismissSsh(): Promise<SshState>
  removeSshHost(id: string): Promise<SshHost[]>
  getSshState(): Promise<SshState>
  /** Type a line into the remote shell. */
  sendSshInput(text: string): Promise<SshState>
  /** Pick local files and upload them to the current remote working directory. */
  uploadSshFiles(): Promise<SshState>
  /** Current and recently finished uploads for this SSH session. */
  getSshUploads(): Promise<SshUploadTask[]>
  /** Cancel one in-progress upload. */
  cancelSshUpload(id: string): Promise<boolean>
  onSshUploadsChanged(listener: (items: SshUploadTask[]) => void): () => void
  /** List one remote directory over SFTP. */
  listSshFiles(path: string): Promise<SshFileEntry[]>
  /** Pick a local destination and start downloading one remote file over SFTP. */
  downloadSshFile(path: string): Promise<boolean>
  /** Current and recently finished downloads for this SSH session. */
  getSshDownloads(): Promise<SshDownloadTask[]>
  /** Cancel one in-progress download. */
  cancelSshDownload(id: string): Promise<boolean>
  onSshDownloadsChanged(listener: (items: SshDownloadTask[]) => void): () => void
  onSshChanged(listener: (state: SshState) => void): () => void
  /** Current application-updater state. */
  getUpdateStatus(): Promise<UpdateStatus>
  /** Ask GitHub whether a newer release exists. */
  checkForUpdates(): Promise<UpdateStatus>
  /** Start downloading the offered update. */
  downloadUpdate(): Promise<UpdateStatus>
  /** Quit and install an already-downloaded update. */
  installUpdate(): Promise<void>
  /** Fires on every updater phase/progress change. */
  onUpdateChanged(listener: (status: UpdateStatus) => void): () => void
}

/** Author of a Git commit. */
export interface GitAuthor {
  name?: string
  email?: string
}

/** One commit in the log, shaped for the log table. */
export interface GitLogEntry {
  hash: string
  branch: string
  parents: string[]
  message: string
  author?: GitAuthor
  committerDate: string
  authorDate?: string
}

/** Counts of changed files in the working tree and index. */
export interface GitIndexStatus {
  modified: number
  added: number
  deleted: number
}

/** How a path changed, used to pick the badge colour in the file list. */
export type GitChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'

/** One changed path, with the line counts the file list shows. */
export interface GitFileChange {
  path: string
  /** Previous path, only set for renames. */
  oldPath?: string
  kind: GitChangeKind
  /** Single-letter status as Git reports it, for the badge. */
  code: string
  additions: number
  deletions: number
}

/** One line of a unified diff. */
export interface GitDiffLine {
  kind: 'context' | 'add' | 'del'
  oldNumber?: number
  newNumber?: number
  text: string
}

/** One @@ hunk of a unified diff. */
export interface GitDiffHunk {
  header: string
  lines: GitDiffLine[]
}

/** The diff of a single changed path. */
export interface GitFileDiff {
  path: string
  /** True when Git refuses to render a text diff for this path. */
  binary: boolean
  hunks: GitDiffHunk[]
  additions: number
  deletions: number
  /** Raw `@@` hunks, fed straight to the diff viewer. */
  rawHunks: string[]
  /** File contents before the change; empty for a new file. */
  oldContent: string
  /** File contents as they are on disk now. */
  newContent: string
  /** Language hint for the highlighter. */
  lang: string
}

/** Result of inspecting the repository that contains a directory. */
export interface GitLogResult {
  isRepo: boolean
  currentBranch: string
  entries: GitLogEntry[]
  indexStatus: GitIndexStatus
  files: GitFileChange[]
  error?: string
}



