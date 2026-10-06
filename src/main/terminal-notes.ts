import { posix, win32 } from 'node:path'

/** Use the shell's absolute cwd; Windows aliases share a key, POSIX case remains significant. */
export function normalizeTerminalNotesDirectory(scope: 'local' | 'ssh', directory: string): string {
  const value = directory.trim()
  if (!value) return ''
  if (scope === 'ssh') {
    if (!posix.isAbsolute(value)) return ''
    return posix.normalize(value).replace(/\/+$/, '') || '/'
  }
  // A drive-relative path or a bare \folder cannot identify a unique Windows directory.
  if (!/^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i.test(value)) return ''
  const normalized = win32.normalize(value)
  const root = win32.parse(normalized).root
  return (normalized === root ? root : normalized.replace(/[\\/]+$/, '')).toLowerCase()
}
