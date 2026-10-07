import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { nativeImage } from 'electron'
import { parseReadFilesRequest } from '../shared/file-requests'
import { normalizeTerminalNotesDirectory } from './terminal-notes'
import type { StoredFileReadRequest, FileDeliveryStatus } from '../shared/file-requests'
import type {
  Conversation,
  ConversationImageAttachmentInput,
  ExecutionRecord,
  ExecutionStatus,
  ScrapedConversation,
  SshHost
} from '../shared/types'

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

const MYSQL_CONNECTIONS_TABLE = `-- Saved MySQL connections for one machine -- a LIST, not a single row.
--
-- One row per machine could not describe the ordinary case of a local database next
-- to a staging one, and it made the connection form overwrite itself every time a
-- second connection was entered. Its id is the row own identity and is what the
-- dialog tabs are keyed by.
--
-- The password is never stored in the clear: secret holds base64 of Electron safeStorage
-- ciphertext (DPAPI-backed on Windows), or empty when none is set.
CREATE TABLE IF NOT EXISTS mysql_connections (
  id            TEXT NOT NULL,
  machine_scope TEXT NOT NULL,
  host_id       TEXT NOT NULL DEFAULT '',
  name          TEXT NOT NULL DEFAULT '',
  host          TEXT NOT NULL DEFAULT '',
  port          INTEGER NOT NULL DEFAULT 3306,
  username      TEXT NOT NULL DEFAULT '',
  secret        TEXT NOT NULL DEFAULT '',
  database      TEXT NOT NULL DEFAULT '',
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_mysql_connections_machine ON mysql_connections (machine_scope, host_id, updated_at);`

const NACOS_CONNECTIONS_TABLE = `-- Saved Nacos consoles for one machine -- a LIST, like mysql_connections.
--
-- Same reasoning: one server per machine is the exception, not the rule (dev, test,
-- and production consoles are all reachable from one desk). The id is the row own
-- identity and is what the dialog tabs are keyed by.
--
-- There is no password column. A Nacos console authenticates in its OWN page, with its
-- own login form and its own cookies, kept in the view partition. The app never sees
-- those credentials, so there is nothing here to encrypt.
CREATE TABLE IF NOT EXISTS nacos_connections (
  id            TEXT NOT NULL,
  machine_scope TEXT NOT NULL,
  host_id       TEXT NOT NULL DEFAULT '',
  name          TEXT NOT NULL DEFAULT '',
  url           TEXT NOT NULL DEFAULT '',
  namespace     TEXT NOT NULL DEFAULT '',
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_nacos_connections_machine ON nacos_connections (machine_scope, host_id, updated_at);`

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,
  machine_scope TEXT NOT NULL,
  host_id       TEXT NOT NULL DEFAULT '',
  machine_label TEXT NOT NULL DEFAULT '',
  name          TEXT NOT NULL,
  path          TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE(machine_scope, host_id, path)
);

CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT PRIMARY KEY,
  url        TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  goal       TEXT NOT NULL DEFAULT '',
  project_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversations_updated_at
  ON conversations (updated_at DESC);

-- Clean user/assistant transcript. Internal system prompts, terminal command output, and
-- assistant command instructions never enter this table; those stay in the automation pipeline.
CREATE TABLE IF NOT EXISTS conversation_messages (
  id                TEXT PRIMARY KEY,
  conversation_id   TEXT NOT NULL,
  role              TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  source_message_id TEXT,
  content           TEXT NOT NULL,
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_conversation
  ON conversation_messages (conversation_id, created_at ASC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_messages_source
  ON conversation_messages (conversation_id, role, source_message_id)
  WHERE source_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS message_attachments (
  id           TEXT PRIMARY KEY,
  message_id   TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK(kind IN ('image')),
  mime_type    TEXT NOT NULL,
  file_name    TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  sha256       TEXT NOT NULL,
  width        INTEGER,
  height       INTEGER,
  size_bytes   INTEGER NOT NULL,
  ordinal      INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  UNIQUE(message_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_message_attachments_message
  ON message_attachments (message_id, ordinal ASC);
CREATE INDEX IF NOT EXISTS idx_message_attachments_sha256
  ON message_attachments (sha256);

-- One row per command the model asked for. The primary key is ChatGPT's own
-- assistant message id, which is what makes "运行过的命令不能运行了" survive a
-- restart: a message that already has a row is never executed again.
CREATE TABLE IF NOT EXISTS executions (
  message_id      TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  command         TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'command',
  file_request    TEXT,
  delivery_status TEXT,
  description     TEXT NOT NULL DEFAULT '',
  timeout_seconds INTEGER NOT NULL DEFAULT 120,
  status          TEXT NOT NULL,
  exit_code       INTEGER,
  output          TEXT NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL,
  started_at     INTEGER,
  finished_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_executions_conversation
  ON executions (conversation_id, created_at);

-- Managed workspace sessions. Unlike ChatGPT conversations, these rows describe
-- the app-level session cards shown by the session manager and survive restarts.
CREATE TABLE IF NOT EXISTS managed_sessions (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL DEFAULT '',
  url             TEXT NOT NULL DEFAULT '',
  conversation_id TEXT,
  platform_id     TEXT NOT NULL DEFAULT 'chatgpt',
  paused          INTEGER NOT NULL DEFAULT 0,
  prompt_injection_enabled INTEGER NOT NULL DEFAULT 1,
  local_cwd       TEXT NOT NULL DEFAULT '',
  ssh_host_id     TEXT NOT NULL DEFAULT '',
  ssh_attached    INTEGER NOT NULL DEFAULT 0,
  ssh_reconnect   INTEGER NOT NULL DEFAULT 0,
  ssh_cwd         TEXT NOT NULL DEFAULT '',
  send_delay_seconds INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_managed_sessions_created_at
  ON managed_sessions (created_at ASC);
-- Small key/value store for app settings that must survive a restart
-- (currently just the execution mode).
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- SSH targets. The password never lands here in the clear: the secret column
-- holds base64 of Electron's safeStorage ciphertext (DPAPI-backed on Windows),
-- or an empty string when no password is stored.
--
-- 'note' retains the legacy machine-level description for explicit directory import.
CREATE TABLE IF NOT EXISTS ssh_hosts (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  host       TEXT NOT NULL,
  port       INTEGER NOT NULL,
  username   TEXT NOT NULL,
  proxy      TEXT NOT NULL DEFAULT '',
  secret     TEXT NOT NULL DEFAULT '',
  note       TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Directory conventions are shared by sessions using the same machine and exact cwd.
CREATE TABLE IF NOT EXISTS terminal_directory_notes (
  machine_scope TEXT NOT NULL CHECK(machine_scope IN ('local', 'ssh')),
  host_id       TEXT NOT NULL,
  directory_key TEXT NOT NULL,
  note          TEXT NOT NULL DEFAULT '',
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (machine_scope, host_id, directory_key)
);

${MYSQL_CONNECTIONS_TABLE}
${NACOS_CONNECTIONS_TABLE}
`

interface ConversationRow {
  id: string
  url: string
  title: string
  goal: string
  project_id: string | null
  project_machine_scope: string | null
  project_host_id: string | null
  project_machine_label: string | null
  project_name: string | null
  project_path: string | null
  updated_at: number
}

interface ConversationMessageRow {
  id: string
  conversation_id: string
  role: 'user' | 'assistant'
  source_message_id: string | null
  content: string
  created_at: number
}
interface MessageAttachmentRow {
  id: string
  message_id: string
  kind: 'image'
  mime_type: string
  file_name: string
  storage_path: string
  sha256: string
  width: number | null
  height: number | null
  size_bytes: number
  ordinal: number
  created_at: number
}

/**
 * Command replies belong to the execution pipeline, not to the clean chat transcript.
 * DeepSeek does not keep the same message identity between the streamed command event and
 * the later rendered Markdown, so matching only `executions.message_id` is not sufficient.
 * The command protocol is deliberately narrow: a JSON object with a string `command` field.
 */
function isAssistantCommandReply(content: string): boolean {
  return /\{\s*["']command["']\s*:\s*["']/s.test(String(content || '')) || /"type"\s*:\s*"read_files"/.test(content)
}

interface ExecutionRow {
  message_id: string
  conversation_id: string
  command: string
  kind: string
  file_request: string | null
  delivery_status: string | null
  description: string
  timeout_seconds: number
  status: string
  exit_code: number | null
  output: string
  created_at: number
  started_at: number | null
  finished_at: number | null
}
export interface ManagedSessionRecord {
  id: string
  title: string
  url: string
  conversationId: string | null
  /** Which chat site this session drives. See `ManagedSessionSummary.platformId`. */
  platformId: string
  paused: boolean
  promptInjectionEnabled: boolean
  localCwd: string
  sshHostId: string
  sshAttached: boolean
  sshReconnect: boolean
  sshCwd: string
  sendDelaySeconds: number
  createdAt: number
  updatedAt: number
}

/** Map a raw SQLite row onto the shared shape. */
function toExecutionRecord(row: ExecutionRow): ExecutionRecord {
  let fileRequest: StoredFileReadRequest | null = null
  try {
    const raw = row.file_request ? JSON.parse(row.file_request) : null
    const parsed = parseReadFilesRequest(raw)
    if (parsed && raw.context && (raw.context.scope === 'local' || raw.context.scope === 'ssh') && typeof raw.context.cwd === 'string' && typeof raw.context.hostId === 'string') {
      fileRequest = { ...parsed, context: raw.context }
    }
  } catch { /* A malformed stored request must never become a shell command. */ }
  return {
    messageId: row.message_id,
    conversationId: row.conversation_id,
    command: row.command,
    kind: row.kind === 'read_files' ? 'read_files' : 'command',
    fileRequest,
    deliveryStatus: row.delivery_status as FileDeliveryStatus | null,
    description: row.description,
    timeoutSeconds: row.timeout_seconds,
    status: row.status as ExecutionStatus,
    exitCode: row.exit_code,
    output: row.output,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at
  }
}

/**
 * SQLite-backed store for ChatGPT conversations.
 *
 * Uses Node's built-in `node:sqlite` (available in Electron's main process),
 * so the project needs no native module and no Electron ABI rebuild.
 */
export class ConversationStore {
  private readonly db: DatabaseSync
  private readonly attachmentsDir: string

  constructor(filePath: string) {
    // userData exists once Electron is ready, but be defensive on first run.
    mkdirSync(dirname(filePath), { recursive: true })
    this.attachmentsDir = join(dirname(filePath), 'attachments')
    mkdirSync(this.attachmentsDir, { recursive: true })
    this.db = new DatabaseSync(filePath)
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec(SCHEMA)
    this.migrate()
    this.removeDuplicateMessageAttachments()
  }

  /**
   * Add columns that were introduced after a database was first created.
   *
   * `CREATE TABLE IF NOT EXISTS` does nothing at all to an existing table, so a
   * column added to SCHEMA reaches new databases only. Without this, an upgraded
   * install would be missing it and every query touching it would throw.
   */
  private migrate(): void {
    const sshColumns = this.db.prepare('PRAGMA table_info(ssh_hosts)').all() as unknown as Array<{
      name: string
    }>
    if (!sshColumns.some((column) => column.name === 'note')) {
      this.db.exec("ALTER TABLE ssh_hosts ADD COLUMN note TEXT NOT NULL DEFAULT ''")
    }
    /*
     * mysql_connections gained an `id` column, so the table is a LIST now rather than one
     * row per machine. CREATE TABLE IF NOT EXISTS leaves the old shape alone, and a primary
     * key cannot be altered in place, so the legacy rows are carried into the new table and
     * the old one is dropped. Those rows were one-connection-per-machine, which maps onto
     * exactly one row each; the connection gets an empty name and is labelled by its host.
     */
    const mysqlColumns = this.db
      .prepare('PRAGMA table_info(mysql_connections)')
      .all() as unknown as Array<{ name: string }>
    if (!mysqlColumns.some((column) => column.name === 'id')) {
      this.db.exec('ALTER TABLE mysql_connections RENAME TO mysql_connections_legacy')
      this.db.exec(MYSQL_CONNECTIONS_TABLE)
      const legacyRows = this.db
        .prepare('SELECT machine_scope, host_id, host, port, username, secret, database, updated_at FROM mysql_connections_legacy')
        .all() as unknown as Array<{
        machine_scope: string
        host_id: string
        host: string
        port: number
        username: string
        secret: string
        database: string
        updated_at: number
      }>
      const insertLegacy = this.db.prepare(
        'INSERT INTO mysql_connections (id, machine_scope, host_id, name, host, port, username, secret, database, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      for (const row of legacyRows) {
        insertLegacy.run(randomUUID(), row.machine_scope, row.host_id, '', row.host, row.port, row.username, row.secret, row.database, row.updated_at)
      }
      this.db.exec('DROP TABLE mysql_connections_legacy')
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_mysql_connections_machine ON mysql_connections (machine_scope, host_id, updated_at)')
    }
    const managedSessionColumns = this.db
      .prepare('PRAGMA table_info(managed_sessions)')
      .all() as unknown as Array<{ name: string }>
    const managedSessionMigrations: Array<[string, string]> = [
      ['paused', 'INTEGER NOT NULL DEFAULT 0'],
      ['prompt_injection_enabled', 'INTEGER NOT NULL DEFAULT 1'],
      ['local_cwd', "TEXT NOT NULL DEFAULT ''"],
      ['ssh_host_id', "TEXT NOT NULL DEFAULT ''"],
      ['ssh_attached', 'INTEGER NOT NULL DEFAULT 0'],
      ['ssh_reconnect', 'INTEGER NOT NULL DEFAULT 0'],
      ['ssh_cwd', "TEXT NOT NULL DEFAULT ''"],
      ['send_delay_seconds', 'INTEGER NOT NULL DEFAULT 0']
    ]
    for (const [name, definition] of managedSessionMigrations) {
      if (!managedSessionColumns.some((column) => column.name === name)) {
        this.db.exec(`ALTER TABLE managed_sessions ADD COLUMN ${name} ${definition}`)
      }
    }

    const executionColumns = this.db
      .prepare('PRAGMA table_info(executions)')
      .all() as unknown as Array<{ name: string }>
    if (!executionColumns.some((column) => column.name === 'started_at')) {
      this.db.exec('ALTER TABLE executions ADD COLUMN started_at INTEGER')
    }
    if (!executionColumns.some((column) => column.name === 'timeout_seconds')) {
      this.db.exec('ALTER TABLE executions ADD COLUMN timeout_seconds INTEGER NOT NULL DEFAULT 120')
    }
    for (const [name, definition] of [['kind', "TEXT NOT NULL DEFAULT 'command'"], ['file_request', 'TEXT'], ['delivery_status', 'TEXT']]) {
      if (!executionColumns.some((column) => column.name === name)) this.db.exec(`ALTER TABLE executions ADD COLUMN ${name} ${definition}`)
    }
    // A crashed process cannot prove whether an in-progress upload was submitted.
    this.db.exec("UPDATE executions SET status = 'interrupted', delivery_status = CASE WHEN delivery_status = 'uploading' THEN 'unknown' ELSE 'cancelled' END WHERE kind = 'read_files' AND status = 'running'")
    this.db.exec("UPDATE executions SET delivery_status = 'unknown' WHERE kind = 'read_files' AND delivery_status = 'uploading'")
    this.db.exec("UPDATE executions SET delivery_status = 'cancelled' WHERE kind = 'read_files' AND status IN ('done', 'failed') AND delivery_status IN ('pending', 'failed')")
    const conversationColumns = this.db
      .prepare('PRAGMA table_info(conversations)')
      .all() as unknown as Array<{ name: string }>
    if (!conversationColumns.some((column) => column.name === 'project_id')) {
      this.db.exec('ALTER TABLE conversations ADD COLUMN project_id TEXT')
    }
    if (!conversationColumns.some((column) => column.name === 'goal')) {
      this.db.exec("ALTER TABLE conversations ADD COLUMN goal TEXT NOT NULL DEFAULT ''")
    }
    /*
     * `managed_sessions.platform_id` — which chat site a session drives.
     *
     * Existing rows were all ChatGPT, so the default is not just a placeholder: it is the
     * correct value for every row written before this column existed.
     */
    const managedColumns = this.db
      .prepare('PRAGMA table_info(managed_sessions)')
      .all() as unknown as Array<{ name: string }>
    if (!managedColumns.some((column) => column.name === 'platform_id')) {
      this.db.exec("ALTER TABLE managed_sessions ADD COLUMN platform_id TEXT NOT NULL DEFAULT 'chatgpt'")
    }
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_conversations_project ON conversations (project_id, updated_at DESC)'
    )
    // Older builds briefly stored assistant command JSON as chat. Remove both rows whose
    // source id matches an execution and DeepSeek rows whose streamed/rendered ids differ.
    this.db.exec(
      "DELETE FROM conversation_messages WHERE role = 'assistant' AND source_message_id IN (SELECT message_id FROM executions)"
    )
    const commandRows = this.db
      .prepare("SELECT id, content FROM conversation_messages WHERE role = 'assistant'")
      .all() as unknown as Array<{ id: string; content: string }>
    const removeCommandReply = this.db.prepare('DELETE FROM conversation_messages WHERE id = ?')
    let removedCommandReplies = 0
    for (const row of commandRows) {
      if (!isAssistantCommandReply(row.content)) continue
      removeCommandReply.run(row.id)
      removedCommandReplies += 1
    }
    if (removedCommandReplies > 0) {
      console.info(`[db] removed ${removedCommandReplies} assistant command reply record(s)`)
    }
  }

  /**
   * Return a stable identity for the decoded image pixels. Raw PNG/JPEG bytes can
   * differ after the browser's canvas fallback while displaying the same picture.
   */
  private attachmentContentHash(bytes: Buffer, rawHash = createHash('sha256').update(bytes).digest('hex')): string {
    try {
      const image = nativeImage.createFromBuffer(bytes)
      if (!image.isEmpty()) return createHash('sha256').update(image.toPNG()).digest('hex')
    } catch (_) {
      /* malformed or unsupported image: retain the raw-byte identity */
    }
    return rawHash
  }

  /** Remove duplicate decoded images left by older capture builds. */
  private removeDuplicateMessageAttachments(): void {
    const rows = this.db
      .prepare(
        `SELECT id, message_id, storage_path, sha256
           FROM message_attachments
          ORDER BY message_id ASC, ordinal ASC, rowid ASC`
      )
      .all() as unknown as Array<{ id: string; message_id: string; storage_path: string; sha256: string }>
    if (rows.length < 2) return

    const seen = new Set<string>()
    const duplicates: Array<{ id: string; storagePath: string }> = []
    for (const row of rows) {
      const absolutePath = join(this.attachmentsDir, row.storage_path)
      let contentHash = row.sha256
      try {
        if (existsSync(absolutePath)) contentHash = this.attachmentContentHash(readFileSync(absolutePath), row.sha256)
      } catch (_) {
        /* leave an unreadable attachment identifiable by its stored raw hash */
      }
      const key = `${row.message_id}:${contentHash}`
      if (seen.has(key)) duplicates.push({ id: row.id, storagePath: row.storage_path })
      else seen.add(key)
    }
    if (duplicates.length === 0) return

    const remove = this.db.prepare('DELETE FROM message_attachments WHERE id = ?')
    for (const duplicate of duplicates) remove.run(duplicate.id)
    const stillReferenced = this.db.prepare('SELECT 1 FROM message_attachments WHERE storage_path = ? LIMIT 1')
    for (const duplicate of duplicates) {
      if (stillReferenced.get(duplicate.storagePath)) continue
      const absolutePath = join(this.attachmentsDir, duplicate.storagePath)
      try {
        if (existsSync(absolutePath)) unlinkSync(absolutePath)
      } catch (_) {
        /* the row is gone; a later orphan sweep can remove an undeletable file */
      }
    }
    console.info(`[db] removed ${duplicates.length} duplicate image attachment(s)`)
  }

  /**
   * Insert a conversation, or refresh it if already known.
   *
   * A blank title never overwrites a known one: navigation events fire before
   * the page has a real title, and the sidebar occasionally renders an empty
   * label for a moment.
   */
  private ensureProject(
    project: {
      machineScope: 'local' | 'ssh'
      hostId: string
      machineLabel: string
      name: string
      path: string
    },
    now: number
  ): string {
    const existing = this.db
      .prepare('SELECT id FROM projects WHERE machine_scope = ? AND host_id = ? AND path = ?')
      .get(project.machineScope, project.hostId, project.path) as { id: string } | undefined

    if (existing) {
      this.db
        .prepare('UPDATE projects SET machine_label = ?, name = ?, updated_at = ? WHERE id = ?')
        .run(project.machineLabel, project.name, now, existing.id)
      return existing.id
    }

    const id = randomUUID()
    this.db
      .prepare(
        'INSERT INTO projects (id, machine_scope, host_id, machine_label, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(id, project.machineScope, project.hostId, project.machineLabel, project.name, project.path, now, now)
    return id
  }

  upsert(
    conversation: ScrapedConversation,
    project?: {
      machineScope: 'local' | 'ssh'
      hostId: string
      machineLabel: string
      name: string
      path: string
    } | null,
    now = Date.now()
  ): boolean {
    const existing = this.db
      .prepare('SELECT title, project_id FROM conversations WHERE id = ?')
      .get(conversation.id) as { title: string; project_id: string | null } | undefined

    if (!existing) {
      const projectId = project ? this.ensureProject(project, now) : null
      this.db
        .prepare(
          'INSERT INTO conversations (id, url, title, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .run(conversation.id, conversation.url, conversation.title, projectId, now, now)
      return true
    }

    const title = conversation.title.trim() === '' ? existing.title : conversation.title
    const projectId = existing.project_id ?? (project ? this.ensureProject(project, now) : null)
    this.db
      .prepare('UPDATE conversations SET url = ?, title = ?, project_id = ?, updated_at = ? WHERE id = ?')
      .run(conversation.url, title, projectId, now, conversation.id)
    return true
  }

  /**
   * Record what the user asked for in this conversation.
   *
   * A blank goal never overwrites a known one, for the same reason a blank title does
   * not: the capture happens on send, and a miss must not erase what is already known.
   * It does NOT touch `updated_at` — that orders the sidebar, and the goal arrives from
   * a send rather than from activity in the page.
   */
  setGoal(conversationId: string, goal: string): boolean {
    const text = goal.trim()
    if (text === '') return false
    const result = this.db
      .prepare('UPDATE conversations SET goal = ? WHERE id = ?')
      .run(text, conversationId)
    return result.changes > 0
  }

  /** Merge a batch scraped from the sidebar. Returns how many were new. */
  upsertMany(conversations: ScrapedConversation[]): number {
    let inserted = 0
    for (const conversation of conversations) {
      const existed = this.db
        .prepare('SELECT 1 AS ok FROM conversations WHERE id = ?')
        .get(conversation.id)
      if (!existed) inserted += 1
      this.upsert(conversation)
    }
    return inserted
  }

  list(machineScope?: 'local' | 'ssh', hostId?: string): Conversation[] {
    const rows = this.db
      .prepare(
        `SELECT c.id, c.url, c.title, c.goal, c.project_id, c.updated_at,
                p.machine_scope AS project_machine_scope,
                p.host_id AS project_host_id,
                p.machine_label AS project_machine_label,
                p.name AS project_name,
                p.path AS project_path
           FROM conversations c
           LEFT JOIN projects p ON p.id = c.project_id
          WHERE (? IS NULL OR (p.machine_scope = ? AND p.host_id = ?))
          ORDER BY c.updated_at DESC`
      )
      .all(machineScope ?? null, machineScope ?? null, hostId ?? '') as unknown as ConversationRow[]

    return rows.map((row) => ({
      id: row.id,
      url: row.url,
      title: row.title,
      goal: row.goal ?? '',
      project:
        row.project_id && row.project_machine_scope && row.project_name && row.project_path
          ? {
              id: row.project_id,
              machineScope: row.project_machine_scope as 'local' | 'ssh',
              hostId: row.project_host_id ?? '',
              machineLabel: row.project_machine_label ?? '',
              name: row.project_name,
              path: row.project_path
            }
          : null,
      updatedAt: row.updated_at
    }))
  }

  moveToProject(
    conversationId: string,
    projectId: string,
    machineScope: 'local' | 'ssh',
    hostId: string,
    now = Date.now()
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE conversations
            SET project_id = ?, updated_at = ?
          WHERE id = ?
            AND EXISTS (
              SELECT 1 FROM projects source
               WHERE source.id = conversations.project_id
                 AND source.machine_scope = ?
                 AND source.host_id = ?
            )
            AND EXISTS (
              SELECT 1 FROM projects target
               WHERE target.id = ?
                 AND target.machine_scope = ?
                 AND target.host_id = ?
            )`
      )
      .run(projectId, now, conversationId, machineScope, hostId, projectId, machineScope, hostId)
    return Number(result.changes) > 0
  }
  remove(id: string): void {
    const paths = this.db
      .prepare(
        `SELECT DISTINCT storage_path
           FROM message_attachments
          WHERE message_id IN (
            SELECT id FROM conversation_messages WHERE conversation_id = ?
          )`
      )
      .all(id) as unknown as Array<{ storage_path: string }>

    this.db
      .prepare(
        `DELETE FROM message_attachments
          WHERE message_id IN (
            SELECT id FROM conversation_messages WHERE conversation_id = ?
          )`
      )
      .run(id)
    this.db.prepare('DELETE FROM conversation_messages WHERE conversation_id = ?').run(id)
    this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id)

    for (const row of paths) {
      const stillReferenced = this.db
        .prepare('SELECT 1 AS ok FROM message_attachments WHERE storage_path = ? LIMIT 1')
        .get(row.storage_path)
      if (stillReferenced) continue
      const absolutePath = join(this.attachmentsDir, row.storage_path)
      try {
        if (existsSync(absolutePath)) unlinkSync(absolutePath)
      } catch (error) {
        console.warn('[db] failed to remove orphaned attachment:', (error as Error).message)
      }
    }
  }

  /**
   * Drop rows whose id is not a real conversation id.
   *
   * Guards against rows written before the id-shape check existed, and against
   * placeholder routes like `/c/WEB`. Returns how many rows were removed.
   */
  purgeInvalidIds(isValid: (id: string) => boolean): number {
    const rows = this.db.prepare('SELECT id FROM conversations').all() as unknown as { id: string }[]
    const invalid = rows.filter((row) => !isValid(row.id))
    if (invalid.length === 0) return 0

    for (const row of invalid) this.remove(row.id)
    return invalid.length
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM conversations').get() as { n: number }
    return row.n
  }

  /* ---------------- executions ---------------- */

  /**
   * Record a command the model asked for.
   *
   * Returns false when this message id is already known — that is the guard
   * behind "运行过的命令不能运行了", and it is durable across restarts.
   */
  createExecution(record: {
    messageId: string
    conversationId: string
    command: string
    fileRequest?: StoredFileReadRequest
    description: string
    timeoutSeconds: number
    status: ExecutionStatus
    createdAt: number
  }): boolean {
    const existing = this.db
      .prepare('SELECT 1 AS ok FROM executions WHERE message_id = ?')
      .get(record.messageId)
    if (existing) return false

    this.db
      .prepare(
        `INSERT INTO executions
           (message_id, conversation_id, command, description, timeout_seconds, status, output, created_at, kind, file_request, delivery_status)
         VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?)`
      )
      .run(
        record.messageId,
        record.conversationId,
        record.command,
        record.description,
        record.timeoutSeconds,
        record.status,
        record.createdAt,
        record.fileRequest ? 'read_files' : 'command',
        record.fileRequest ? JSON.stringify(record.fileRequest) : null,
        record.fileRequest ? 'pending' : null
      )
    return true
  }

  /** Persist one clean chat turn plus any user image attachments. */
  appendConversationMessage(
    conversationId: string,
    role: 'user' | 'assistant',
    content: string,
    sourceMessageId: string | null = null,
    now = Date.now(),
    attachments: ConversationImageAttachmentInput[] = []
  ): string | null {
    if (content.trim() === '' && attachments.length === 0) return null
    // A command is already represented by an execution record. Keep it out of the
    // user-facing transcript even if a page adapter reports it as a normal assistant turn.
    if (role === 'assistant' && isAssistantCommandReply(content)) return null
    const id = randomUUID()
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO conversation_messages
           (id, conversation_id, role, source_message_id, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, conversationId, role, sourceMessageId, content, now)
    if (Number(result.changes) === 0) return null
    if (role === 'user' && attachments.length > 0) this.persistMessageAttachments(id, attachments, now)
    return id
  }

  /** Restore Markdown for a message already captured from this exact page turn. */
  refreshAssistantMessageMarkdown(conversationId: string, sourceMessageId: string, content: string): boolean {
    if (!sourceMessageId || !content.trim() || isAssistantCommandReply(content)) return false
    const result = this.db.prepare(
      `UPDATE conversation_messages
          SET content = ?
        WHERE conversation_id = ? AND role = 'assistant' AND source_message_id = ?
          AND content <> ?
          AND NOT EXISTS (SELECT 1 FROM executions WHERE message_id = ?)`
    ).run(content, conversationId, sourceMessageId, content, sourceMessageId)
    return Number(result.changes) > 0
  }

  private persistMessageAttachments(
    messageId: string,
    attachments: ConversationImageAttachmentInput[],
    now: number
  ): void {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO message_attachments
         (id, message_id, kind, mime_type, file_name, storage_path, sha256, width, height, size_bytes, ordinal, created_at)
       VALUES (?, ?, 'image', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const seenContent = new Set<string>()
    let ordinal = 0
    for (const attachment of attachments) {
      if (!attachment.mimeType.startsWith('image/') || attachment.dataBase64 === '') continue
      const bytes = Buffer.from(attachment.dataBase64, 'base64')
      if (bytes.length === 0 || bytes.length > MAX_ATTACHMENT_BYTES) continue
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const contentHash = this.attachmentContentHash(bytes, sha256)
      if (seenContent.has(contentHash)) continue
      seenContent.add(contentHash)
      const sourceExt = extname(attachment.fileName).toLowerCase()
      const mimeExt: Record<string, string> = {
        'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
        'image/avif': '.avif', 'image/bmp': '.bmp', 'image/svg+xml': '.svg'
      }
      const extension = /^\.[a-z0-9]{1,8}$/.test(sourceExt) ? sourceExt : (mimeExt[attachment.mimeType] ?? '.img')
      const storagePath = `${sha256}${extension}`
      const absolutePath = join(this.attachmentsDir, storagePath)
      if (!existsSync(absolutePath)) writeFileSync(absolutePath, bytes)
      insert.run(randomUUID(), messageId, attachment.mimeType, attachment.fileName || storagePath, storagePath, sha256, attachment.width, attachment.height, bytes.length, ordinal, now)
      ordinal += 1
    }
  }
  listConversationMessages(conversationId: string): Array<{
    id: string
    conversationId: string
    role: 'user' | 'assistant'
    sourceMessageId: string | null
    content: string
    attachments: Array<{
      id: string
      messageId: string
      kind: 'image'
      mimeType: string
      fileName: string
      sha256: string
      width: number | null
      height: number | null
      sizeBytes: number
      ordinal: number
    }>
    createdAt: number
  }> {
    const rows = this.db
      .prepare(
        `SELECT id, conversation_id, role, source_message_id, content, created_at
           FROM conversation_messages
          WHERE conversation_id = ?
            AND NOT EXISTS (
              SELECT 1 FROM executions
               WHERE executions.message_id = conversation_messages.source_message_id
            )
          ORDER BY created_at ASC, rowid ASC`
      )
      .all(conversationId) as unknown as ConversationMessageRow[]
    // Also filter at read time so a long-lived process cannot expose a legacy command row
    // that was written before the startup migration (or by an older running session).
    const visibleRows = rows.filter(
      (row) => row.role !== 'assistant' || !isAssistantCommandReply(row.content)
    )
    const attachmentsForMessage = this.db.prepare(
      `SELECT id, message_id, kind, mime_type, file_name, storage_path, sha256, width, height, size_bytes, ordinal, created_at
         FROM message_attachments
        WHERE message_id = ?
        ORDER BY ordinal ASC`
    )
    return visibleRows.map((row) => {
      const attachmentRows = attachmentsForMessage.all(row.id) as unknown as MessageAttachmentRow[]
      return {
        id: row.id,
        conversationId: row.conversation_id,
        role: row.role,
        sourceMessageId: row.source_message_id,
        content: row.content,
        attachments: attachmentRows.map((attachment) => ({
          id: attachment.id,
          messageId: attachment.message_id,
          kind: attachment.kind,
          mimeType: attachment.mime_type,
          fileName: attachment.file_name,
          sha256: attachment.sha256,
          width: attachment.width,
          height: attachment.height,
          sizeBytes: attachment.size_bytes,
          ordinal: attachment.ordinal
        })),
        createdAt: row.created_at
      }
    })
  }

  readConversationAttachment(attachmentId: string): string | null {
    const row = this.db
      .prepare('SELECT * FROM message_attachments WHERE id = ?')
      .get(attachmentId) as unknown as MessageAttachmentRow | undefined
    if (!row || row.kind !== 'image') return null
    const absolutePath = join(this.attachmentsDir, row.storage_path)
    if (!existsSync(absolutePath)) return null
    const data = readFileSync(absolutePath).toString('base64')
    return `data:${row.mime_type};base64,${data}`
  }
  /** Mark a stored command as finished (or as skipped/blocked). */
  finishExecution(
    messageId: string,
    update: {
      status: ExecutionStatus
      exitCode: number | null
      output: string
      finishedAt: number
    }
  ): void {
    this.db
      .prepare(
        `UPDATE executions
            SET status = ?, exit_code = ?, output = ?, finished_at = ?
          WHERE message_id = ?`
      )
      .run(update.status, update.exitCode, update.output, update.finishedAt, messageId)
  }

  setExecutionStatus(messageId: string, status: ExecutionStatus): void {
    if (status === 'running') {
      this.db
        .prepare('UPDATE executions SET status = ?, started_at = COALESCE(started_at, ?) WHERE message_id = ?')
        .run(status, Date.now(), messageId)
      return
    }
    this.db.prepare('UPDATE executions SET status = ? WHERE message_id = ?').run(status, messageId)
  }

  setFileDeliveryStatus(messageId: string, status: FileDeliveryStatus): void {
    this.db.prepare('UPDATE executions SET delivery_status = ? WHERE message_id = ? AND kind = ?').run(status, messageId, 'read_files')
  }

  getExecution(messageId: string): ExecutionRecord | null {
    const row = this.db
      .prepare('SELECT * FROM executions WHERE message_id = ?')
      .get(messageId) as unknown as ExecutionRow | undefined
    return row ? toExecutionRecord(row) : null
  }

  listExecutions(conversationId: string): ExecutionRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM executions WHERE conversation_id = ? ORDER BY created_at ASC')
      .all(conversationId) as unknown as ExecutionRow[]
    return rows.map(toExecutionRecord)
  }

  /** Every conversation id that has at least one execution row. */
  countExecutions(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM executions').get() as { n: number }
    return row.n
  }

  /* ---------------- ssh hosts ---------------- */

  /** The stored ciphertext, or '' when none. Never sent to the renderer. */
  getSshSecret(id: string): string {
    const row = this.db.prepare('SELECT secret FROM ssh_hosts WHERE id = ?').get(id) as
      | { secret: string }
      | undefined
    return row ? row.secret : ''
  }

  upsertSshHost(host: {
    id: string
    name: string
    host: string
    port: number
    username: string
    proxy: string
    secret: string
  }): void {
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO ssh_hosts (id, name, host, port, username, proxy, secret, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           host = excluded.host,
           port = excluded.port,
           username = excluded.username,
           proxy = excluded.proxy,
           -- An empty incoming secret means "keep what is already stored", so
           -- reconnecting without retyping the password does not erase it.
           secret = CASE WHEN excluded.secret = '' THEN ssh_hosts.secret ELSE excluded.secret END,
           updated_at = excluded.updated_at`
      )
      .run(
        host.id,
        host.name,
        host.host,
        host.port,
        host.username,
        host.proxy,
        host.secret,
        now,
        now
      )
  }

  listSshHosts(): SshHost[] {
    const rows = this.db
      .prepare(
        `SELECT id, name, host, port, username, proxy, secret, updated_at
           FROM ssh_hosts ORDER BY updated_at DESC`
      )
      .all() as unknown as Array<{
      id: string
      name: string
      host: string
      port: number
      username: string
      proxy: string
      secret: string
      updated_at: number
    }>

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      host: row.host,
      port: row.port,
      username: row.username,
      proxy: row.proxy,
      hasPassword: row.secret !== '',
      updatedAt: row.updated_at
    }))
  }

  removeSshHost(id: string): void {
    this.db.prepare("DELETE FROM terminal_directory_notes WHERE machine_scope = 'ssh' AND host_id = ?").run(id)
    this.db.prepare('DELETE FROM ssh_hosts WHERE id = ?').run(id)
  }

  /** Null identifies an unset directory; an explicitly cleared note remains an empty row. */
  getDirectoryNote(scope: 'local' | 'ssh', hostId: string, directory: string): string | null {
    const key = normalizeTerminalNotesDirectory(scope, directory)
    if (!hostId || !key) return null
    const row = this.db.prepare('SELECT note FROM terminal_directory_notes WHERE machine_scope = ? AND host_id = ? AND directory_key = ?')
      .get(scope, hostId, key) as { note: string } | undefined
    return row?.note ?? null
  }

  setDirectoryNote(scope: 'local' | 'ssh', hostId: string, directory: string, note: string): void {
    const key = normalizeTerminalNotesDirectory(scope, directory)
    if (!hostId || !key) throw new Error('当前机器或工作目录尚未确定，无法保存说明。')
    this.db.prepare(`INSERT INTO terminal_directory_notes (machine_scope, host_id, directory_key, note, updated_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(machine_scope, host_id, directory_key)
      DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at`)
      .run(scope, hostId, key, note, Date.now())
  }

  /**
   * The user's note for one host, or '' when there is none.
   *
   * Read and written on its own rather than through `upsertSshHost`: reconnecting
   * must never disturb it, and the connect path has no business touching text the
   * user wrote.
   */
  getSshNote(id: string): string {
    const row = this.db.prepare('SELECT note FROM ssh_hosts WHERE id = ?').get(id) as
      | { note: string }
      | undefined
    return row ? row.note : ''
  }

  setSshNote(id: string, note: string): void {
    this.db.prepare('UPDATE ssh_hosts SET note = ? WHERE id = ?').run(note, id)
  }

  /* ---------------- mysql connections ---------------- */

  /**
   * Every stored connection for one machine, oldest first.
   *
   * `secret` is the ciphertext only. It is decrypted in the session runtime, so the
   * raw value never travels further than it has to.
   */
  listMysqlConnections(scope: string, hostId: string): Array<{
    id: string
    name: string
    host: string
    port: number
    username: string
    secret: string
    database: string
    updatedAt: number
  }> {
    const rows = this.db
      .prepare(
        'SELECT id, name, host, port, username, secret, database, updated_at FROM mysql_connections WHERE machine_scope = ? AND host_id = ? ORDER BY updated_at ASC, id ASC'
      )
      .all(scope, hostId) as unknown as Array<{
      id: string
      name: string
      host: string
      port: number
      username: string
      secret: string
      database: string
      updated_at: number
    }>
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      host: row.host,
      port: row.port,
      username: row.username,
      secret: row.secret,
      database: row.database,
      updatedAt: row.updated_at
    }))
  }

  /**
   * Insert or update one connection.
   *
   * An empty incoming secret means: keep what is already stored, exactly like
   * ssh_hosts. Reopening the form without retyping the password must not erase it.
   * The incoming id is always honoured, so a new row is one the caller already knows
   * the id of and can therefore open a tab on.
   */
  upsertMysqlConnection(record: {
    id: string
    scope: string
    hostId: string
    name: string
    host: string
    port: number
    username: string
    secret: string
    database: string
  }): void {
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO mysql_connections (id, machine_scope, host_id, name, host, port, username, secret, database, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           host = excluded.host,
           port = excluded.port,
           username = excluded.username,
           secret = CASE WHEN excluded.secret = '' THEN mysql_connections.secret ELSE excluded.secret END,
           database = excluded.database,
           updated_at = excluded.updated_at`
      )
      .run(record.id, record.scope, record.hostId, record.name, record.host, record.port, record.username, record.secret, record.database, now)
  }

  removeMysqlConnection(id: string): void {
    this.db.prepare('DELETE FROM mysql_connections WHERE id = ?').run(id)
  }

  /* ---------------- nacos connections ---------------- */

  /** Every stored Nacos console for one machine, oldest first. */
  listNacosConnections(scope: string, hostId: string): Array<{
    id: string
    name: string
    url: string
    namespace: string
    updatedAt: number
  }> {
    const rows = this.db
      .prepare(
        'SELECT id, name, url, namespace, updated_at FROM nacos_connections WHERE machine_scope = ? AND host_id = ? ORDER BY updated_at ASC, id ASC'
      )
      .all(scope, hostId) as unknown as Array<{
      id: string
      name: string
      url: string
      namespace: string
      updated_at: number
    }>
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      url: row.url,
      namespace: row.namespace,
      updatedAt: row.updated_at
    }))
  }

  /** Insert or update one Nacos console. The caller always supplies the id. */
  upsertNacosConnection(record: {
    id: string
    scope: string
    hostId: string
    name: string
    url: string
    namespace: string
  }): void {
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO nacos_connections (id, machine_scope, host_id, name, url, namespace, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           url = excluded.url,
           namespace = excluded.namespace,
           updated_at = excluded.updated_at`
      )
      .run(record.id, record.scope, record.hostId, record.name, record.url, record.namespace, now)
  }

  removeNacosConnection(id: string): void {
    this.db.prepare('DELETE FROM nacos_connections WHERE id = ?').run(id)
  }

  listManagedSessions(): ManagedSessionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, title, url, conversation_id, platform_id, paused, prompt_injection_enabled, local_cwd, ssh_host_id, ssh_attached, ssh_reconnect, ssh_cwd, send_delay_seconds, created_at, updated_at
           FROM managed_sessions ORDER BY created_at ASC`
      )
      .all() as unknown as Array<{
      id: string
      title: string
      url: string
      conversation_id: string | null
      platform_id: string
      paused: number
      prompt_injection_enabled: number
      local_cwd: string
      ssh_host_id: string
      ssh_attached: number
      ssh_reconnect: number
      ssh_cwd: string
      send_delay_seconds: number
      created_at: number
      updated_at: number
    }>

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      url: row.url,
      conversationId: row.conversation_id,
      platformId: row.platform_id,
      paused: row.paused !== 0,
      promptInjectionEnabled: row.prompt_injection_enabled !== 0,
      localCwd: row.local_cwd,
      sshHostId: row.ssh_host_id,
      sshAttached: row.ssh_attached !== 0,
      sshReconnect: row.ssh_reconnect !== 0,
      sshCwd: row.ssh_cwd,
      sendDelaySeconds: row.send_delay_seconds,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }))
  }

  upsertManagedSession(record: Omit<ManagedSessionRecord, 'updatedAt'>): void {
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO managed_sessions (id, title, url, conversation_id, platform_id, paused, prompt_injection_enabled, local_cwd, ssh_host_id, ssh_attached, ssh_reconnect, ssh_cwd, send_delay_seconds, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           url = excluded.url,
           conversation_id = excluded.conversation_id,
           platform_id = excluded.platform_id,
           paused = excluded.paused,
           prompt_injection_enabled = excluded.prompt_injection_enabled,
           local_cwd = excluded.local_cwd,
           ssh_host_id = excluded.ssh_host_id,
           ssh_attached = excluded.ssh_attached,
           ssh_reconnect = excluded.ssh_reconnect,
           ssh_cwd = excluded.ssh_cwd,
           send_delay_seconds = excluded.send_delay_seconds,
           updated_at = excluded.updated_at`
      )
      .run(
        record.id,
        record.title,
        record.url,
        record.conversationId,
        record.platformId,
        record.paused ? 1 : 0,
        record.promptInjectionEnabled ? 1 : 0,
        record.localCwd,
        record.sshHostId,
        record.sshAttached ? 1 : 0,
        record.sshReconnect ? 1 : 0,
        record.sshCwd,
        record.sendDelaySeconds,
        record.createdAt,
        now
      )
  }

  removeManagedSession(id: string): void {
    this.db.prepare('DELETE FROM managed_sessions WHERE id = ?').run(id)
  }
  /* ---------------- settings ---------------- */

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row ? row.value : null
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(key, value)
  }

  close(): void {
    this.db.close()
  }
}
