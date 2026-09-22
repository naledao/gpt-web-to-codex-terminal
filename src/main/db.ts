import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  Conversation,
  ExecutionRecord,
  ExecutionStatus,
  ScrapedConversation,
  SshHost
} from '../shared/types'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT PRIMARY KEY,
  url        TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversations_updated_at
  ON conversations (updated_at DESC);

-- One row per command the model asked for. The primary key is ChatGPT's own
-- assistant message id, which is what makes "运行过的命令不能运行了" survive a
-- restart: a message that already has a row is never executed again.
CREATE TABLE IF NOT EXISTS executions (
  message_id      TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  command         TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL,
  exit_code       INTEGER,
  output          TEXT NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL,
  finished_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_executions_conversation
  ON executions (conversation_id, created_at);

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
-- 'note' is the user's own description of this machine, appended to the prompt
-- whenever this host is the one driving the terminal. It lives here rather than
-- in a table of its own so that deleting a host takes its note with it.
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
`

interface ConversationRow {
  id: string
  url: string
  title: string
  updated_at: number
}

interface ExecutionRow {
  message_id: string
  conversation_id: string
  command: string
  description: string
  status: string
  exit_code: number | null
  output: string
  created_at: number
  finished_at: number | null
}

/** Map a raw SQLite row onto the shared shape. */
function toExecutionRecord(row: ExecutionRow): ExecutionRecord {
  return {
    messageId: row.message_id,
    conversationId: row.conversation_id,
    command: row.command,
    description: row.description,
    status: row.status as ExecutionStatus,
    exitCode: row.exit_code,
    output: row.output,
    createdAt: row.created_at,
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

  constructor(filePath: string) {
    // userData exists once Electron is ready, but be defensive on first run.
    mkdirSync(dirname(filePath), { recursive: true })
    this.db = new DatabaseSync(filePath)
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec(SCHEMA)
    this.migrate()
  }

  /**
   * Add columns that were introduced after a database was first created.
   *
   * `CREATE TABLE IF NOT EXISTS` does nothing at all to an existing table, so a
   * column added to SCHEMA reaches new databases only. Without this, an upgraded
   * install would be missing it and every query touching it would throw.
   */
  private migrate(): void {
    const columns = this.db.prepare('PRAGMA table_info(ssh_hosts)').all() as unknown as Array<{
      name: string
    }>
    if (!columns.some((column) => column.name === 'note')) {
      this.db.exec("ALTER TABLE ssh_hosts ADD COLUMN note TEXT NOT NULL DEFAULT ''")
    }
  }

  /**
   * Insert a conversation, or refresh it if already known.
   *
   * A blank title never overwrites a known one: navigation events fire before
   * the page has a real title, and the sidebar occasionally renders an empty
   * label for a moment.
   */
  upsert(conversation: ScrapedConversation, now = Date.now()): boolean {
    const existing = this.db
      .prepare('SELECT title FROM conversations WHERE id = ?')
      .get(conversation.id) as { title: string } | undefined

    if (!existing) {
      this.db
        .prepare(
          'INSERT INTO conversations (id, url, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
        )
        .run(conversation.id, conversation.url, conversation.title, now, now)
      return true
    }

    const title = conversation.title.trim() === '' ? existing.title : conversation.title
    const unchanged = title === existing.title
    this.db
      .prepare('UPDATE conversations SET url = ?, title = ?, updated_at = ? WHERE id = ?')
      .run(conversation.url, title, unchanged ? now : now, conversation.id)
    return true
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

  list(): Conversation[] {
    const rows = this.db
      .prepare('SELECT id, url, title, updated_at FROM conversations ORDER BY updated_at DESC')
      .all() as unknown as ConversationRow[]

    return rows.map((row) => ({
      id: row.id,
      url: row.url,
      title: row.title,
      updatedAt: row.updated_at
    }))
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id)
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

    const statement = this.db.prepare('DELETE FROM conversations WHERE id = ?')
    for (const row of invalid) statement.run(row.id)
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
    description: string
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
           (message_id, conversation_id, command, description, status, output, created_at)
         VALUES (?, ?, ?, ?, ?, '', ?)`
      )
      .run(
        record.messageId,
        record.conversationId,
        record.command,
        record.description,
        record.status,
        record.createdAt
      )
    return true
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
    this.db.prepare('UPDATE executions SET status = ? WHERE message_id = ?').run(status, messageId)
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
    this.db.prepare('DELETE FROM ssh_hosts WHERE id = ?').run(id)
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
