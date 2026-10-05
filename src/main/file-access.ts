import { open, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, posix, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import type { StoredFileReadRequest } from '../shared/file-requests'
import type { ConversationImageAttachmentInput, FileReadingPlatform } from '../shared/types'

export const MAX_FILE_BYTES = 20 * 1024 * 1024
const MAX_BATCH_BYTES = 25 * 1024 * 1024
const ATTACHMENT_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.bmp': 'image/bmp', '.avif': 'image/avif', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.doc': 'application/msword', '.xls': 'application/vnd.ms-excel', '.ppt': 'application/vnd.ms-powerpoint',
  '.txt': 'text/plain', '.md': 'text/markdown', '.markdown': 'text/markdown',
  '.csv': 'text/csv', '.tsv': 'text/tab-separated-values', '.json': 'application/json',
  '.ipynb': 'application/json', '.xml': 'application/xml', '.html': 'text/html', '.htm': 'text/html',
  '.css': 'text/css', '.yaml': 'application/yaml', '.yml': 'application/yaml', '.rtf': 'application/rtf'
}
const SOURCE_EXTENSIONS = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.vue', '.svelte', '.py', '.go', '.rs',
  '.java', '.kt', '.kts', '.c', '.h', '.cpp', '.hpp', '.cs', '.rb', '.php', '.sh', '.ps1', '.sql', '.log'
])

export interface PreparedAttachment {
  path: string
  fileName: string
  mimeType: string
  sizeBytes: number
  sha256: string
  textNameAlias?: boolean
}
export interface PreparedFileResult {
  text: string
  attachments: PreparedAttachment[]
  images: ConversationImageAttachmentInput[]
  summary: string
  failed: boolean
  cleanup(): Promise<void>
}
export type RemoteFileReader = (path: string, maxBytes: number, signal: AbortSignal) => Promise<Buffer>

/** Recognize extensionless UTF-8 text without changing the bytes sent as an attachment. */
function isUtf8Text(bytes: Buffer): boolean {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return text.length > 0 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)
  } catch { return false }
}

export function resolveFilePath(request: StoredFileReadRequest, path: string): string {
  if (request.context.scope === 'ssh') {
    if (!request.context.cwd.startsWith('/')) throw new Error('远端工作目录尚未确定，请先用终端执行 pwd。')
    if (/^[a-z]:[\\/]/i.test(path) || path.startsWith('\\')) throw new Error('SSH 会话需要远端 POSIX 路径。')
    return posix.resolve(request.context.cwd, path)
  }
  if (!request.context.cwd || !isAbsolute(request.context.cwd)) throw new Error('本机工作目录尚未确定。')
  if (/^[a-z]:/i.test(path) && !isAbsolute(path)) throw new Error('请使用完整盘符路径或相对工作目录的路径。')
  // Windows device paths and alternate streams are not ordinary files.
  if (/^(\\\\[?.]\\)/.test(path) || /:(?![\\/])/.test(path.replace(/^[a-z]:/i, ''))) throw new Error('仅支持普通文件路径。')
  return resolve(request.context.cwd, path)
}

async function readLocalFile(path: string, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted()
  const handle = await open(path, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error('路径不是普通文件。')
    if (info.size > maxBytes) throw new Error(maxBytes < MAX_FILE_BYTES ? '本次附件合计超过 25 MiB。' : '文件超过 20 MiB 上限。')
    // Read one extra byte so growth between stat and read cannot bypass the cap.
    const chunks: Buffer[] = []
    let total = 0
    while (true) {
      signal.throwIfAborted()
      const buffer = Buffer.alloc(Math.min(65536, maxBytes + 1 - total))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (!bytesRead) break
      total += bytesRead
      if (total > maxBytes) throw new Error('读取期间文件变大，已超过大小上限。')
      chunks.push(buffer.subarray(0, bytesRead))
    }
    return Buffer.concat(chunks)
  } finally {
    await handle.close()
  }
}

/** Read snapshots; staging never modifies the user's source files. */
export async function prepareFiles(request: StoredFileReadRequest, signal: AbortSignal, remoteRead?: RemoteFileReader, platformId?: FileReadingPlatform['id']): Promise<PreparedFileResult> {
  const attachments: PreparedAttachment[] = []
  const images: ConversationImageAttachmentInput[] = []
  const sections: string[] = []
  let directory: string | null = null
  let totalBytes = 0
  let failed = false
  const cleanup = async (): Promise<void> => {
    if (directory) {
      if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('gpt-read-files-')) throw new Error('附件临时目录不在预期位置，未清理。')
      // Only this mkdtemp directory is removed, never a requested file path.
      await rm(directory, { recursive: true, force: true })
      directory = null
    }
  }
  try {
    for (const [index, spec] of request.files.entries()) {
      signal.throwIfAborted()
      let path = spec.path
      try {
        path = resolveFilePath(request, spec.path)
        const extension = extname(path).toLowerCase()
        const limit = Math.min(MAX_FILE_BYTES, MAX_BATCH_BYTES - totalBytes)
        if (limit <= 0) throw new Error('本次附件合计超过 25 MiB。')
        const bytes = request.context.scope === 'ssh'
          ? await (remoteRead ? remoteRead(path, limit, signal) : Promise.reject(new Error('SSH 文件通道不可用。')))
          : await readLocalFile(path, limit, signal)
        if (bytes.length > limit) throw new Error(limit < MAX_FILE_BYTES ? '本次附件合计超过 25 MiB。' : '文件超过 20 MiB 上限。')
        if (!bytes.length) throw new Error('空文件不能作为附件上传。')
        directory ??= await mkdtemp(join(tmpdir(), 'gpt-read-files-'))
        const sourceName = request.context.scope === 'ssh' ? posix.basename(path) : basename(path)
        let fileName = sourceName.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '') || 'attachment'
        if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(fileName)) fileName = `file_${fileName}`
        // DeepSeek's observed file input accepts .txt, but not extensionless files
        // such as .gitconfig. Add a transport suffix only to a confirmed text snapshot.
        const textNameAlias = platformId === 'deepseek' && extension === '' && isUtf8Text(bytes)
        if (textNameAlias) fileName += '.txt'
        if (attachments.some((file) => file.fileName === fileName)) throw new Error('本次附件含同名文件，请分两次读取。')
        // Keep the original bytes; directories isolate snapshots and transport names.
        const itemDir = join(directory, String(index))
        await mkdir(itemDir)
        const stagedPath = join(itemDir, fileName)
        await writeFile(stagedPath, bytes, { signal })
        const mimeType = textNameAlias ? 'text/plain' : ATTACHMENT_MIME[extension] ?? (SOURCE_EXTENSIONS.has(extension) ? 'text/plain' : 'application/octet-stream')
        attachments.push({ path: stagedPath, fileName, mimeType, sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), textNameAlias })
        totalBytes += bytes.length
        if (mimeType.startsWith('image/')) images.push({ fileName, mimeType, dataBase64: bytes.toString('base64'), sizeBytes: bytes.length, width: null, height: null })
        sections.push(`文件: ${path}\n附件已准备: ${fileName} (${(bytes.length / 1_000_000).toFixed(2)} MB)${textNameAlias ? '\nDeepSeek 文件名兼容：临时附件增加 .txt 后缀，内容字节保持不变。' : ''}`)
      } catch (error) {
        signal.throwIfAborted()
        failed = true
        sections.push(`文件: ${path}\n读取失败: ${(error as Error).message}`)
      }
    }
    signal.throwIfAborted()
    return { text: `【read_files 结果】\n主机: ${request.context.scope === 'ssh' ? request.context.hostId : '本机'}\n目录: ${request.context.cwd}\n\n${sections.join('\n\n')}`, attachments, images, summary: `AI 读取文件：\n${request.files.map((item) => item.path).join('\n')}`, failed, cleanup }
  } catch (error) {
    await cleanup()
    throw error
  }
}
