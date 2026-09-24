import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * Mirror everything the app prints into a file, so a failed run can be read afterwards.
 *
 * WHY THIS EXISTS
 * ---------------
 * Diagnosing the embedded sessions meant asking the user to copy their terminal every time,
 * because `console.warn` in the main process goes to a console nobody keeps. Chromium's own
 * network errors (`handshake failed … net_error -100`) are worse: they name no host, so a
 * pasted copy is often not enough to tell WHICH request died.
 *
 * WHAT IT CAPTURES
 * ----------------
 *  - `console.*` from the main process, tagged with the level.
 *  - stdout and stderr written directly (Electron forwards the renderer's console here, and
 *    with `ELECTRON_ENABLE_LOGGING=1` so do Chromium's network and TLS messages).
 *  - uncaught exceptions and unhandled rejections, which otherwise vanish with the window.
 *
 * OFF BY DEFAULT. Set `DSH_APP_LOG=1` to enable. It is opt-in rather than always-on because
 * the embed's own console output can carry page content, and a log that quietly accumulates
 * that is not something to leave running by accident.
 */

const FLAG = 'DSH_APP_LOG'
const DIR_NAME = 'logs'

/**
 * Set `DSH_NET_LOG=1` to have Chromium write its full network log, which is the only way to
 * learn WHICH request produced a bare `handshake failed … net_error -100`.
 *
 * Chromium's console message for a failed TLS handshake names no host, and two platforms are
 * embedded at once — so the message alone cannot be acted on. The net log carries the URL, the
 * error and the proxy resolution for every request; `analyseNetLog` reduces it to the failures.
 *
 * Separate flag from `DSH_APP_LOG` on purpose: the net log is tens of megabytes and contains
 * every URL the session touched, so it should be asked for explicitly.
 */
const NET_LOG_FLAG = 'DSH_NET_LOG'

/** Enabled alongside the app log; the file lands in the same directory. */
export function installNetLog(): string | null {
  if (process.env[NET_LOG_FLAG] !== '1') return null
  const dir = join(app.getPath('userData'), DIR_NAME)
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    return null
  }
  const now = new Date()
  const name = `netlog-${now.toISOString().replace(/[:.]/g, '-')}.json`
  const file = join(dir, name)
  // Must be set before the network service starts; callers do this at import time.
  app.commandLine.appendSwitch('log-net-log', file)
  app.commandLine.appendSwitch('net-log-capture-mode', 'IncludeSensitive')
  return file
}

let logFile: string | null = null
let installed = false

function stamp(): string {
  // Local time: correlating with what the user saw on screen is the whole point.
  const now = new Date()
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0')
  return (
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.` +
    `${pad(now.getMilliseconds(), 3)}`
  )
}

/**
 * Append one already-formatted chunk.
 *
 * Synchronous on purpose. A write stream buffers, and this process can exit on a crash —
 * which is exactly the log worth having. `appendFileSync` also keeps interleaved stdout and
 * stderr in the order they happened, which a stream does not guarantee.
 */
function write(text: string): void {
  if (logFile === null) return
  try {
    appendFileSync(logFile, text)
  } catch {
    // A full disk must not take the app down over a log line.
  }
}

function format(level: string, parts: unknown[]): string {
  const body = parts
    .map((part) => {
      if (typeof part === 'string') return part
      if (part instanceof Error) return `${part.name}: ${part.message}\n${part.stack ?? ''}`
      try {
        return JSON.stringify(part)
      } catch {
        return String(part)
      }
    })
    .join(' ')
  return `[${stamp()}] ${level} ${body}\n`
}

export function appLogPath(): string | null {
  return logFile
}

/**
 * Start logging, if the flag is set. Safe to call before `app.whenReady()`.
 *
 * Returns the file path when logging is on, so startup can print it — a log nobody can find
 * is the same as no log.
 */
export function installAppLog(): string | null {
  if (installed) return logFile
  if (process.env[FLAG] !== '1') return null
  installed = true

  const dir = join(app.getPath('userData'), DIR_NAME)
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    return null
  }

  const now = new Date()
  const name =
    `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}` +
    `-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}.log`
  logFile = join(dir, name)

  write(
    `\n===== ${app.getName()} ${app.getVersion()} =====\n` +
      `started ${now.toISOString()}\n` +
      `electron ${process.versions.electron} chrome ${process.versions.chrome} node ${process.versions.node}\n` +
      `platform ${process.platform} ${process.arch}\n` +
      `userData ${app.getPath('userData')}\n` +
      `argv ${JSON.stringify(process.argv.slice(1))}\n`
  )

  // console.* first, so our own lines and the patched stream writes share one format.
  const levels: Array<'log' | 'info' | 'warn' | 'error' | 'debug'> = [
    'log',
    'info',
    'warn',
    'error',
    'debug'
  ]
  for (const level of levels) {
    const original = console[level].bind(console)
    console[level] = (...parts: unknown[]): void => {
      write(format(level.toUpperCase(), parts))
      original(...parts)
    }
  }

  /*
   * Tee the raw streams as well.
   *
   * The patched console covers our own calls, but not everything that reaches the terminal:
   * Electron forwards the renderer's console to stdout, and `ELECTRON_ENABLE_LOGGING=1` makes
   * Chromium's network/TLS diagnostics arrive the same way. Those are the lines that name no
   * host, so they are precisely the ones worth keeping.
   */
  const tee = (stream: NodeJS.WriteStream, label: string): void => {
    const original = stream.write.bind(stream)
    stream.write = ((chunk: unknown, ...rest: unknown[]): boolean => {
      try {
        if (typeof chunk === 'string') write(`[${stamp()}] ${label} ${chunk}`)
        else if (chunk instanceof Uint8Array) write(`[${stamp()}] ${label} ${Buffer.from(chunk).toString('utf8')}`)
      } catch {
        /* never let logging break a write */
      }
      return (original as (...args: unknown[]) => boolean)(chunk, ...rest)
    }) as typeof stream.write
  }
  tee(process.stdout, 'out')
  tee(process.stderr, 'err')

  process.on('uncaughtException', (error) => {
    write(format('UNCAUGHT', [error]))
  })
  process.on('unhandledRejection', (reason) => {
    write(format('UNHANDLED-REJECTION', [reason]))
  })

  write(`[${stamp()}] log file: ${logFile}\n`)
  return logFile
}
