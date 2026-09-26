import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'

/**
 * Read-only Git inspection for the toolbox -> Git panel.
 *
 * Everything here shells out to the system `git`. Nothing is ever written to the
 * repository: the panel only visualises history, the index and diffs.
 */

export interface GitAuthor {
  name?: string
  email?: string
}

export interface GitLogEntry {
  hash: string
  branch: string
  parents: string[]
  message: string
  author?: GitAuthor
  committerDate: string
  authorDate?: string
}

export interface GitIndexStatus {
  modified: number
  added: number
  deleted: number
}

export type GitChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'

/** One changed path, with the line counts the file list shows. */
export interface GitFileChange {
  path: string
  /** Previous path, only set for renames. */
  oldPath?: string
  kind: GitChangeKind
  /** Single-letter code as Git reports it, for the badge. */
  code: string
  additions: number
  deletions: number
}

export interface GitDiffLine {
  kind: 'context' | 'add' | 'del'
  oldNumber?: number
  newNumber?: number
  text: string
}

export interface GitDiffHunk {
  header: string
  lines: GitDiffLine[]
}

export interface GitFileDiff {
  path: string
  /** True when Git refuses to show a text diff. */
  binary: boolean
  hunks: GitDiffHunk[]
  additions: number
  deletions: number
}

export interface GitLogResult {
  /** False when the directory is not inside a Git work tree. */
  isRepo: boolean
  currentBranch: string
  entries: GitLogEntry[]
  indexStatus: GitIndexStatus
  files: GitFileChange[]
  /** Set when the directory is a repo but the log could not be read. */
  error?: string
}

const FIELD = String.fromCharCode(31)
const RECORD = String.fromCharCode(30)
const MAX_COMMITS = 300
/** Diffs larger than this are truncated; the viewer is not a pager. */
const MAX_DIFF_BYTES = 512 * 1024

const EMPTY_INDEX: GitIndexStatus = { modified: 0, added: 0, deleted: 0 }

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error) reject(error)
        else resolve(stdout)
      }
    )
  })
}

/** Prefer the first real branch name in `%D`; fall back to the checked-out branch. */
function pickBranch(refNames: string, fallback: string): string {
  if (!refNames) return fallback
  for (const raw of refNames.split(',')) {
    const part = raw.trim()
    if (!part) continue
    const name = part.startsWith('HEAD -> ') ? part.slice(8).trim() : part
    if (name.startsWith('tag: ') || name === 'HEAD') continue
    return name.replace(/^origin\//, '')
  }
  return fallback
}

function parseLog(output: string, fallbackBranch: string): GitLogEntry[] {
  const entries: GitLogEntry[] = []
  for (const chunk of output.split(RECORD)) {
    const record = chunk.replace(/^\s+/, '').replace(/\s+$/, '')
    if (!record) continue
    const parts = record.split(FIELD)
    if (parts.length < 8) continue
    const parents = parts[1].trim()
    entries.push({
      hash: parts[0],
      branch: pickBranch(parts[7], fallbackBranch),
      parents: parents ? parents.split(' ') : [],
      author: { name: parts[2], email: parts[3] },
      authorDate: parts[4] || undefined,
      committerDate: parts[5],
      message: parts[6]
    })
  }
  return entries
}

/**
 * `git diff --numstat` prints `<add>\t<del>\t<path>`, and for a rename the path
 * is either `old => new` or a braced `dir/{old => new}/file`. This resolves both
 * forms to the path the file has now.
 */
function resolveNumstatPath(raw: string): string {
  const braced = raw.match(/^(.*)\{([^{}]*) => ([^{}]*)}(.*)$/)
  if (braced) return (braced[1] + braced[3] + braced[4]).replace(/\/\//g, '/')
  const arrow = raw.indexOf(' => ')
  if (arrow >= 0) return raw.slice(arrow + 4)
  return raw
}

function parseNumstat(output: string): Map<string, { additions: number; deletions: number }> {
  const counts = new Map<string, { additions: number; deletions: number }>()
  for (const line of output.split('\n')) {
    if (!line) continue
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const additions = parts[0] === '-' ? 0 : Number(parts[0])
    const deletions = parts[1] === '-' ? 0 : Number(parts[1])
    counts.set(resolveNumstatPath(parts[2]), {
      additions: Number.isFinite(additions) ? additions : 0,
      deletions: Number.isFinite(deletions) ? deletions : 0
    })
  }
  return counts
}

function kindFromCode(code: string): GitChangeKind {
  if (code === '??') return 'untracked'
  if (code.includes('R')) return 'renamed'
  if (code.includes('D')) return 'deleted'
  if (code.includes('A')) return 'added'
  return 'modified'
}

/** Count lines of an untracked file so its row can still show a size. */
async function countUntracked(cwd: string, path: string): Promise<number> {
  try {
    const full = path.replace(/\//g, require('node:path').sep)
    const text = await readFile(require('node:path').join(cwd, full), 'utf8')
    if (!text) return 0
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
  } catch {
    return 0
  }
}

async function parseStatus(cwd: string, porcelain: string, numstat: string): Promise<GitFileChange[]> {
  const counts = parseNumstat(numstat)
  const files: GitFileChange[] = []

  for (const raw of porcelain.split('\n')) {
    if (raw.length < 3) continue
    const code = raw.slice(0, 2)
    let path = raw.slice(3)
    let oldPath: string | undefined
    const arrow = path.indexOf(' -> ')
    if (arrow >= 0) {
      oldPath = path.slice(0, arrow).replace(/^"|"$/g, '')
      path = path.slice(arrow + 4).replace(/^"|"$/g, '')
    }

    const kind = kindFromCode(code)
    const count = counts.get(path)
    const additions = count ? count.additions : kind === 'untracked' ? await countUntracked(cwd, path) : 0
    const deletions = count ? count.deletions : 0

    files.push({
      path,
      oldPath,
      kind,
      code: code.trim(),
      additions,
      deletions
    })
  }

  files.sort((a, b) => a.path.localeCompare(b.path))
  return files
}

function summarise(files: GitFileChange[]): GitIndexStatus {
  const status: GitIndexStatus = { ...EMPTY_INDEX }
  for (const file of files) {
    if (file.kind === 'added' || file.kind === 'untracked') status.added += 1
    else if (file.kind === 'deleted') status.deleted += 1
    else status.modified += 1
  }
  return status
}

/** Split a unified diff into hunks, tracking the two line counters. */
function parseDiff(output: string): GitDiffHunk[] {
  const hunks: GitDiffHunk[] = []
  let current: GitDiffHunk | null = null
  let oldNumber = 0
  let newNumber = 0

  for (const line of output.split('\n')) {
    if (line.startsWith('@@')) {
      const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      oldNumber = match ? Number(match[1]) : 0
      newNumber = match ? Number(match[2]) : 0
      current = { header: line, lines: [] }
      hunks.push(current)
      continue
    }
    if (!current) continue
    if (line.startsWith('+')) {
      current.lines.push({ kind: 'add', newNumber, text: line.slice(1) })
      newNumber += 1
    } else if (line.startsWith('-')) {
      current.lines.push({ kind: 'del', oldNumber, text: line.slice(1) })
      oldNumber += 1
    } else if (line.startsWith(' ')) {
      current.lines.push({ kind: 'context', oldNumber, newNumber, text: line.slice(1) })
      oldNumber += 1
      newNumber += 1
    } else if (line.startsWith('\\')) {
      current.lines.push({ kind: 'context', text: line })
    }
  }
  return hunks
}

/** Read the history, index and changed files of the repository containing `cwd`. */
export async function readGitLog(cwd: string): Promise<GitLogResult> {
  const empty: GitLogResult = {
    isRepo: false,
    currentBranch: '',
    entries: [],
    indexStatus: { ...EMPTY_INDEX },
    files: []
  }
  if (!cwd) return empty

  try {
    const inside = await runGit(cwd, ['rev-parse', '--is-inside-work-tree'])
    if (inside.trim() !== 'true') return empty
  } catch {
    return empty
  }

  let currentBranch = ''
  try {
    currentBranch = (await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
  } catch {
    /* unborn or detached HEAD */
  }
  if (currentBranch === 'HEAD') currentBranch = 'HEAD (detached)'

  const result: GitLogResult = {
    isRepo: true,
    currentBranch,
    entries: [],
    indexStatus: { ...EMPTY_INDEX },
    files: []
  }

  try {
    const format = ['%H', '%P', '%an', '%ae', '%aI', '%cI', '%s', '%D'].join(FIELD) + RECORD
    const out = await runGit(cwd, [
      'log',
      '--all',
      '--date=iso-strict',
      '-n',
      String(MAX_COMMITS),
      '--pretty=format:' + format
    ])
    result.entries = parseLog(out, currentBranch)
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
  }

  try {
    const porcelain = await runGit(cwd, ['status', '--porcelain'])
    let numstat = ''
    try {
      numstat = await runGit(cwd, ['diff', 'HEAD', '--numstat'])
    } catch {
      /* an unborn HEAD has nothing to diff against */
    }
    result.files = await parseStatus(cwd, porcelain, numstat)
    result.indexStatus = summarise(result.files)
  } catch {
    /* status is best-effort */
  }

  return result
}

/** Read the unified diff for one changed path, as the panel's viewer shows it. */
export async function readGitDiff(cwd: string, path: string): Promise<GitFileDiff> {
  const empty: GitFileDiff = { path, binary: false, hunks: [], additions: 0, deletions: 0 }
  if (!cwd || !path) return empty

  let output = ''
  try {
    output = await runGit(cwd, ['diff', 'HEAD', '--', path])
  } catch {
    return empty
  }

  // Untracked files have nothing to diff against; present them as all-new.
  if (!output.trim()) {
    try {
      const full = path.replace(/\//g, require('node:path').sep)
      const text = await readFile(require('node:path').join(cwd, full), 'utf8')
      const lines = text.split('\n')
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
      const hunk: GitDiffHunk = {
        header: '@@ -0,0 +1,' + String(lines.length) + ' @@',
        lines: lines.map((line, index) => ({
          kind: 'add' as const,
          newNumber: index + 1,
          text: line
        }))
      }
      return { path, binary: false, hunks: [hunk], additions: lines.length, deletions: 0 }
    } catch {
      return empty
    }
  }

  if (output.length > MAX_DIFF_BYTES) output = output.slice(0, MAX_DIFF_BYTES)
  if (/^Binary files /m.test(output) || /GIT binary patch/m.test(output)) {
    return { path, binary: true, hunks: [], additions: 0, deletions: 0 }
  }

  let additions = 0
  let deletions = 0
  for (const line of output.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1
    else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1
  }

  return { path, binary: false, hunks: parseDiff(output), additions, deletions }
}