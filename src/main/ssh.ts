import { Client } from 'ssh2'
import type { ClientChannel, SFTPWrapper } from 'ssh2'
import { randomUUID } from 'node:crypto'
import { stat, unlink } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Socket } from 'node:net'
import { basename, posix } from 'node:path'
import type { SshDownloadTask, SshFileEntry, SshState, SshUploadTask, TerminalLine } from '../shared/types'
import { REMOTE_SHELL_COMMAND, RemoteShell } from './remote-shell'

/** Strips ANSI/VT escape sequences — there is no terminal emulator to render them. */
const ANSI_RE = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g

const MAX_LINES = 500
const CONNECT_TIMEOUT_MS = 20_000
const PROXY_TIMEOUT_MS = 15_000

/** How many times a dying command channel is reopened before giving up. */
const MAX_EXEC_ATTEMPTS = 3

/** Coalesce bursts of mirrored output into one push per tick. */
const MIRROR_PUSH_INTERVAL_MS = 150

/** Quote one path for the POSIX command used to reopen a killed exec channel. */
function posixQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

/** Everything needed to open one connection. */
export interface SshTarget {
  hostId: string
  name: string
  host: string
  port: number
  username: string
  /** Already resolved: the typed password, or the one decrypted from the database. */
  password: string
  /** Already resolved against the setting. Empty means connect directly. */
  proxy: string
}

/**
 * Dial `host:port` through an HTTP proxy and hand back the tunnel.
 *
 * The proxy in Settings cannot be reused here: it is installed on the embedded
 * page's Electron *session*, while ssh2 asks for a plain socket. So the tunnel is
 * established by hand with CONNECT.
 *
 * Only HTTP(S) proxies are handled. A SOCKS URL gets an explicit message rather
 * than a confusing connection failure — most local proxies (Clash's mixed port,
 * for one) also speak HTTP on the same port, so pointing at that works.
 */
function connectViaHttpProxy(proxyUrl: string, host: string, port: number): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    let proxy: URL
    try {
      proxy = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(proxyUrl) ? proxyUrl : `http://${proxyUrl}`)
    } catch {
      reject(new Error(`代理地址无法解析：${proxyUrl}`))
      return
    }

    const scheme = proxy.protocol.replace(':', '').toLowerCase()
    if (scheme !== 'http' && scheme !== 'https') {
      reject(
        new Error(`SSH 目前只支持 http:// 代理（HTTP CONNECT），收到的是 ${scheme}://。若代理同时开了 HTTP 端口，请填那个。`)
      )
      return
    }

    const send = scheme === 'https' ? httpsRequest : httpRequest
    const request = send({
      host: proxy.hostname,
      port: Number(proxy.port) || (scheme === 'https' ? 443 : 80),
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers: { Host: `${host}:${port}` },
      timeout: PROXY_TIMEOUT_MS
    })

    request.on('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy()
        reject(
          new Error(`代理拒绝了到 ${host}:${port} 的连接（HTTP ${response.statusCode}）`)
        )
        return
      }
      // ssh2 drives the timing from here; the CONNECT timeout must not fire later.
      socket.setTimeout(0)
      resolve(socket as Socket)
    })
    request.on('timeout', () => {
      request.destroy()
      reject(new Error(`连接代理 ${proxyUrl} 超时`))
    })
    request.on('error', (error) =>
      reject(new Error(`无法连接代理 ${proxyUrl}：${error.message}`))
    )
    request.end()
  })
}

const EMPTY: SshState = {
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
 * One SSH session driving the left terminal pane.
 *
 * Uses `ssh2`, which is pure JavaScript — its native accelerators are optional
 * and were never built here, so nothing needs an Electron ABI rebuild.
 *
 * A connection opens TWO channels, and the distinction matters:
 *
 *   - an interactive PTY shell, which is what the user sees and types into;
 *   - a plain `bash -s` exec channel, which is where the MODEL's commands run.
 *
 * They are separate because the PTY echoes every byte and prints a prompt between
 * commands, and untangling that from real output means guessing at prompt shapes.
 * The exec channel has neither, so framing it is exact. The cost — the two do not
 * share a working directory — is shown in the UI rather than hidden.
 *
 * Worth stating explicitly: SSH traffic does NOT go through the ChatGPT proxy
 * setting. `ssh2` opens its own socket through Node's `net`, and the proxy is
 * applied to the embedded page's Electron *session*, which this never touches.
 * That separation is the whole reason the proxy was scoped that way.
 */
export class SshManager {
  private client: Client | null = null
  private stream: ClientChannel | null = null
  private buffer = ''
  private lines: TerminalLine[] = []
  private state: SshState = { ...EMPTY }

  /** The channel the model's commands run on, once it is up. */
  private exec: RemoteShell | null = null
  private execAttempts = 0
  private mirrorTimer: NodeJS.Timeout | null = null
  private readonly downloads = new Map<string, SshDownloadTask>()
  private readonly downloadChannels = new Map<string, SFTPWrapper>()
  private readonly downloadEmitAt = new Map<string, number>()
  private readonly uploads = new Map<string, SshUploadTask>()
  private readonly uploadChannels = new Map<string, SFTPWrapper>()
  private readonly uploadEmitAt = new Map<string, number>()

  constructor(
    private readonly onChanged: (state: SshState) => void,
    private readonly onDownloadsChanged: (items: SshDownloadTask[]) => void,
    private readonly onUploadsChanged: (items: SshUploadTask[]) => void
  ) {}

  getState(): SshState {
    return {
      ...this.state,
      // Derived rather than stored: the channel can die at any moment, and a stale
      // `true` here would tell the UI — and the prompt logic — that the model is
      // driving the remote host when it has already fallen back to local.
      remoteExec: this.exec !== null && this.exec.alive,
      modelCwd: this.exec?.cwd ?? '',
      lines: [...this.lines]
    }
  }

  /**
   * The backend the model's commands should use, or null when this connection
   * cannot offer one and execution has to stay local.
   */
  execShell(): RemoteShell | null {
    return this.exec !== null && this.exec.alive ? this.exec : null
  }

  /** Mirror a line produced by the model's own shell into this transcript. */
  pushModelLine(line: TerminalLine): void {
    this.lines.push({ kind: line.kind, text: line.text })
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES)
    this.scheduleMirrorPush()
  }

  /** Mirror streamed remote output, appended to the trailing output line. */
  pushModelOutput(chunk: string): void {
    const text = chunk.replace(/\r/g, '')
    if (text === '') return
    const last = this.lines[this.lines.length - 1]
    if (last && last.kind === 'output') last.text += text
    else this.lines.push({ kind: 'output', text })
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES)
    this.scheduleMirrorPush()
  }

  /**
   * Start connecting.
   *
   * Returns immediately with `connecting`; the outcome arrives through
   * `onChanged`. A handshake can take twenty seconds, and blocking an IPC reply
   * on it would freeze the dialog that started it.
   */
  connect(target: SshTarget, resumeCwd = ''): SshState {
    this.teardown()

    this.lines = []
    this.buffer = ''
    this.execAttempts = 0
    this.state = {
      status: 'connecting',
      attached: true,
      name: target.name,
      target: `${target.host}:${target.port}`,
      hostId: target.hostId,
      message: target.proxy
        ? `正在通过代理 ${target.proxy} 连接 ${target.username}@${target.host}:${target.port}…`
        : `正在连接 ${target.username}@${target.host}:${target.port}…`,
      // Both are derived in getState(); these are only the values for the window
      // before a command channel exists.
      remoteExec: false,
      modelCwd: '',
      lines: []
    }
    this.pushLine('notice', this.state.message)
    this.emit()

    const client = new Client()
    this.client = client

    client.on('ready', () => {
      client.shell({ term: 'xterm-256color', cols: 120, rows: 32 }, (error, stream) => {
        if (error) {
          this.fail(`无法打开远程 shell：${error.message}`)
          return
        }
        this.stream = stream
        this.state = { ...this.state, status: 'connected', message: `已连接 ${this.state.target}` }
        this.pushLine('notice', `已连接 ${this.state.target}`)

        stream.on('data', (chunk: Buffer) => this.consume(chunk.toString('utf8')))
        stream.stderr.on('data', (chunk: Buffer) => this.consume(chunk.toString('utf8')))
        stream.on('close', () => {
          this.pushLine('notice', '远程会话已关闭')
          this.teardown()
          this.state = { ...this.state, status: 'disconnected', message: '远程会话已关闭' }
          this.emit()
        })
        this.emit()

        // Opened after the pane is already usable: the model's channel is not
        // needed for the user to start typing, and waiting for it would delay
        // every connection by a round trip.
        this.openExecChannel(client, resumeCwd.trim())
      })
    })

    client.on('error', (error: Error) => this.fail(error.message))

    client.on('close', () => {
      // Fires after both a clean disconnect and a failure; only report it when we
      // were actually connected, so an error message is not overwritten by it.
      if (this.state.status === 'connected') {
        this.teardown()
        this.state = { ...this.state, status: 'disconnected', message: '连接已断开' }
        this.pushLine('notice', '连接已断开')
        this.emit()
      }
    })

    /*
     * With a proxy the handshake cannot start until the tunnel exists, so this
     * runs as its own async step. `this.client !== client` guards against the user
     * disconnecting while the proxy was still being dialled.
     */
    void (async () => {
      try {
        const sock = target.proxy
          ? await connectViaHttpProxy(target.proxy, target.host, target.port)
          : undefined
        if (this.client !== client) {
          sock?.destroy()
          return
        }

        client.connect({
          host: target.host,
          port: target.port,
          username: target.username,
          password: target.password,
          sock,
          readyTimeout: CONNECT_TIMEOUT_MS,
          // First contact with an unknown host: accept and remember it for this
          // session. There is no known_hosts UI yet, and refusing outright would
          // make the feature unusable.
          hostVerifier: () => true
        })
      } catch (error) {
        if (this.client === client) this.fail((error as Error).message)
      }
    })()

    return this.getState()
  }

  /** Restore an attached-but-disconnected SSH pane without opening a network connection. */
  restoreAttachment(target: Pick<SshTarget, 'hostId' | 'name' | 'host' | 'port'>): SshState {
    this.teardown()
    this.lines = []
    this.buffer = ''
    this.execAttempts = 0
    this.state = {
      ...EMPTY,
      status: 'disconnected',
      attached: true,
      name: target.name,
      target: `${target.host}:${target.port}`,
      hostId: target.hostId,
      message: '已断开',
      lines: []
    }
    this.emit()
    return this.getState()
  }

  disconnect(): SshState {
    this.pushLine('notice', '正在断开…')
    this.teardown()
    this.state = { ...this.state, status: 'disconnected', message: '已断开' }
    this.emit()
    return this.getState()
  }

  /** Hide the SSH transcript and go back to the local terminal. */
  dismiss(): SshState {
    this.teardown()
    this.lines = []
    this.buffer = ''
    this.state = { ...EMPTY, lines: [] }
    this.emit()
    return this.getState()
  }

  /** List one remote directory over SFTP for the file manager. */
  async listFiles(remotePath: string): Promise<SshFileEntry[]> {
    const client = this.client
    if (!client || this.state.status !== 'connected') throw new Error('当前没有已连接的 SSH 会话。')
    const dir = remotePath.trim() || '/'
    const sftp = await new Promise<import('ssh2').SFTPWrapper>((resolve, reject) => {
      client.sftp((error, channel) => (error ? reject(error) : resolve(channel)))
    })
    try {
      const entries = await new Promise<import('ssh2').FileEntryWithStats[]>((resolve, reject) => {
        sftp.readdir(dir, (error, list) => (error ? reject(error) : resolve(list)))
      })
      return entries
        .filter((entry) => entry.filename !== '.' && entry.filename !== '..')
        .map((entry): SshFileEntry => ({
          id: dir === '/' ? '/' + entry.filename : posix.join(dir, entry.filename),
          name: entry.filename,
          type: entry.attrs.isDirectory() ? 'folder' : 'file',
          size: entry.attrs.size,
          modifiedAt: entry.attrs.mtime * 1000
        }))
        .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'folder' ? -1 : 1))
    } finally {
      sftp.end()
    }
  }

  /** Current and recently finished downloads, newest first. */
  getDownloads(): SshDownloadTask[] {
    return [...this.downloads.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((item) => ({ ...item }))
  }

  /** Start one remote-file download without blocking its IPC caller until completion. */
  downloadFile(remotePath: string, localPath: string): void {
    if (!this.client || this.state.status !== 'connected') throw new Error('当前没有已连接的 SSH 会话。')
    const source = remotePath.trim()
    const destination = localPath.trim()
    if (source === '' || destination === '') throw new Error('下载路径不能为空。')

    const task: SshDownloadTask = {
      id: randomUUID(),
      name: basename(source) || source,
      remotePath: source,
      localPath: destination,
      status: 'downloading',
      transferred: 0,
      total: 0,
      startedAt: Date.now(),
      finishedAt: null,
      error: ''
    }
    this.downloads.set(task.id, task)
    this.emitDownloads()
    void this.runDownload(task.id)
  }

  /** Cancel one transfer by closing its dedicated SFTP channel. */
  cancelDownload(id: string): boolean {
    const task = this.downloads.get(id)
    if (!task || task.status !== 'downloading') return false
    task.status = 'cancelled'
    task.finishedAt = Date.now()
    this.emitDownloads()
    try {
      this.downloadChannels.get(id)?.destroy()
    } catch {
      /* the transfer may already be closing */
    }
    return true
  }

  private async runDownload(id: string): Promise<void> {
    const task = this.downloads.get(id)
    const client = this.client
    if (!task || !client) return

    let sftp: SFTPWrapper | null = null
    let transferStarted = false
    try {
      sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
        client.sftp((error, channel) => (error ? reject(error) : resolve(channel)))
      })
      if (task.status !== 'downloading') return
      this.downloadChannels.set(id, sftp)

      await new Promise<void>((resolve, reject) => {
        transferStarted = true
        sftp!.fastGet(
          task.remotePath,
          task.localPath,
          {
            step: (transferred, _chunk, total) => {
              const active = this.downloads.get(id)
              if (!active || active.status !== 'downloading') return
              active.transferred = transferred
              active.total = total
              const now = Date.now()
              const last = this.downloadEmitAt.get(id) ?? 0
              if (now - last >= 100 || (total > 0 && transferred >= total)) {
                this.downloadEmitAt.set(id, now)
                this.emitDownloads()
              }
            }
          },
          (error) => (error ? reject(error) : resolve())
        )
      })

      const completed = this.downloads.get(id)
      if (completed?.status === 'downloading') {
        completed.status = 'completed'
        completed.finishedAt = Date.now()
        if (completed.total > 0) completed.transferred = completed.total
        this.emitDownloads()
      }
    } catch (error) {
      const failed = this.downloads.get(id)
      if (failed?.status === 'downloading') {
        failed.status = 'failed'
        failed.finishedAt = Date.now()
        failed.error = (error as Error).message
        this.emitDownloads()
      }
      if (transferStarted && failed?.status !== 'completed') {
        try {
          await unlink(task.localPath)
        } catch {
          /* partial file may already be gone */
        }
      }
    } finally {
      this.downloadChannels.delete(id)
      this.downloadEmitAt.delete(id)
      if (sftp) {
        try {
          sftp.end()
        } catch {
          /* already closed */
        }
      }
    }
  }

  private emitDownloads(): void {
    this.onDownloadsChanged(this.getDownloads())
  }
  /** Current and recently finished uploads, newest first. */
  getUploads(): SshUploadTask[] {
    return [...this.uploads.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((item) => ({ ...item }))
  }

  /** Start one task per selected file and return immediately. */
  uploadFiles(localPaths: string[]): SshState {
    if (!this.client || this.state.status !== 'connected') {
      this.pushLine('error', '当前没有已连接的 SSH 会话，无法上传文件。')
      this.emit()
      return this.getState()
    }

    const files = localPaths.filter((path) => typeof path === 'string' && path !== '')
    if (files.length === 0) return this.getState()

    const remoteDir = this.exec?.cwd || '.'
    for (const localPath of files) {
      const name = basename(localPath)
      const task: SshUploadTask = {
        id: randomUUID(),
        name,
        localPath,
        remotePath: posix.join(remoteDir, name),
        status: 'uploading',
        transferred: 0,
        total: 0,
        startedAt: Date.now(),
        finishedAt: null,
        error: ''
      }
      this.uploads.set(task.id, task)
      void this.runUpload(task.id)
    }
    this.pushLine('notice', `正在上传 ${files.length} 个文件到 ${remoteDir}…`)
    this.emitUploads()
    this.emit()
    return this.getState()
  }

  /** Cancel one upload by closing its dedicated SFTP channel. */
  cancelUpload(id: string): boolean {
    const task = this.uploads.get(id)
    if (!task || task.status !== 'uploading') return false
    task.status = 'cancelled'
    task.finishedAt = Date.now()
    this.emitUploads()
    try {
      this.uploadChannels.get(id)?.destroy()
    } catch {
      /* the transfer may already be closing */
    }
    return true
  }

  private async runUpload(id: string): Promise<void> {
    const task = this.uploads.get(id)
    const client = this.client
    if (!task || !client) return

    let sftp: SFTPWrapper | null = null
    try {
      const info = await stat(task.localPath)
      if (task.status !== 'uploading') return
      task.total = info.size
      this.emitUploads()

      sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
        client.sftp((error, channel) => (error ? reject(error) : resolve(channel)))
      })
      if (task.status !== 'uploading') return
      this.uploadChannels.set(id, sftp)

      await new Promise<void>((resolve, reject) => {
        sftp!.fastPut(
          task.localPath,
          task.remotePath,
          {
            fileSize: task.total,
            step: (transferred, _chunk, total) => {
              const active = this.uploads.get(id)
              if (!active || active.status !== 'uploading') return
              active.transferred = transferred
              active.total = total
              const now = Date.now()
              const last = this.uploadEmitAt.get(id) ?? 0
              if (now - last >= 100 || (total > 0 && transferred >= total)) {
                this.uploadEmitAt.set(id, now)
                this.emitUploads()
              }
            }
          },
          (error) => (error ? reject(error) : resolve())
        )
      })

      const completed = this.uploads.get(id)
      if (completed?.status === 'uploading') {
        completed.status = 'completed'
        completed.finishedAt = Date.now()
        if (completed.total > 0) completed.transferred = completed.total
        this.pushLine('notice', `已上传 ${completed.name} → ${completed.remotePath}`)
        this.emitUploads()
        this.emit()
      }
    } catch (error) {
      const failed = this.uploads.get(id)
      if (failed?.status === 'uploading') {
        failed.status = 'failed'
        failed.finishedAt = Date.now()
        failed.error = (error as Error).message
        this.pushLine('error', `上传失败：${failed.name}：${failed.error}`)
        this.emitUploads()
        this.emit()
      }
    } finally {
      this.uploadChannels.delete(id)
      this.uploadEmitAt.delete(id)
      if (sftp) {
        try {
          sftp.end()
        } catch {
          /* already closed */
        }
      }
    }
  }

  private emitUploads(): void {
    this.onUploadsChanged(this.getUploads())
  }
  /** Send one line to the remote shell. */
  async write(text: string): Promise<void> {
    const line = text.replace(/[\r\n]+$/, '')
    if (line === '') return

    this.pushLine('command', line)
    this.emit()

    // Manual input runs on the model's exec channel, so a `cd` here moves the
    // directory the model will actually work in. Writing to the interactive PTY
    // would silently desync the two shells, which is the bug this closes.
    const exec = this.exec
    if (!exec) {
      this.pushLine('error', '模型命令通道尚未就绪，稍后再试。')
      this.emit()
      return
    }

    const result = await exec.run(line)
    if (result.rejected) {
      this.pushLine('error', result.output)
    }
    // A bare `cd` emits no output line, so nothing else would signal the change;
    // emit here so the UI re-reads modelCwd.
    this.emit()
  }

  dispose(): void {
    this.teardown()
  }

  /* ---------------------------------------------------------------- */

  /**
   * Open the channel the model's commands run on.
   *
   * A failure here is reported loudly rather than silently: execution would fall
   * back to the LOCAL machine while the pane still shows a remote host, and
   * "delete the old build directory" landing on the user's own PC because the
   * remote channel never came up is not a failure mode worth being subtle about.
   */
  private openExecChannel(client: Client, resumeCwd = ''): void {
    this.execAttempts += 1
    if (this.execAttempts > MAX_EXEC_ATTEMPTS) {
      this.pushLine('error', '命令会话反复断开，已放弃重开。模型命令将继续在本地机器上执行。')
      this.emit()
      return
    }

    const command =
      resumeCwd === '' ? REMOTE_SHELL_COMMAND : `cd ${posixQuote(resumeCwd)} && ${REMOTE_SHELL_COMMAND}`

    client.exec(command, (error, stream) => {
      if (error) {
        this.pushLine('error', `无法在远端启动命令会话：${error.message}——模型命令将继续在本地执行`)
        this.emit()
        return
      }

      // The user may have disconnected while the channel was being opened.
      if (this.client !== client) {
        try {
          stream.close()
        } catch {
          /* already gone */
        }
        return
      }

      const shell = new RemoteShell(stream, {
        onOutput: (chunk) => this.pushModelOutput(chunk),
        onClosed: (interrupted) => {
          // Deliberate command interruption is not a flaky-channel retry.
          // Cancel the attempt consumed by the channel we intentionally killed,
          // so repeated interrupts can always reopen the remote execution shell.
          if (interrupted && this.execAttempts > 0) this.execAttempts -= 1
          if (this.exec === shell) this.exec = null
          if (this.client === client && this.state.status === 'connected') {
            this.pushLine('notice', '命令会话已断开，正在重开…')
            this.openExecChannel(client, interrupted ? shell.cwd : '')
          }
          // During a deliberate interrupt do not publish the transient null exec
          // backend. Main would otherwise briefly route/probe against LOCAL while
          // the SSH execution channel is being reopened.
          if (!interrupted) this.emit()
        }
      })

      if (resumeCwd !== '') shell.noteCwd(resumeCwd)
      this.exec = shell
      this.pushLine('notice', '已接管：模型命令将在这台主机上执行')
      this.emit()
    })
  }

  private scheduleMirrorPush(): void {
    if (this.mirrorTimer) return
    this.mirrorTimer = setTimeout(() => {
      this.mirrorTimer = null
      this.emit()
    }, MIRROR_PUSH_INTERVAL_MS)
  }

  private fail(reason: string): void {
    this.teardown()
    this.state = { ...this.state, status: 'error', message: reason }
    this.pushLine('error', reason)
    this.emit()
  }

  private teardown(): void {
    for (const task of this.downloads.values()) {
      if (task.status === 'downloading') this.cancelDownload(task.id)
    }
    for (const task of this.uploads.values()) {
      if (task.status === 'uploading') this.cancelUpload(task.id)
    }

    if (this.mirrorTimer) {
      clearTimeout(this.mirrorTimer)
      this.mirrorTimer = null
    }

    // Disposed BEFORE the client goes away: `RemoteShell.dispose()` marks itself
    // disposed, so its close handler does not try to reopen a channel on a
    // connection that is being torn down.
    const exec = this.exec
    this.exec = null
    exec?.dispose()

    const stream = this.stream
    this.stream = null
    if (stream) {
      try {
        stream.close()
      } catch {
        /* already gone */
      }
    }

    const client = this.client
    this.client = null
    if (client) {
      try {
        client.end()
      } catch {
        /* already gone */
      }
    }
  }

  private emit(): void {
    this.onChanged(this.getState())
  }

  private pushLine(kind: TerminalLine['kind'], text: string): void {
    this.lines.push({ kind, text })
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES)
  }

  /**
   * Split an incoming stream into lines.
   *
   * A PTY emits CRLF, and programs that redraw in place emit a bare CR. Both end
   * a line here: there is no terminal emulator to move a cursor, so treating a
   * bare CR as "overwrite" would just lose output.
   */
  private consume(text: string): void {
    this.buffer += text

    for (;;) {
      const index = this.buffer.search(/[\r\n]/)
      if (index === -1) break

      const line = this.buffer.slice(0, index)
      const isCrLf = this.buffer[index] === '\r' && this.buffer[index + 1] === '\n'
      this.buffer = this.buffer.slice(index + (isCrLf ? 2 : 1))
      this.pushVisible(line)
    }

    this.emit()
  }

  private pushVisible(rawLine: string): void {
    const cleaned = (ANSI_RE.test(rawLine) ? rawLine.replace(ANSI_RE, '') : rawLine).replace(/\r/g, '')
    // Blank lines are mostly PTY filler; dropping them keeps the pane readable.
    if (cleaned.trim() === '') return
    this.pushLine('output', cleaned)
  }
}