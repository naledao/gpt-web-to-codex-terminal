import { randomUUID } from 'node:crypto'
import type { ClientChannel } from 'ssh2'
import { IDLE_TIMEOUT_MS, MAX_RUNTIME_MS } from './shell'
import type { ExecutionShell, ShellResult } from './shell'
import { REMOTE_DETECT_COMMAND } from './environment'
import type { EnvironmentKind } from '../shared/types'

interface PendingRun {
  seq: number
  output: string
  resolve: (result: ShellResult) => void
  idleTimer: NodeJS.Timeout
  ceilingTimer: NodeJS.Timeout
  ceilingMs: number
  timedOut: false | 'idle' | 'ceiling'
  interrupted: boolean
}

/**
 * The command envelope sent to the remote shell.
 *
 * Three things are load-bearing:
 *
 *   - The trailing `printf` is the completion marker. It carries the token AND the
 *     sequence number, because a command can print anything at all — a bare
 *     sentinel would be indistinguishable from something the command echoed. A
 *     marker with the wrong number is treated as ordinary output.
 *   - `$?` is read on the line right after the block, so it is the block's status
 *     and not `printf`'s. `$PWD` comes along because the working directory
 *     persists between commands and the model has to be told where it ended up.
 *   - `</dev/null` on the block is a desynchronisation guard. The protocol lives
 *     on this channel's stdin, so a command that reads standard input (`read`,
 *     `cat`, an installer asking a question) would otherwise swallow the next
 *     command and leave the session waiting for a reply that can never match.
 *
 * The brace group is how the redirection is attached to the whole command. It is
 * a shell group, not a subshell, so `cd`, variable assignments and function
 * definitions still apply to the session afterwards — which is the entire reason
 * this is a persistent shell rather than one process per command.
 *
 * Exported so the protocol can be driven against a real shell without Electron.
 */
export function buildEnvelope(token: string, seq: number, command: string): string {
  return (
    [
      '{',
      command,
      '} </dev/null',
      `printf '__CT_DONE_${token}_%s__ %s %s\\n' '${seq}' "$?" "$PWD"`
    ].join('\n') + '\n'
  )
}

/**
 * A long-lived shell on the far side of an SSH connection.
 *
 * This is the remote counterpart of `ConversationShell`, and it exists because the
 * prompt and the executor have to agree. The moment an SSH session is attached the
 * model is told it is driving that machine, so its commands must actually run
 * there — a prompt that says Linux while PowerShell executes is worse than no
 * prompt at all, because it aims the model at commands that cannot work.
 *
 * It runs on its OWN channel (`bash -s`), not on the interactive PTY that the user
 * types into. A PTY echoes every byte back and prints a prompt between commands,
 * which would have to be untangled from the real output by guessing at prompt
 * shapes; a plain exec channel has no echo and no prompt, so what comes back is
 * what the command produced. The cost is that the two sessions do not share a
 * working directory, which the UI states outright rather than hiding.
 */
export class RemoteShell implements ExecutionShell {
  readonly kind: EnvironmentKind = 'posix'
  readonly probeCommand: string = REMOTE_DETECT_COMMAND

  private readonly token = randomUUID().replace(/-/g, '').slice(0, 10)
  private seq = 0
  private lineBuffer = ''
  private pending: PendingRun | null = null
  private closed = false
  private disposed = false
  private currentCwd = ''

  constructor(
    private readonly stream: ClientChannel,
    private readonly options: {
      /** Called with decoded output as it arrives, for live display. */
      onOutput?: (chunk: string) => void
      /** Called when the channel goes away; the manager decides whether to reopen. */
      onClosed?: (interrupted: boolean) => void
    } = {}
  ) {
    stream.on('data', (chunk: Buffer) => this.handleData(chunk))
    // Merged into one stream on purpose: there is no terminal to colour them
    // differently, and losing stderr would lose most of what went wrong.
    stream.stderr?.on('data', (chunk: Buffer) => this.handleData(chunk))
    stream.on('close', () => this.handleClosed())
  }

  get alive(): boolean {
    return !this.closed && !this.disposed
  }

  get running(): boolean {
    return this.pending !== null
  }

  get cwd(): string {
    return this.currentCwd
  }

  /** Remember a directory the model has moved to, for the UI. */
  noteCwd(path: string): void {
    if (path !== '') this.currentCwd = path
  }

  run(command: string, timeoutMs?: number): Promise<ShellResult> {
    if (this.disposed) return Promise.resolve(this.reject('远端会话已关闭。'))
    if (this.closed) return Promise.resolve(this.reject('远端会话已结束，请重新连接后重试。'))
    if (this.pending) return Promise.resolve(this.reject('远端终端正忙，忽略了这条命令。'))

    const cleaned = command.replace(/[\r\n]+$/, '')
    if (cleaned.trim() === '') {
      return Promise.resolve({
        output: '',
        exitCode: 0,
        timedOut: false,
        interrupted: false,
        rejected: false,
        sessionLost: false,
        cwd: this.currentCwd
      })
    }

    return new Promise<ShellResult>((resolve) => {
      const seq = (this.seq += 1)

      const idleTimer = setTimeout(() => {
        if (this.pending) this.pending.timedOut = 'idle'
        this.terminate()
      }, IDLE_TIMEOUT_MS)

      const ceilingMs = Number.isFinite(timeoutMs)
        ? Math.min(Math.max(Math.floor(Number(timeoutMs)), 1000), MAX_RUNTIME_MS)
        : MAX_RUNTIME_MS
      const ceilingTimer = setTimeout(() => {
        if (this.pending) this.pending.timedOut = 'ceiling'
        this.terminate()
      }, ceilingMs)

      this.pending = { seq, output: '', resolve, idleTimer, ceilingTimer, ceilingMs, timedOut: false, interrupted: false }

      try {
        this.stream.write(buildEnvelope(this.token, seq, cleaned))
      } catch {
        this.clearPending()
        resolve(this.reject('写入远端终端失败。'))
      }
    })
  }

  async interrupt(): Promise<boolean> {
    if (!this.pending || this.closed || this.disposed) return false

    this.pending.interrupted = true
    const closed = new Promise<void>((resolve) => this.stream.once('close', () => resolve()))
    this.terminate()
    await closed
    return true
  }

  dispose(): void {
    this.disposed = true
    // Settled, not dropped. `run()`'s caller is awaiting this promise, so a
    // pending command left unresolved would park the whole automation loop with
    // the execution stuck at `running` and nothing on screen to explain it.
    this.abandonPending('远端会话在执行这条命令时被关闭。')
    try {
      this.stream.close()
    } catch {
      /* already gone */
    }
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

  private clearPending(): void {
    if (!this.pending) return
    clearTimeout(this.pending.idleTimer)
    clearTimeout(this.pending.ceilingTimer)
    this.pending = null
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

  /**
   * Abandon a command that will not finish.
   *
   * `signal('KILL')` is what actually stops the remote process; `close()` only
   * drops the channel, and a runaway command would keep running on the server with
   * nobody listening. Not every server implements signals, hence the fallback.
   */
  private terminate(): void {
    try {
      this.stream.signal('KILL')
    } catch {
      /* server does not support signals on this channel */
    }
    try {
      this.stream.close()
    } catch {
      /* already gone */
    }
  }

  private handleClosed(): void {
    if (this.closed) return
    this.closed = true

    const pending = this.pending
    const interrupted = pending?.interrupted ?? false
    if (pending) {
      this.clearPending()
      pending.resolve({
        output: pending.output.trimEnd(),
        timeoutMs: pending.ceilingMs,
        exitCode: null,
        timedOut: pending.timedOut,
        interrupted: pending.interrupted,
        rejected: false,
        // A channel that vanishes mid-command is a lost session, not a timeout —
        // unless a timer killed it, in which case the timer already said why.
        sessionLost: pending.timedOut === false && !pending.interrupted,
        cwd: this.currentCwd
      })
    }

    if (!this.disposed) this.options.onClosed?.(interrupted)
  }

  /**
   * Line-oriented framing, matching the local shell.
   *
   * Both markers are whole lines, so a partially received marker — the channel
   * splits wherever TCP felt like it — can never be mistaken for a complete one.
   */
  private handleData(chunk: Buffer): void {
    this.lineBuffer += chunk.toString('utf8')

    let newline = this.lineBuffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.lineBuffer.slice(0, newline).replace(/\r$/, '')
      this.lineBuffer = this.lineBuffer.slice(newline + 1)
      this.handleLine(line)
      newline = this.lineBuffer.indexOf('\n')
    }
  }

  private handleLine(line: string): void {
    const donePrefix = `__CT_DONE_${this.token}_`
    if (line.startsWith(donePrefix)) {
      const match = /^(\d+)__\s+(-?\d+)\s*(.*)$/.exec(line.slice(donePrefix.length))
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
      // Any output at all counts as progress; only silence means "stuck".
      clearTimeout(this.pending.idleTimer)
      this.pending.idleTimer = setTimeout(() => {
        if (this.pending) this.pending.timedOut = 'idle'
        this.terminate()
      }, IDLE_TIMEOUT_MS)

      this.pending.output += `${line}\n`
    }

    this.options.onOutput?.(`${line}\n`)
  }
}

/**
 * The command that opens the persistent remote shell.
 *
 * `bash` when it exists, `sh` otherwise: the protocol needs nothing beyond POSIX
 * shell, and assuming bash would fail outright on Alpine and on minimal images.
 * The exec channel runs it under the login shell, so this is a command line rather
 * than an argv.
 */
export const REMOTE_SHELL_COMMAND =
  'if command -v bash >/dev/null 2>&1; then exec bash -s; else exec sh -s; fi'
