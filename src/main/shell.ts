import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { DETECT_COMMAND } from './environment'
import type { EnvironmentKind } from '../shared/types'

/**
 * Which PowerShell to run.
 *
 * PowerShell 7 (`pwsh`) is preferred — it is UTF-8 by default and supports `&&` —
 * but it is not installed by default on Windows, so the built-in 5.1 is the
 * fallback. The prompt deliberately teaches 5.1-compatible syntax, which is a
 * subset of 7's, so either one understands what the model writes.
 */
let cachedExe: string | null = null

export function resolvePowerShell(): string {
  if (cachedExe) return cachedExe

  for (const candidate of ['pwsh.exe', 'powershell.exe']) {
    try {
      const probe = spawnSync('where.exe', [candidate], { windowsHide: true, encoding: 'utf8' })
      if (probe.status === 0 && (probe.stdout ?? '').trim() !== '') {
        cachedExe = candidate
        return candidate
      }
    } catch {
      /* try the next candidate */
    }
  }

  cachedExe = 'powershell.exe'
  return cachedExe
}

/** Split off a trailing incomplete UTF-8 sequence (pipe reads cut mid-character). */
function splitIncompleteUtf8(buf: Buffer): [Buffer, Buffer] {
  for (let back = 1; back <= 3 && back <= buf.length; back += 1) {
    const byte = buf[buf.length - back]
    if ((byte & 0x80) === 0) break
    if ((byte & 0xc0) === 0x80) continue
    const needed = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : 2
    if (back < needed) {
      return [buf.subarray(0, buf.length - back), buf.subarray(buf.length - back)]
    }
    break
  }
  return [buf, Buffer.alloc(0)]
}

/**
 * True when a chunk looks like UTF-16LE.
 *
 * `wmic` was the classic offender (it emits UTF-16LE when redirected), and plenty
 * of other Windows tooling still does. Decoding that as UTF-8 or GBK yields
 * NUL-laden garbage.
 */
function looksLikeUtf16Le(buf: Buffer): boolean {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return true
  if (buf.length < 8) return false

  let nuls = 0
  const pairs = Math.floor(buf.length / 2)
  for (let i = 1; i < pairs * 2; i += 2) {
    if (buf[i] === 0) nuls += 1
  }
  return nuls / pairs > 0.7
}

/**
 * Normalise one pipe chunk to UTF-8 text — the single encoding used everywhere
 * inside the app (UI, database, messages back to the model).
 *
 * The wrapper forces its OWN output to UTF-8, but any external program it calls
 * still writes the ANSI code page to a PIPE, and `chcp` cannot reach that. So all
 * three encodings that actually occur are handled, in an order where a false match
 * is impossible: strictly valid UTF-8 is taken as UTF-8, everything else is GBK.
 */
function createDecoder(): (chunk: Buffer) => string {
  const utf8Strict = new TextDecoder('utf-8', { fatal: true })
  const utf8 = new TextDecoder('utf-8')
  const gbk = new TextDecoder('gbk')
  const utf16 = new TextDecoder('utf-16le')
  let pending: Buffer = Buffer.alloc(0)

  return (chunk: Buffer): string => {
    const data = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk

    if (looksLikeUtf16Le(data)) {
      const usable = data.length - (data.length % 2)
      pending = data.subarray(usable)
      return usable === 0 ? '' : utf16.decode(data.subarray(0, usable))
    }

    const [complete, tail] = splitIncompleteUtf8(data)
    pending = tail
    if (complete.length === 0) return ''

    try {
      utf8Strict.decode(complete)
      return utf8.decode(complete)
    } catch {
      return gbk.decode(complete)
    }
  }
}

export interface ShellResult {
  output: string
  exitCode: number | null
  /**
   * Why the command was killed, or `false` when it finished on its own.
   *
   * Two distinct reasons, because they need different explanations to the model:
   * an idle kill means the command was waiting for something that never came
   * (almost always standard input), while the ceiling means it was genuinely
   * long-running.
   */
  timedOut: false | 'idle' | 'ceiling'
  /** True when the user or a newer command deliberately stopped this run. */
  interrupted: boolean
  /** True when the command never ran at all (busy, spawn failure). */
  rejected: boolean
  /**
   * True when the session died mid-command — `exit`, a crash, or a cmdlet that
   * took the host down. Distinct from a timeout so the message can say so.
   */
  sessionLost: boolean
  /** Working directory after the command ran; it persists between commands. */
  cwd: string
}

/**
 * Kill a command that has produced NO output for this long.
 *
 * Six minutes rather than two, because silence does not actually mean stuck — it
 * only means nothing has been flushed. A pipeline whose last stage needs all of
 * its input before emitting anything (`Format-Table -AutoSize`, `Sort-Object`,
 * `Group-Object`, `Measure-Object`) is silent **by construction**, and there is no
 * way to un-buffer it from outside: `$PSDefaultParameterValues` does not override
 * an explicitly passed `-AutoSize`, and the buffering happens inside the user's
 * own pipeline where the wrapper cannot reach it.
 *
 * The case that set this number: `Get-ChildItem -Recurse -File | Select-String … |
 * Format-Table -AutoSize` over this repo takes ~115s standalone and more than
 * 120s through the wrapper, and emits its first byte only at the very end. Two
 * minutes killed it with zero output captured.
 *
 * Raising the number does not make a stuck command safe — it just costs more time
 * before the loop recovers. 重置 kills the session (and the whole process tree)
 * immediately, and that remains the way to stop something you know is stuck.
 */
export const IDLE_TIMEOUT_MS = 6 * 60_000

/** Absolute ceiling, so a command that streams forever still ends eventually. */
export const MAX_RUNTIME_MS = 30 * 60_000

/** How long to wait for a freshly spawned session to announce itself. */
const READY_TIMEOUT_MS = 20_000

/**
 * What the command runner needs from an execution backend.
 *
 * There are two — a local PowerShell session and a shell on the far side of an
 * SSH connection — and the runner must not care which one it holds, because which
 * one is correct changes while the app is running.
 */
export interface ExecutionShell {
  /** Which dialect this backend speaks. Decides both the prompt and the cwd command. */
  readonly kind: EnvironmentKind
  /**
   * Ask this backend what machine it is.
   *
   * It lives on the backend rather than beside the runner because the two
   * dialects need genuinely different probes, and pairing a probe with the wrong
   * shell produces a silent fallback to placeholder values.
   */
  readonly probeCommand: string
  /** True when the session can accept commands. */
  readonly alive: boolean
  /** True while a command is in flight; used to avoid reaping an active shell. */
  readonly running: boolean
  /** Working directory after the last command; it persists between commands. */
  readonly cwd: string
  run(command: string, timeoutMs?: number): Promise<ShellResult>
  /** Stop the command currently in flight. Returns false when there was nothing to stop. */
  interrupt(): Promise<boolean>
  dispose(): void
}

interface PendingRun {
  seq: number
  output: string
  resolve: (result: ShellResult) => void
  idleTimer: NodeJS.Timeout
  ceilingTimer: NodeJS.Timeout
  timedOut: false | 'idle' | 'ceiling'
  interrupted: boolean
}

export interface ConversationShellOptions {
  /** Working directory restored across app restarts; invalid paths fall back to the home directory. */
  initialCwd?: string
  /** Called with decoded output as it arrives, for live display. */
  onOutput?: (chunk: string) => void
  /** Called when the session process goes away unexpectedly. */
  onExit?: () => void
}

/**
 * One long-lived PowerShell session per conversation.
 *
 * The session is a wrapper script that loops reading commands from stdin. That
 * gives the model what a real terminal gives it — variables, functions, imported
 * modules, `pushd`, and the working directory all survive between commands.
 *
 * Commands are sent as **one base64 line each**, which is what makes the whole
 * design safe rather than clever:
 *
 *   - Only ASCII travels through the pipe, so no code page is involved. The
 *     earlier cmd backend fed raw command text through a stdin pipe, and because
 *     `chcp 65001` does not reliably apply to piped input, ANY command containing
 *     a non-ASCII character made cmd.exe terminate outright.
 *   - No quoting rules. PowerShell's command-line parser mangles embedded quotes,
 *     and base64 sidesteps it entirely.
 *
 * Framing is a session token plus a **monotonic sequence number**, not just a
 * sentinel string: a command that goes wrong can emit arbitrary text, and a bare
 * sentinel would be indistinguishable from something a command printed. A line
 * carrying the wrong sequence number is treated as output.
 *
 * The one hazard a persistent session reintroduces is a command that reads
 * standard input — the protocol lives there. Two mitigations: stdin is swapped for
 * an empty reader while the command runs, and `-NonInteractive` makes `Read-Host`
 * fail instead of prompting. A native tool that reads the raw handle can still
 * steal a line; when that happens the command never reports back, the idle timer
 * fires, and the session is killed and restarted automatically.
 */
export class ConversationShell implements ExecutionShell {
  private child: ChildProcess | null = null
  private starting: Promise<boolean> | null = null
  private disposed = false
  private currentCwd = homedir()

  private sessionToken = ''
  private seq = 0
  private lineBuffer = ''
  private decode = createDecoder()
  private pending: PendingRun | null = null
  private readyResolve: ((ok: boolean) => void) | null = null

  readonly kind: EnvironmentKind = 'windows'
  readonly probeCommand: string = DETECT_COMMAND

  constructor(private readonly options: ConversationShellOptions = {}) {
    const initialCwd = options.initialCwd?.trim() ?? ''
    if (initialCwd !== '' && existsSync(initialCwd)) this.currentCwd = initialCwd
  }

  get cwd(): string {
    return this.currentCwd
  }

  /** True when a session is alive and accepting commands. */
  get alive(): boolean {
    return this.child !== null && this.child.exitCode === null
  }

  /** True while a command is in flight; used to avoid reaping an active shell. */
  get running(): boolean {
    return this.pending !== null
  }

  async run(command: string, timeoutMs?: number): Promise<ShellResult> {
    if (this.disposed) {
      return this.reject('终端已关闭，请重置后重试。')
    }
    if (this.pending) {
      return this.reject('终端正忙，忽略了这条命令。')
    }

    const cleaned = command.replace(/[\r\n]+$/, '')
    if (cleaned.trim() === '') {
      return { output: '', exitCode: 0, timedOut: false, interrupted: false, rejected: false, sessionLost: false, cwd: this.currentCwd }
    }

    const ready = await this.ensureSession()
    if (!ready) return this.reject('无法启动 PowerShell 会话。')

    const child = this.child
    if (!child || child.exitCode !== null || !child.stdin) {
      return this.reject('PowerShell 会话不可用。')
    }

    // Captured here: TypeScript cannot keep the null-check narrowing inside the
    // promise callback below.
    const stdin = child.stdin

    return new Promise<ShellResult>((resolve) => {
      const seq = (this.seq += 1)

      const idleTimer = setTimeout(() => {
        if (this.pending) this.pending.timedOut = 'idle'
        this.killChild(child)
      }, IDLE_TIMEOUT_MS)

      const ceilingMs = Number.isFinite(timeoutMs)
        ? Math.min(Math.max(Math.floor(Number(timeoutMs)), 1000), MAX_RUNTIME_MS)
        : MAX_RUNTIME_MS
      const ceilingTimer = setTimeout(() => {
        if (this.pending) this.pending.timedOut = 'ceiling'
        this.killChild(child)
      }, ceilingMs)

      // Set before writing: the reply can arrive before write() returns.
      this.pending = { seq, output: '', resolve, idleTimer, ceilingTimer, timedOut: false, interrupted: false }

      try {
        stdin.write(`${Buffer.from(cleaned, 'utf16le').toString('base64')}\n`)
      } catch {
        this.clearPending()
        resolve(this.reject('写入终端失败。'))
      }
    })
  }

  async interrupt(): Promise<boolean> {
    const child = this.child
    if (!child || !this.pending) return false

    // Mark before killing so handleExit can distinguish a deliberate interrupt
    // from an unexpected session loss and settle run() with the right status.
    this.pending.interrupted = true

    const closed = new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        resolve()
      }
      child.once('close', finish)
      child.once('error', finish)
    })

    this.killChild(child)
    await closed
    return true
  }

  dispose(): void {
    this.disposed = true
    if (this.child) this.killChild(this.child)
    this.child = null
    // Settled, not dropped. `run()`'s caller is awaiting this promise, so a
    // pending command left unresolved would park the whole automation loop with
    // the execution stuck at `running` and nothing on screen to explain it.
    this.abandonPending('终端已关闭，这条命令没有拿到结果。')
    this.clearPending()
    this.readyResolve?.(false)
    this.readyResolve = null
  }

  /* ---------------------------------------------------------------- */

  private reject(message: string): ShellResult {
    return {
      output: message,
      exitCode: null,
      timedOut: false,
      interrupted: false,
      rejected: true,
      sessionLost: false,
      cwd: this.currentCwd
    }
  }

  /** Give up on the in-flight command and tell whoever is waiting. */
  private abandonPending(reason: string): void {
    const pending = this.pending
    if (!pending) return
    this.clearPending()

    const partial = pending.output.trimEnd()
    pending.resolve({
      output: partial === '' ? reason : `${partial}\n${reason}`,
      exitCode: null,
      timedOut: false,
      interrupted: false,
      rejected: false,
      sessionLost: true,
      cwd: this.currentCwd
    })
  }

  private clearPending(): void {
    if (!this.pending) return
    clearTimeout(this.pending.idleTimer)
    clearTimeout(this.pending.ceilingTimer)
    this.pending = null
  }

  private async ensureSession(): Promise<boolean> {
    if (this.alive) return true
    if (this.starting) return this.starting

    this.starting = this.startSession()
    try {
      return await this.starting
    } finally {
      this.starting = null
    }
  }

  private startSession(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.sessionToken = randomUUID().replace(/-/g, '').slice(0, 10)
      this.seq = 0
      this.lineBuffer = ''
      this.decode = createDecoder()

      const encoded = Buffer.from(buildWrapper(this.sessionToken), 'utf16le').toString('base64')

      let child: ChildProcess
      try {
        child = spawn(
          resolvePowerShell(),
          [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-EncodedCommand',
            encoded
          ],
          {
            // Start where the previous session left off, so a restart does not
            // silently move the model to a different directory.
            cwd: this.currentCwd,
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {
              ...process.env,
              // External programs are a different story from PowerShell itself:
              // this is the only lever that makes common runtimes emit UTF-8
              // rather than the ANSI code page.
              PYTHONUTF8: '1',
              PYTHONIOENCODING: 'utf-8'
            }
          }
        )
      } catch {
        resolve(false)
        return
      }

      this.child = child

      const readyTimer = setTimeout(() => {
        this.readyResolve = null
        this.killChild(child)
        resolve(false)
      }, READY_TIMEOUT_MS)

      this.readyResolve = (ok: boolean): void => {
        clearTimeout(readyTimer)
        this.readyResolve = null
        resolve(ok)
      }

      child.stdout?.on('data', (chunk: Buffer) => this.handleData(chunk))
      child.stderr?.on('data', (chunk: Buffer) => this.handleData(chunk))
      child.on('error', () => this.handleExit())
      child.on('close', () => this.handleExit())
    })
  }

  private handleExit(): void {
    const wasAlive = this.child !== null
    this.child = null

    this.readyResolve?.(false)
    this.readyResolve = null

    /*
     * A session killed by OUR OWN timeout is not news.
     *
     * The timeout message already says the session was terminated and that the
     * next command reopens it. Announcing "PowerShell 会话已结束" first makes a
     * deliberate kill read like a crash, and it lands in the terminal above the
     * explanation that would have made sense of it.
     */
    let deliberate = false

    if (this.pending) {
      const pending = this.pending
      deliberate = pending.timedOut !== false || pending.interrupted
      this.clearPending()
      pending.resolve({
        output: pending.output.trimEnd(),
        exitCode: null,
        timedOut: pending.timedOut,
        interrupted: pending.interrupted,
        rejected: false,
        sessionLost: pending.timedOut === false && !pending.interrupted,
        cwd: this.currentCwd
      })
    }

    if (wasAlive && !deliberate) this.options.onExit?.()
  }

  private handleData(chunk: Buffer): void {
    this.lineBuffer += this.decode(chunk)

    let newline = this.lineBuffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.lineBuffer.slice(0, newline).replace(/\r$/, '')
      this.lineBuffer = this.lineBuffer.slice(newline + 1)
      this.handleLine(line)
      newline = this.lineBuffer.indexOf('\n')
    }
  }

  /**
   * One complete line from the session.
   *
   * Line-oriented on purpose: both the ready marker and the completion marker are
   * whole lines, and a partially received marker must never be mistaken for one.
   */
  private handleLine(line: string): void {
    const readyMarker = `__CT_READY_${this.sessionToken}__`
    if (line === readyMarker) {
      this.readyResolve?.(true)
      return
    }

    const donePrefix = `__CT_DONE_${this.sessionToken}_`
    if (line.startsWith(donePrefix)) {
      const match = /^(\d+)__\s+(-?\d+)\s*(.*)$/.exec(line.slice(donePrefix.length))
      // A sequence number we are not waiting for is not our completion marker —
      // treat it as ordinary output rather than ending the wrong command.
      if (match && this.pending !== null && Number(match[1]) === this.pending.seq) {
        const pending = this.pending
        this.clearPending()
        const cwd = match[3].trim()
        if (cwd !== '') this.currentCwd = cwd
        pending.resolve({
          output: pending.output.trimEnd(),
          exitCode: Number(match[2]),
          timedOut: false,
          interrupted: false,
          rejected: false,
          sessionLost: false,
          cwd: this.currentCwd
        })
        return
      }
    }

    if (this.pending) {
      // Any output at all counts as progress.
      clearTimeout(this.pending.idleTimer)
      this.pending.idleTimer = setTimeout(() => {
        if (this.pending) this.pending.timedOut = 'idle'
        if (this.child) this.killChild(this.child)
      }, IDLE_TIMEOUT_MS)

      this.pending.output += `${line}\n`
    }

    this.options.onOutput?.(`${line}\n`)
  }

  /** PowerShell does not kill its grandchildren; a stuck child holds the pipes open. */
  private killChild(child: ChildProcess): void {
    if (child.pid !== undefined) {
      try {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
      } catch {
        /* fall through to the plain kill */
      }
    }
    try {
      child.kill()
    } catch {
      /* already gone */
    }
  }
}

/**
 * The session wrapper: read base64 commands from stdin, run them, report back.
 *
 * Written for PowerShell 5.1, whose semantics are a subset of 7's, so the same
 * text runs on both.
 */
function buildWrapper(token: string): string {
  const ready = `'__CT_READY_${token}__'`
  const donePrefix = `'__CT_DONE_${token}_'`

  return [
    // PowerShell can set its OWN redirected-output encoding, which cmd could not:
    // `chcp` only affects a console, and a program writing to a pipe never sees it.
    'try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }',
    '$OutputEncoding = [Text.Encoding]::UTF8',
    "$ErrorActionPreference = 'Continue'",
    // Reused for every command: its whole job is to be an empty stdin.
    "$ctNullIn = New-Object IO.StringReader ''",
    '$ctSeq = 0',
    `Write-Output ${ready}`,
    'while ($true) {',
    '  $ctLine = [Console]::In.ReadLine()',
    '  if ($null -eq $ctLine) { break }',
    "  if ($ctLine -eq '') { continue }",
    '  $ctScript = ""',
    '  try { $ctScript = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($ctLine)) } catch { }',
    '  $ctSeq = $ctSeq + 1',
    '  $LASTEXITCODE = 0',
    // Cleared so the check after the command can tell whether THIS one errored.
    '  $Error.Clear()',
    '  $ctCode = 0',
    '  $ctSavedIn = [Console]::In',
    '  try {',
    // Point stdin at an empty reader for the duration, so a command that reads it
    // cannot swallow the next base64 line and desynchronise the session.
    '    [Console]::SetIn($ctNullIn)',
    /*
     * `Out-String -Stream` is NOT cosmetic — it is what stops `Get-Location` and
     * `$PWD` from hanging the session forever.
     *
     * Those two return a `PathInfo`, and letting the console host render it
     * directly deadlocks: stand-alone `powershell -EncodedCommand Get-Location`
     * prints a table and exits, but the same command inside a loop that owns stdin
     * never returns. Every other command tested — tables like `Get-ChildItem` and
     * `Get-PSDrive`, objects like `Get-Date`, plain strings, assignments — is fine
     * either way. Forcing the output through the formatter first avoids it.
     *
     * These are exactly the commands a model runs first to orient itself, so this
     * deadlock is the very first thing a fresh session hits.
     */
    '    Invoke-Expression $ctScript | Out-String -Stream | ForEach-Object { Write-Output $_ }',
    /*
     * NOT `$?`: after `A | B | C` it describes the LAST pipeline element, so a
     * cmdlet that failed non-terminatingly still reports success. That made
     * `Set-Location C:\nope` come back as exit code 0 — the model would be told
     * the command succeeded and would not correct itself.
     *
     * $Error.Count is unaffected by the pipeline. Verified against seven cases
     * (failing cmdlet, native exit code, throw, plain string); the `$?` variants
     * got two of them wrong.
     */
    '    if ($LASTEXITCODE -ne 0) { $ctCode = $LASTEXITCODE } elseif ($Error.Count -gt 0) { $ctCode = 1 }',
    '  } catch {',
    // A syntax error or `throw` must not take the session down with it.
    "    Write-Output ('__CT_ERROR__ ' + $_.Exception.Message)",
    '    $ctCode = 1',
    '  } finally {',
    '    [Console]::SetIn($ctSavedIn)',
    '  }',
    `  Write-Output (${donePrefix} + $ctSeq + '__ ' + $ctCode + ' ' + (Get-Location).Path)`,
    '}'
  ].join('\n')
}
