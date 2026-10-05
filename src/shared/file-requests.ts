/** This contract is also validated in the injected script, which cannot import TS. */
export interface ReadFileSpec {
  path: string
}

export interface ReadFilesRequest {
  type: 'read_files'
  files: ReadFileSpec[]
  description: string
}

export interface FileReadContext {
  scope: 'local' | 'ssh'
  hostId: string
  cwd: string
}

export interface StoredFileReadRequest extends ReadFilesRequest {
  context: FileReadContext
}

export type FileDeliveryStatus = 'pending' | 'uploading' | 'sent' | 'failed' | 'unknown' | 'cancelled'
export type FileSendOutcome = 'ok' | 'busy' | 'stuck' | 'no-composer' | 'insert-failed' | 'cancelled' | 'unsupported-file-type' | 'upload-failed' | 'unknown'

export function parseReadFilesRequest(value: unknown): ReadFilesRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const request = value as Record<string, unknown>
  if (request.type !== 'read_files' || 'command' in request || 'questions' in request) return null
  if (!Array.isArray(request.files) || request.files.length < 1 || request.files.length > 5) return null
  if (typeof request.description !== 'string' || !request.description.trim() || request.description.length > 2000) return null
  const files: ReadFileSpec[] = []
  for (const raw of request.files) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const item = raw as Record<string, unknown>
    if (typeof item.path !== 'string' || !item.path.trim() || item.path.length > 4096 || /[\u0000-\u001f]/.test(item.path)) return null
    // Normalize older stored requests too: only the path survives, and every file
    // is uploaded in full regardless of legacy mode/range/encoding fields.
    files.push({ path: item.path.trim() })
  }
  return { type: 'read_files', files, description: request.description.trim() }
}
