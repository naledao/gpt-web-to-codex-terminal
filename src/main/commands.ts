import type {
  AutomationState,
  EnvironmentKind,
  ExecutionMode,
  ExecutionRecord,
  ParsedCommand,
  TerminalLine,
  TerminalState
} from '../shared/types'
import { ConversationShell, IDLE_TIMEOUT_MS, MAX_RUNTIME_MS } from './shell'
import type { ExecutionShell, ShellResult } from './shell'
import type { ConversationStore } from './db'

/**
 * Commands that get a loud warning line. They still RUN in auto mode — this is an
 * audit aid, not a gate (see handleDetected).
 *
 * Covers both dialects, because the model writes whichever one the prompt asked
 * for: PowerShell cmdlets and the legacy executables they can still call, plus the
 * POSIX commands that do the same damage on a remote host. A Windows-only list
 * would leave the remote path with no audit trail at all, which is exactly
 * backwards — the remote host is the one that is not the user's own machine.
 */
const DANGEROUS_PATTERNS: Array<{ re: RegExp; label: string }> = [
  // Disks — irreversible.
  { re: /\b(format|clear|initialize)-disk\b/i, label: 'Format/Clear/Initialize-Disk（磁盘操作）' },
  { re: /\bformat-volume\b/i, label: 'Format-Volume（格式化卷）' },
  { re: /\bdiskpart\b/i, label: 'diskpart（分区操作）' },
  { re: /\bformat\s+[a-z]:/i, label: 'format X:（格式化磁盘）' },
  { re: /\bmkfs(\.\w+)?\b/i, label: 'mkfs（格式化文件系统）' },
  { re: /\bdd\b[^\n]*\bof=\/dev\//i, label: 'dd of=/dev/…（直接写块设备）' },
  { re: /\bvssadmin\b/i, label: 'vssadmin（卷影副本）' },
  { re: /\bbcdedit\b/i, label: 'bcdedit（引导配置）' },
  { re: /\bcipher\s+\/w/i, label: 'cipher /w（擦除磁盘空闲空间）' },
  // Power state.
  { re: /\b(stop|restart)-computer\b/i, label: 'Stop/Restart-Computer（关机/重启）' },
  { re: /\b(shutdown|reboot|poweroff|halt)\b/i, label: 'shutdown/reboot（关机/重启）' },
  { re: /\bsystemctl\s+(poweroff|reboot|halt)\b/i, label: 'systemctl poweroff/reboot（关机/重启）' },
  // Recursive / forced deletes.
  { re: /remove-item[^\n]*-recurse/i, label: 'Remove-Item -Recurse（递归删除）' },
  { re: /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf][a-z]*/i, label: 'rm -rf（递归强制删除）' },
  { re: /\b(rd|rmdir)\s+\/s/i, label: 'rd /s（递归删目录）' },
  { re: /\bdel\s+\/[a-z]*[fq]/i, label: 'del /f /q（强制静默删除）' },
  // Accounts, ownership, registry, policy.
  { re: /\bnet\s+user\b/i, label: 'net user（账户操作）' },
  { re: /\b(userdel|groupdel)\b/i, label: 'userdel/groupdel（删除账户）' },
  { re: /\btakeown\b/i, label: 'takeown（夺取文件所有权）' },
  { re: /\bchown\s+-R\b/i, label: 'chown -R（递归改属主）' },
  { re: /\bchmod\s+(-[a-z]+\s+)*777\b/i, label: 'chmod 777（全开放权限）' },
  { re: /\breg\s+delete\b/i, label: 'reg delete（删除注册表项）' },
  { re: /remove-item[^\n]*hk(lm|cu):/i, label: 'Remove-Item 删除注册表项' },
  { re: /\bset-executionpolicy\b/i, label: 'Set-ExecutionPolicy（改脚本执行策略）' },
  { re: /\bpowershell[^\n]*\s-(enc|encodedcommand)\b/i, label: 'powershell -EncodedCommand' }
]

/**
 * `$.` is not valid PowerShell anywhere, but it is exactly what `$_.` becomes
 * when ChatGPT's Markdown renderer eats the underscores as italic markers.
 *
 * The reply is rendered before we can ever read it, so the damage is done by the
 * time a command reaches us — we cannot repair it. What we can do is refuse to
 * pretend the command is intact, because the model would otherwise be told
 * "命令未找到 $.Name" and would have no idea the text itself was corrupted.
 */
const MARKDOWN_MANGLED_RE = /\$\.[A-Za-z_[]/

interface DangerHit {
  label: string
  /** The exact substring that tripped the rule, so a hit can be verified. */
  fragment: string
}

/**
 * Which danger rule, if any, this command trips — and on exactly which text.
 *
 * Reporting only the rule name leaves a hit impossible to check afterwards: the
 * user sees "命中危险规则「del /f /q」" on a command that visibly contains no
 * `del /f`, and neither side can tell whether the rule misfired or a different
 * command was involved. The fragment settles it.
 */
function findDanger(command: string): DangerHit | null {
  for (const entry of DANGEROUS_PATTERNS) {
    const match = entry.re.exec(command)
    if (match) return { label: entry.label, fragment: match[0] }
  }
  return null
}

/** Model output can be enormous; keep the context from being blown away. */
const OUTPUT_HEAD = 4000
const OUTPUT_TAIL = 2000
const MAX_TERMINAL_LINES = 400
const TERMINAL_PUSH_INTERVAL_MS = 150

export interface CommandRunnerDeps {
  store: ConversationStore
  /** Current conversation id, or null when the page is not on a conversation. */
  currentConversationId: () => string | null
  /** Push text into the composer and submit it without the system prompt. */
  sendRawToPage: (
    text: string
  ) => Promise<'ok' | 'busy' | 'stuck' | 'no-composer' | 'insert-failed'>
  /**
   * The backend the model's commands must run on right now.
   *
   * Non-null means an SSH session has taken over the terminal. It is re-read on
   * every use rather than captured, because the answer changes while the app runs
   * — and the prompt is rebuilt at the same moment, so execution and description
   * can never disagree about which machine is in charge.
   */
  remoteShell: () => ExecutionShell | null
  /** Mirror one line into the SSH transcript while the remote backend is in use. */
  onRemoteLine: (line: TerminalLine) => void
  /** Mirror streamed remote output the same way. */
  onRemoteOutput: (chunk: string) => void
  onExecutionChanged: (records: ExecutionRecord[]) => void
  onTerminalChanged: (state: TerminalState) => void
  /** Notify the host application when the model explicitly reports that the task is complete. */
  onTaskCompleted: (description: string) => void
}

function truncateOutput(text: string): string {
  if (text.length <= OUTPUT_HEAD + OUTPUT_TAIL) return text
  const omitted = text.length - OUTPUT_HEAD - OUTPUT_TAIL
  return `${text.slice(0, OUTPUT_HEAD)}\n\n... [中间省略 ${omitted} 个字符] ...\n\n${text.slice(-OUTPUT_TAIL)}`
}

/**
 * Windows tools report HRESULTs and Win32 errors as large negative numbers —
 * `-2147024816` is really `0x80070050` (ERROR_FILE_EXISTS). Show both, because
 * the hex form is the one you can actually search for.
 */
function formatExitCode(code: number | null): string {
  if (code === null) return '未知'
  if (code < 0) return `${code} (0x${(code >>> 0).toString(16).toUpperCase()})`
  return String(code)
}

/** Whole minutes read better than a six-digit second count once the window is wide. */
function humanDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60} 分钟`
  return `${seconds} 秒`
}

/**
 * Why a command was killed, in words.
 *
 * The two timeouts are not interchangeable: an idle kill means nothing came out,
 * the ceiling means it really was that long. Saying only "超时" teaches the model
 * nothing.
 *
 * The idle case names BOTH causes on purpose. From here they are the same thing —
 * silence — and naming only the interactive one is worse than saying nothing,
 * because the model reads this and rewrites its command. A real case: a
 * `Get-ChildItem -Recurse -File | Select-String … | Format-Table -AutoSize` over a
 * repo emits its FIRST line only after several minutes, so it is indistinguishable
 * from a hang. The model would have "fixed" a command that was working.
 */
function describeTimeout(kind: 'idle' | 'ceiling'): string {
  const idleWindow = humanDuration(IDLE_TIMEOUT_MS)
  const maxMinutes = Math.round(MAX_RUNTIME_MS / 60_000)

  if (kind === 'ceiling') {
    return `命令运行超过 ${maxMinutes} 分钟上限，已强制终止（任务太大，请拆成几步再做）`
  }

  return [
    `命令连续 ${idleWindow}没有任何输出，已判定为卡住并终止了会话（下一条命令会自动重开）。`,
    '两种可能，对照你写的命令判断：',
    '① 它在等交互输入 —— 标准输入是空的，read / Read-Host / 需要密码的提示都会这样；',
    '② 它在干活，只是输出被缓冲了 —— Format-Table（尤其 -AutoSize）/ Format-List /',
    '   Format-Wide / Sort-Object / Group-Object 都要收齐**全部**输入才吐第一行。',
    '如果是 ②：去掉末尾的 Format-*，或先缩小范围（排除 node_modules / .git / out），或拆小任务。'
  ].join('\n')
}

/** The one-line summary shown in the terminal after a run finishes. */
function summariseResult(result: ShellResult): TerminalLine {
  // `rejected` means it never ran at all — show the reason rather than a
  // meaningless "退出码 未知".
  if (result.rejected) return { kind: 'error', text: result.output.trim() || '命令未执行' }
  if (result.interrupted) return { kind: 'notice', text: '命令已中断' }
  if (result.sessionLost) {
    return {
      kind: 'error',
      text: '终端会话在执行中意外结束（命令可能调用了 exit 或让会话崩溃）——下一条命令会自动重开'
    }
  }
  if (result.timedOut) return { kind: 'error', text: describeTimeout(result.timedOut) }
  return { kind: 'notice', text: `退出码 ${formatExitCode(result.exitCode)}` }
}

/**
 * Plain-language outcome for the model.
 *
 * A bare `退出码: 0` (or worse, `退出码: 未知`) tells the model nothing about what
 * actually happened — when the shell used to die mid-command it received
 * "退出码: 未知 / (无输出)" and had no way to know anything had gone wrong. Say it
 * in words, and keep the code alongside for the cases where it matters.
 */
function describeOutcome(result: ShellResult): string {
  if (result.rejected) {
    return `未执行：${result.output.trim() || '终端当前不可用'}`
  }
  if (result.interrupted) {
    return '已中断'
  }
  if (result.sessionLost) {
    return '执行中终端会话意外结束（命令可能调用了 exit 或让会话崩溃），已自动重开会话'
  }
  if (result.timedOut) {
    return describeTimeout(result.timedOut)
  }
  if (result.exitCode === null) {
    return '已执行，但没有拿到退出码'
  }
  if (result.exitCode === 0) {
    return '成功'
  }
  // Windows reports HRESULTs and Win32 errors as large negative numbers; the low
  // 16 bits are the Win32 code, which `net helpmsg` can explain.
  if (result.exitCode < 0) {
    return `失败（Windows 错误码 ${formatExitCode(result.exitCode)}，可用 net helpmsg ${
      result.exitCode & 0xffff
    } 查询含义）`
  }
  return `失败（退出码 ${result.exitCode}）`
}

/**
 * The message handed back to the model after a command ran.
 *
 * The command is echoed back on purpose, so the transcript reads as a
 * self-contained log, and the working directory is included because it persists
 * between commands — without it a `cd` two steps back is invisible to the model.
 */
function buildResultMessage(command: string, result: ShellResult): string {
  const body = result.output.trim() === '' ? '(命令没有任何输出)' : truncateOutput(result.output)
  const header = [
    `命令: ${command}`,
    `目录: ${result.cwd}`,
    `结果: ${describeOutcome(result)}`
  ].join('\n')

  return `${header}\n\n${body}`
}

/** Single-quote a string for a POSIX shell; an embedded quote is closed and reopened. */
function posixQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export class CommandRunner {
  /**
   * The one local PowerShell session.
   *
   * There is exactly ONE, for the whole app — never one per conversation. The
   * terminal is a window onto a machine, and the machine does not change when you
   * click a different chat. Per-conversation shells made sending the first
   * message of a new chat wipe the screen, and start the model in the home
   * directory while the prompt still claimed the directory the user had chosen.
   *
   * Deliberately holds only the LOCAL shell: the remote backend belongs to the
   * SSH manager, which owns its lifetime, and keeping it here would let this
   * class dispose a session the user is still looking at.
   */
  private localShell: ConversationShell | null = null
  private lines: TerminalLine[] = []
  private pushTimer: NodeJS.Timeout | null = null
  /** Message ids currently executing, so a double click cannot run one twice. */
  private readonly inFlight = new Set<string>()
  /** The exact backend whose run() promise is currently in flight. */
  private activeShell: ExecutionShell | null = null
  /** Distinguishes consecutive runs that reuse the same persistent shell object. */
  private activeRunId = 0
  /** Monotonic request id: if several commands arrive together, only the newest starts. */
  private executionRequest = 0

  private automation: AutomationState = {
    // Manual by default: nothing runs on its own until the user asks for it.
    mode: 'manual',
    paused: false
  }

  constructor(private readonly deps: CommandRunnerDeps) {}

  /* ---------------- automation state ---------------- */

  getAutomation(): AutomationState {
    return { ...this.automation }
  }

  setMode(mode: ExecutionMode): AutomationState {
    const previous = this.automation.mode
    this.automation = { ...this.automation, mode }

    // Switching to auto is an explicit "go" signal, so pick up whatever is
    // already waiting instead of making the user click 运行 as well.
    if (mode === 'auto' && previous !== 'auto' && !this.automation.paused) {
      this.resumeNewestPending()
    }
    return this.getAutomation()
  }

  /**
   * Set the mode at startup WITHOUT the resume side effect.
   *
   * Restoring a saved "auto" must not execute a backlog left over from the last
   * session — the user has not asked for anything yet in this one.
   */
  restoreMode(mode: ExecutionMode): AutomationState {
    this.automation = { ...this.automation, mode }
    return this.getAutomation()
  }

  setPaused(paused: boolean): AutomationState {
    this.automation = { ...this.automation, paused }
    // Resuming should pick the loop back up. Otherwise a command that arrived
    // while paused would sit there forever with nothing driving it.
    if (!paused && this.automation.mode === 'auto') this.resumeNewestPending()
    return this.getAutomation()
  }

  /**
   * The page saw a command it could not parse.
   *
   * Always shown: a command that vanishes without a trace is indistinguishable
   * from a broken app, and that is precisely how the unescaped-quote bug
   * presented itself — the terminal simply stayed empty.
   */
  noteParseFailure(text: string): void {
    const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 160)
    this.appendLine({
      kind: 'error',
      text: `模型回复里有命令，但 JSON 无法解析（多半是引号没转义），已跳过：${snippet}`
    })
  }

  /**
   * Pick up the newest waiting command. Danger-list commands are excluded: those
   * always need a deliberate click.
   */
  private resumeNewestPending(): void {
    const conversationId = this.deps.currentConversationId()
    if (!conversationId) return

    const newest = this.deps.store
      .listExecutions(conversationId)
      .filter((record) => record.status === 'pending')
      .pop()

    if (newest) {
      this.appendLine({ kind: 'notice', text: '已恢复：继续执行最新一条待处理命令' })
      void this.execute(newest.messageId)
    }
  }

  /* ---------------- commands from the page ---------------- */

  /**
   * A command was lifted out of an assistant reply.
   *
   * It is ALWAYS stored, so the user can see it and run it by hand. Whether it
   * runs by itself depends on the mode and on `live` (see the notice below).
   */
  handleDetected(parsed: ParsedCommand): void {
    const conversationId = this.deps.currentConversationId()
    if (!conversationId) return

    const danger = findDanger(parsed.command)
    const created = this.deps.store.createExecution({
      messageId: parsed.messageId,
      conversationId,
      command: parsed.command,
      description: parsed.description,
      status: danger ? 'blocked' : 'pending',
      createdAt: Date.now()
    })

    // Already known: this is the idempotency guard, and it is what makes a page
    // reload (which re-renders every old message) harmless.
    if (!created) return

    // An empty command means the model considers the task finished. Check it
    // before the generic notice so the log does not say "检测到命令" and then
    // immediately "任务完成".
    if (parsed.command.trim() === '') {
      this.deps.store.setExecutionStatus(parsed.messageId, 'skipped')
      this.appendLine({ kind: 'notice', text: '模型报告任务完成（command 为空）' })
      this.broadcastExecutions(conversationId)
      this.deps.onTaskCompleted(parsed.description)
      return
    }

    const autoRun = this.automation.mode === 'auto' && !this.automation.paused

    if (MARKDOWN_MANGLED_RE.test(parsed.command)) {
      this.appendLine({
        kind: 'error',
        text:
          '⚠ 命令里的 $_ 疑似被 ChatGPT 的 Markdown 渲染当成斜体吃掉了（$_ 变成了 $），' +
          '这条命令很可能已被改坏。模型下次应当用 ```json 代码块包裹 JSON。'
      })
    }

    this.appendLine({
      kind: danger ? 'error' : 'notice',
      text: danger
        ? // The matched FRAGMENT matters: reporting only the rule name makes a hit
          // impossible to verify afterwards, which is exactly how "the danger list
          // blocked my harmless command" became an unfalsifiable claim.
          `命中危险规则「${danger.label}」（命令中的匹配片段: ${danger.fragment}）${
            autoRun ? '——自动模式，仍会执行' : '——需要手动确认'
          }`
        : parsed.live
          ? '检测到命令'
          : autoRun
            ? '检测到历史命令——自动模式，仍会执行'
            : '检测到历史命令（不会自动执行，需要的话点「运行」）'
    })
    this.broadcastExecutions(conversationId)

    /*
     * Auto mode has NO gates left: it runs whatever the model asks for.
     *
     * `live` and the danger list are still recorded and still shown, but they no
     * longer stop anything. The reasoning is the user's, and it is sound: a
     * command that runs and fails produces output that goes straight back to the
     * model, which then corrects itself. Blocking execution produces nothing to
     * correct — it just stalls the loop.
     *
     * The consequence, stated plainly: opening an old conversation in auto mode
     * will immediately run whatever command sits in its last reply. Manual mode
     * and 暂停 are the remaining brakes.
     */
    if (autoRun) {
      void this.execute(parsed.messageId)
    }
  }

  /** Run a stored command that is still waiting (pending or blocked). */
  async runExecution(messageId: string): Promise<void> {
    const record = this.deps.store.getExecution(messageId)
    if (!record) return
    if (record.status !== 'pending' && record.status !== 'blocked') return
    await this.execute(messageId)
  }

  skipExecution(messageId: string): void {
    const record = this.deps.store.getExecution(messageId)
    if (!record) return
    if (record.status !== 'pending' && record.status !== 'blocked') return
    this.deps.store.setExecutionStatus(messageId, 'skipped')
    this.appendLine({ kind: 'notice', text: '已跳过该命令' })
    this.broadcastExecutions(record.conversationId)
  }

  /**
   * Run one stored command and, when it finishes, hand the output back to the
   * model. Serialised per conversation by the shell itself.
   */
  private async execute(messageId: string): Promise<void> {
    // Two fast clicks on 运行 would otherwise both pass the status check below
    // and run the command twice.
    if (this.inFlight.has(messageId)) return

    const record = this.deps.store.getExecution(messageId)
    if (!record) return
    if (record.status !== 'pending' && record.status !== 'blocked') return

    const request = (this.executionRequest += 1)
    this.inFlight.add(messageId)

    try {
      await this.runRecord(record, request)
    } finally {
      this.inFlight.delete(messageId)
    }
  }

  private async runRecord(record: ExecutionRecord, request: number): Promise<void> {
    const conversationId = record.conversationId
    const messageId = record.messageId
    const shell = await this.prepareExecutionShell()
    if (!shell) return
    if (request !== this.executionRequest) {
      this.deps.store.setExecutionStatus(messageId, 'skipped')
      this.broadcastExecutions(conversationId)
      return
    }

    this.deps.store.setExecutionStatus(messageId, 'running')
    this.appendLine({ kind: 'command', text: record.command })
    this.broadcastExecutions(conversationId)

    const result = await this.runOnShell(shell, record.command)

    this.deps.store.finishExecution(messageId, {
      status: result.rejected
        ? 'skipped'
        : result.interrupted
          ? 'interrupted'
          : result.timedOut
          ? 'timeout'
          : result.exitCode === 0 && !result.sessionLost
            ? 'done'
            : 'failed',
      exitCode: result.exitCode,
      output: result.output,
      finishedAt: Date.now()
    })

    this.appendLine(summariseResult(result))
    this.flushTerminal()
    this.broadcastExecutions(conversationId)

    // A command that never ran has no result to hand back.
    if (result.rejected || result.interrupted) return

    // Hand the output back whenever the loop is not explicitly stopped.
    //
    // Deliberately independent of the execution mode: the mode only decides
    // whether the NEXT command runs by itself. A manual 运行 click obviously
    // wants the answer handed back too, so manual mode behaves as a
    // step-through — the next command arrives, is stored as pending, and waits
    // for a click instead of running on its own.
    if (this.automation.paused) return

    const message = buildResultMessage(record.command, result)
    const outcome = await this.deps.sendRawToPage(message)
    if (outcome === 'ok') {
      this.appendLine({ kind: 'notice', text: '已把执行结果发回给模型' })
    } else if (outcome === 'busy') {
      this.appendLine({
        kind: 'error',
        text: '输入框里有内容，结果未回传（避免覆盖你正在输入的文字）——清空输入框后可在待处理条里重试'
      })
    } else if (outcome === 'stuck') {
      this.appendLine({
        kind: 'error',
        text: '结果已写入输入框但没能提交（ChatGPT 可能正在生成回复）——输入框里还留着内容，等它答完手动点发送即可'
      })
    } else {
      this.appendLine({ kind: 'error', text: `结果回传失败：${outcome}` })
    }
    this.flushTerminal()
  }

  /* ---------------- terminal ---------------- */

  getTerminalState(): TerminalState {
    return {
      alive: this.localShell?.alive ?? false,
      cwd: this.localShell?.cwd ?? '',
      lines: [...this.lines]
    }
  }

  /**
   * Ask the machine in charge what it is, in a terminal the user can watch.
   *
   * Runs through whichever shell is current on purpose: the request was for the
   * app to open a terminal and use it, so the command and its output are meant to
   * be visible — not hidden in a private throwaway process. It also means the
   * probe follows the backend, so attaching an SSH session reports the remote
   * host and detaching reports the local one, with no second code path.
   *
   * The kind comes back with the result rather than being read separately: the
   * backend can change underneath, and pairing a remote probe's output with the
   * local parser would produce a confident description of the wrong machine.
   */
  async runEnvironmentProbe(): Promise<{ kind: EnvironmentKind; result: ShellResult }> {
    const shell = this.ensureShell()
    this.appendLine({
      kind: 'notice',
      text: shell.kind === 'posix' ? '探测远端主机环境' : '探测本机环境'
    })
    this.appendLine({ kind: 'command', text: shell.probeCommand })
    const result = await this.runOnShell(shell, shell.probeCommand)
    this.appendLine(summariseResult(result))
    this.flushTerminal()
    return { kind: shell.kind, result }
  }

  /**
   * Move the terminal to another directory.
   *
   * The caller re-probes afterwards: the working directory is part of the
   * environment the model is told about, so moving the terminal makes the
   * previously sent prompt wrong.
   */
  async setTerminalCwd(path: string): Promise<TerminalState> {
    const target = path.trim()
    if (target === '') return this.getTerminalState()

    const shell = this.ensureShell()
    // Two dialects, two ways of saying the same thing. Guessing here would send
    // `Set-Location` to a Linux box and `cd` to PowerShell.
    const command =
      shell.kind === 'posix'
        ? `cd ${posixQuote(target)}`
        : `Set-Location -LiteralPath '${target.replace(/'/g, "''")}'`

    this.appendLine({ kind: 'command', text: command })

    const result = await this.runOnShell(shell, command)
    this.appendLine(
      result.exitCode === 0 && !result.rejected && !result.sessionLost
        ? { kind: 'notice', text: `目录已切换到 ${shell.cwd || target}` }
        : summariseResult(result)
    )
    this.flushTerminal()
    return this.getTerminalState()
  }

  /**
   * Type a command straight into the terminal, bypassing the model.
   *
   * Needs no conversation: the terminal belongs to the machine, so it is usable
   * (and useful) before a single chat has been opened.
   */
  async sendTerminalInput(text: string): Promise<void> {
    const command = text.trim()
    if (command === '') return

    const shell = this.ensureShell()
    this.appendLine({ kind: 'command', text: command })
    const result = await this.runOnShell(shell, command)
    this.appendLine(summariseResult(result))
    this.flushTerminal()
  }

  /** Stop the current command without clearing the transcript. */
  async interruptTerminal(): Promise<void> {
    const shell = this.activeShell
    if (!shell || !shell.running) {
      this.appendLine({ kind: 'notice', text: '当前没有正在执行的命令' })
      this.flushTerminal()
      return
    }

    await shell.interrupt()
  }


  resetTerminal(): void {
    // dispose(), not kill(): dropping the reference without tearing the shell
    // down would leave a running command orphaned. Dropping it first also stops
    // the dying session's onExit from posting "会话已结束" over the reset notice.
    const shell = this.localShell
    this.localShell = null
    shell?.dispose()

    this.lines = []
    this.appendLine({ kind: 'notice', text: '终端已重置' })
    this.flushTerminal()
  }

  disposeAll(): void {
    const shell = this.localShell
    this.localShell = null
    shell?.dispose()

    this.inFlight.clear()
    this.lines = []
    if (this.pushTimer) {
      clearTimeout(this.pushTimer)
      this.pushTimer = null
    }
  }

  /* ---------------- internals ---------------- */

  /** Track the backend currently executing so it can be interrupted immediately. */
  private async runOnShell(shell: ExecutionShell, command: string): Promise<ShellResult> {
    // Never let a second helper call overwrite the identity of the command that
    // is actually in flight; that would make the 中断 button lose its target.
    if (this.activeShell) {
      return {
        output: '终端正忙，忽略了这条命令。',
        exitCode: null,
        timedOut: false,
        interrupted: false,
        rejected: true,
        sessionLost: false,
        cwd: shell.cwd
      }
    }

    const runId = (this.activeRunId += 1)
    this.activeShell = shell
    try {
      return await shell.run(command)
    } finally {
      // A local PowerShell restart reuses the same ConversationShell object.
      // Compare the run id as well, otherwise the old interrupted run can clear
      // activeShell after its replacement has already started on that same object.
      if (this.activeRunId === runId) this.activeShell = null
    }
  }

  /** Give a newly requested stored command priority over the command in flight. */
  private async prepareExecutionShell(): Promise<ExecutionShell | null> {
    const active = this.activeShell
    if (!active || !active.running) {
      const remote = this.deps.remoteShell()
      // During a deliberate SSH interrupt main deliberately keeps the old, now
      // closed backend reference until SshManager has opened its replacement.
      // Wait here rather than treating that short gap as permission to run local.
      if (remote && !remote.alive) return this.waitForRemoteReplacement(remote)
      return this.ensureShell()
    }

    const wasRemote = active.kind === 'posix'
    const interrupted = await active.interrupt()
    if (!interrupted) return this.ensureShell()
    // interrupt() waits for the backend to close; it is safe to release the old
    // identity now even if its awaiting caller has not reached finally yet.
    if (this.activeShell === active) this.activeShell = null

    this.appendLine({ kind: 'notice', text: '检测到新指令，已中断当前命令' })
    this.flushTerminal()

    if (!wasRemote) return this.ensureShell()

    // Interrupting an SSH command closes only its exec channel. SshManager
    // immediately reopens that channel; wait for it so the replacement command
    // can never fall through to the local PowerShell shell by accident.
    return this.waitForRemoteReplacement(active)
  }

  private async waitForRemoteReplacement(previous: ExecutionShell): Promise<ExecutionShell | null> {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const next = this.deps.remoteShell()
      if (next && next !== previous && next.alive && !next.running) return next
      await new Promise<void>((resolve) => setTimeout(resolve, 50))
    }

    this.appendLine({
      kind: 'error',
      text: '远端命令会话中断后没有及时重建，新指令保持待执行，避免误跑到本机。'
    })
    this.flushTerminal()
    return null
  }

  private ensureShell(): ExecutionShell {
    /*
     * The machine decides, not the chat.
     *
     * An attached SSH session takes over every conversation's commands, and the
     * local terminal serves every conversation too — for the same reason. The
     * model is told which machine it is driving, and which ChatGPT tab the
     * instruction came from has nothing to do with where it should run.
     */
    const remote = this.deps.remoteShell()
    if (remote) return remote

    if (!this.localShell) {
      // Captured so the exit handler can tell "my session died" from "the user
      // reset the terminal and this is the old session reporting in".
      const created = new ConversationShell({
        onOutput: (chunk) => this.appendOutput(chunk),
        onExit: () => {
          if (this.localShell !== created) return
          this.appendLine({
            kind: 'notice',
            text: 'PowerShell 会话已结束，下一条命令会自动重开'
          })
        }
      })
      this.localShell = created
    }

    return this.localShell
  }

  private appendLine(line: TerminalLine): void {
    this.lines.push(line)
    if (this.lines.length > MAX_TERMINAL_LINES) {
      this.lines.splice(0, this.lines.length - MAX_TERMINAL_LINES)
    }
    this.mirror(line)
    this.flushTerminal()
  }

  /**
   * Copy a line into the SSH transcript.
   *
   * While an SSH session is attached the pane renders the SSH transcript, not this
   * one — so without the mirror the model's commands and their output would be
   * invisible exactly when the user most needs to watch them. It is gated on the
   * backend rather than on a flag so it cannot get out of step with where the
   * commands actually ran.
   */
  private mirror(line: TerminalLine): void {
    if (this.deps.remoteShell() === null) return
    this.deps.onRemoteLine(line)
  }

  /** Streaming output lands in the trailing output line instead of a new one. */
  private appendOutput(chunk: string): void {
    const text = chunk.replace(/\r/g, '')
    if (text === '') return
    const last = this.lines[this.lines.length - 1]
    if (last && last.kind === 'output') last.text += text
    else this.lines.push({ kind: 'output', text })
    if (this.lines.length > MAX_TERMINAL_LINES) {
      this.lines.splice(0, this.lines.length - MAX_TERMINAL_LINES)
    }
    if (this.deps.remoteShell() !== null) this.deps.onRemoteOutput(text)
    this.scheduleTerminalPush()
  }

  /** Coalesce the high-frequency streaming updates into one push per tick. */
  private scheduleTerminalPush(): void {
    if (this.pushTimer) return
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null
      this.deps.onTerminalChanged(this.getTerminalState())
    }, TERMINAL_PUSH_INTERVAL_MS)
  }

  /** Drop a pending coalesced push so the change goes out now. */
  private flushTerminal(): void {
    if (this.pushTimer) {
      clearTimeout(this.pushTimer)
      this.pushTimer = null
    }
    this.deps.onTerminalChanged(this.getTerminalState())
  }

  private broadcastExecutions(conversationId: string): void {
    this.deps.onExecutionChanged(this.deps.store.listExecutions(conversationId))
  }
}
