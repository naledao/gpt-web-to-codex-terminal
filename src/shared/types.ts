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
  embedGetExternalAuth: 'embed:get-external-auth',
  embedExternalAuth: 'embed:external-auth',
  embedLoginWithEmail: 'embed:login-with-email',
  embedImportSession: 'embed:import-session',
  embedPreviewSession: 'embed:preview-session',
  embedGetAuthState: 'embed:get-auth-state',
  openChatgptExternal: 'app:open-chatgpt-external',
  conversationsList: 'conversations:list',
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
  workspaceGetState: 'workspace:get-state',
  workspaceShowManager: 'workspace:show-manager',
  workspaceSetOpenSshDialog: 'workspace:set-open-ssh-dialog',
  workspaceChanged: 'workspace:changed'
} as const

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels]

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
   * Which chat site this session drives (`'chatgpt'` / `'deepseek'`).
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
 * A real ChatGPT conversation URL looks like:
 *   https://chatgpt.com/c/6ab156eb-1b00-83e8-b973-a6a59295a353
 *
 * The `/c/` route also serves non-conversation placeholders such as
 * `https://chatgpt.com/c/WEB`, so the id is validated by SHAPE rather than
 * accepted as "whatever slug is in the path". Only UUIDs are real conversations
 * and only those are persisted.
 */
const CONVERSATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
export interface AppSettings {
  /**
   * HTTP proxy for the EMBEDDED chatgpt.com view only.
   *
   * Deliberately scoped to the embed's session rather than the whole app: the
   * proxy exists to reach chatgpt.com, and routing everything through it would
   * also drag the app's own traffic along with it.
   *
   * Empty string means direct.
   */
  embedProxy: string
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

export type ExternalAuthProvider = 'google' | 'apple'

/** A third-party OAuth page was redirected out of the embedded session. */
export interface ExternalAuthNotice {
  provider: ExternalAuthProvider
  openedAt: number
}

/** Snapshot of the embedded view, pushed from main to the renderer. */
export interface EmbedState {
  url: string
  title: string
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** Set when the current URL is a conversation (`/c/<id>`). */
  conversationId: string | null
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
  '【输出格式】',
  '任务还没完成时，把 JSON 放进一个 ```json 代码块里输出，代码块之外不要有任何文字：',
  '```json',
  '{"command":"","description":"","timeout_seconds":0}',
  '```',
  '- command：要执行的命令。',
  '- description：这条命令在做什么，用中文一句话说明。',
  '- timeout_seconds：只要 command 非空就**必须填写**，由你根据这条命令的实际工作量估算合理的整数秒数，不要所有命令机械使用同一个值。',
  '  简单读取/检查通常几十秒；构建、测试、网络操作、大范围搜索应合理放宽。允许 1-1800 秒；command 为空表示任务完成时填 0。',
  '  这是本条命令的绝对运行上限：必须给出有限值，禁止无限等待，并应留出合理余量避免正常任务被过早终止。',
  '**必须用代码块包裹**：ChatGPT 的界面会把回复按 Markdown 渲染，而命令行里大量使用',
  '下划线（$_、$env:、$()）和星号（*.txt、*）—— 不放进代码块的话，这些字符会被当成',
  'Markdown 的斜体/加粗标记而**从命令里消失**，我就只能执行一条被改坏的命令。',
  '用户会把执行结果（输出、退出码、当前目录）发回给你，你据此决定下一步。',
  '任务已经完成时，**不要再输出 JSON**，第一行固定输出【任务完成】，然后像平常聊天一样用中文回复用户：',
  '说明你做了什么、结果如何、以及需要用户注意的地方。这个标记用于让应用可靠触发系统通知。'
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
 * It lives in its own labelled section rather than being tacked onto 【输出格式】
 * because the model has to act on it, and a rule buried at the end of a long
 * section about something else is a rule that gets skimmed past.
 *
 * The "look it up first" line is not decoration. Framed as a bare permission, this
 * reads as "ask whenever anything is unknown" — and a model that asks about things
 * it could have checked itself is worse than one that never asks, because the loop
 * exists precisely to save the user that round trip.
 */
const ASK_USER_SECTION = [
  '【不确定时】',
  '拿不准就**停下来问用户** —— 这不是失败，是正常的一步。典型情况：任务本身没说清',
  '（目标模糊、有明显不同的几种做法、缺一个只有用户知道的信息），或者这一步需要的工具',
  '这台机器上没有装（**不要擅自安装**，也不要为了绕开它去拼一个更差的替代方案）。',
  '但**自己能查清楚的不要问**：先看文件、读代码、跑一条只读命令确认，再决定要不要问。',
  '问的时候直接正常回复用户（**不输出 JSON**），说清你在纠结什么、有哪几种选择、你倾向哪个',
  '以及为什么，然后等用户回答；得到答复后继续输出 JSON 推进任务。'
].join('\n')

/** The parts of the prompt only true of a Windows PowerShell session. */
function buildWindowsPrompt(env: EnvironmentInfo): string {
  const osName = env.osCaption.trim() === '' ? 'Windows' : env.osCaption.trim()
  const osDetail = [env.osVersion.trim(), env.architecture.trim()]
    .filter((part) => part !== '')
    .join('，')

  const shell = [env.powerShellExe.trim() || 'powershell.exe', env.powerShellVersion.trim()]
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
  const supportsChaining = knownVersion ? major >= 7 : /^pwsh/i.test(env.powerShellExe.trim())

  const chainingRule = supportsChaining
    ? '2. 可以用 && 和 || 做链式执行，也可以用 ; 顺序执行。'
    : '2. 这是 PowerShell 5.1，**不支持 && 和 ||**（写了直接语法错误）：顺序执行用 ; ，需要"上一步成功才继续"用 if ($?)。'

  return [
    '【角色】',
    '你是一个 PowerShell 终端助手。用户把目标发给你，你每次只输出一条命令来推进它。',
    '',
    OUTPUT_FORMAT_SECTION,
    '',
    ASK_USER_SECTION,
    '',
    '【执行环境】',
    `- 操作系统：${osName}${osDetail === '' ? '' : `（${osDetail}）`}`,
    `- Shell：${shell}，而且是一个**持久会话**（同一个会话一直活着）。`,
    ...(env.workingDirectory.trim() === '' ? [] : [`- 起始目录：${env.workingDirectory.trim()}`]),
    '- 变量、函数、导入的模块、pushd、当前目录**都保留到下一条命令**。',
    '  可以像在真终端里一样逐步积累状态：先 $x = ...，下一条命令直接用 $x；先定义函数，后面直接调用。',
    '  不要为了"跨命令记住"而把中间结果写进文件 —— 用变量即可。',
    '- 不要使用 exit：它会结束会话，丢掉全部状态。',
    '- 命令的标准输入是空的，不要使用需要交互输入的命令。',
    '',
    '【命令规范】',
    '1. 直接写 PowerShell 命令本身，不要再包一层 powershell -Command。',
    chainingRule,
    '3. 语法符号必须用半角 ASCII：引号、分号、管道 | 、重定向 > >> 都不要用全角。',
    '4. 需要中文内容时中文照常写（例如 Set-Content a.md "你好" -Encoding utf8），但不要用全角标点充当语法符号。',
    '5. **管道末尾不要接 Format-Table / Format-List / Format-Wide** —— 它们要收齐**全部**输入才吐第一行，',
    '   一个几万文件的搜索会沉默好几分钟，而超时是按「多久没有输出」判定的，看起来和卡死完全一样。',
    '   要表格让对象直接输出即可（或先 Select-Object 挑列）。**全仓搜索先排除 node_modules / .git / out**，',
    '   否则又慢又吵。',
    '',
    '【编码】',
    '写文件固定用 UTF-8：Out-File -Encoding utf8 或 Set-Content -Encoding utf8。',
    '',
    '【优先使用】',
    '- 系统与硬件信息用 Get-CimInstance（wmic 已废弃，不要再用）。',
    '- 结构化数据用 ConvertTo-Json / ConvertFrom-Json，比手工拼文本可靠。',
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
    '你是一个 Linux 终端助手。用户把目标发给你，你每次只输出一条命令来推进它。',
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
    `- Shell：${shell}，而且是一个**持久会话**（同一个会话一直活着）。`,
    ...(env.workingDirectory.trim() === '' ? [] : [`- 起始目录：${env.workingDirectory.trim()}`]),
    `- 当前用户：${isRoot ? 'root（有完整权限，但仍要谨慎）' : '普通用户'}`,
    '- 变量、函数、当前目录**都保留到下一条命令**。',
    '  可以像在真终端里一样逐步积累状态：先 x=...，下一条命令直接用 $x；先定义函数，后面直接调用。',
    '  不要为了"跨命令记住"而把中间结果写进文件 —— 用变量即可。',
    '- 不要使用 exit：它会结束会话，丢掉全部状态。',
    '- 命令的标准输入是空的，不要使用需要交互输入的命令。',
    '  sudo 需要密码时会一直等下去：请改用不需要密码的写法，或者干脆停下来让用户手动执行。',
    '',
    '【命令规范】',
    '1. 直接写命令本身，不要再包一层 bash -c 或 sh -c。',
    '2. 可以用 && 和 || 做链式执行，也可以用 ; 顺序执行。',
    '3. 语法符号必须用半角 ASCII：引号、分号、管道 | 、重定向 > >> 都不要用全角。',
    '4. 需要中文内容时中文照常写（例如 printf 或 heredoc），但不要用全角标点充当语法符号。',
    '5. 路径用正斜杠，注意大小写敏感；带空格的路径要加引号。',
    '6. 不要写「收齐输入才输出」的管道（sort、uniq、column -t、tac 都是）—— 大范围搜索会沉默很久，',
    '   而超时是按「多久没有输出」判定的，看起来和卡死完全一样。',
    '   **全仓搜索先排除 node_modules / .git / out**，否则又慢又吵。',
    '',
    '【编码】',
    '文件内容一律按 UTF-8 处理，不要依赖远端 terminal 的 locale。',
    '',
    '【优先使用】',
    '- **这是 Linux，不要使用 PowerShell 或 cmd 的语法**：Get-ChildItem、Get-CimInstance、',
    '  $env:、dir /s、Remove-Item 在这里都不存在。用 ls / cat / grep / find / sed / awk。',
    '- 包管理按发行版来：Debian/Ubuntu 用 apt-get，RHEL 系用 dnf 或 yum，Alpine 用 apk。',
    '- 结构化数据优先交给 jq 或 python3 处理，比手工截文本可靠。',
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
    '以下是用户针对这台机器补充的说明。**它与上面的通用约定冲突时，以这里为准**：',
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

/** Events reported by the injected page script (over the console bridge). */
export interface InterceptorPageEvent {
  event:
    | 'installed'
    | 'configured'
    | 'injected'
    | 'sent'
    | 'task-finished'
    | 'send-failed'
    | 'inject-failed'
    | 'command'
    | 'parse-failed'
    | 'sent-raw'
    | 'raw-busy'
  count?: number
  text?: string
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
  /** Snapshot of the last OAuth provider opened in the system browser. */
  getExternalAuthNotice(): Promise<ExternalAuthNotice | null>
  /** Fires when a third-party OAuth provider is sent to the system browser. */
  onExternalAuth(listener: (notice: ExternalAuthNotice) => void): () => void
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
  importSession(draft: SessionImportDraft): Promise<SessionImportResult>
  /**
   * Report what a paste WOULD import, without writing anything.
   *
   * The user should not have to guess whether they copied the right row out of DevTools.
   * Side-effect free, so the dialog can call it as they type.
   */
  previewSessionImport(draft: SessionImportDraft): Promise<SessionImportResult>
  /** Whether the embedded page is signed in (cookie names only, never values). */
  getEmbedAuthState(): Promise<EmbedAuthState>
  /** Open ChatGPT in the user's normal browser. */
  openChatgptExternal(): void

  /** All stored conversations, newest first. */
  listConversations(): Promise<Conversation[]>
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
}
