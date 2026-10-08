// Isolated SQLite fixtures only: no Electron, user database, shell or network.
// Run with Node.js 22.18+ using npm run test:execution-recovery.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  CLOSE_INTERRUPTION_NOTICE, RESTART_INTERRUPTION_NOTICE,
  interruptRunningCommands, recoverInterruptedExecutions
} from '../src/main/execution-recovery.ts'

const schema = `CREATE TABLE executions (
  message_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, command TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'command', delivery_status TEXT,
  status TEXT NOT NULL, exit_code INTEGER, output TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER
)`

function seed(db, id, status, extra = {}) {
  const record = {
    conversationId: 'conversation-a', command: 'original command', kind: 'command',
    deliveryStatus: null, exitCode: null, output: '', createdAt: 10,
    startedAt: status === 'running' ? 20 : null, finishedAt: null, ...extra
  }
  db.prepare('INSERT INTO executions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    id, record.conversationId, record.command, record.kind, record.deliveryStatus,
    status, record.exitCode, record.output, record.createdAt, record.startedAt, record.finishedAt
  )
}

function get(db, id) { return db.prepare('SELECT * FROM executions WHERE message_id = ?').get(id) }
function memory(t) {
  const db = new DatabaseSync(':memory:')
  db.exec(schema)
  t.after(() => db.close())
  return db
}

test('opening persisted running records after a restart interrupts them without losing identity or output', () => {
  const directory = mkdtempSync(join(tmpdir(), 'execution-recovery-'))
  const path = join(directory, 'test.db')
  let db = new DatabaseSync(path)
  try {
    db.exec(schema)
    seed(db, 'interrupted-command', 'running', { output: 'partial output', command: 'long original command' })
    db.close()
    db = new DatabaseSync(path)
    assert.equal(recoverInterruptedExecutions(db, 100), 1)
    const record = get(db, 'interrupted-command')
    assert.equal(record.status, 'interrupted')
    assert.equal(record.exit_code, null)
    assert.equal(record.output, `partial output\n${RESTART_INTERRUPTION_NOTICE}`)
    assert.equal(record.command, 'long original command')
    assert.equal(record.conversation_id, 'conversation-a')
    assert.equal(record.created_at, 10)
    assert.equal(record.started_at, 20)
    assert.equal(record.finished_at, 100)
    db.close()
    db = new DatabaseSync(path)
    assert.equal(get(db, 'interrupted-command').status, 'interrupted')
  } finally {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('startup leaves completed, failed, skipped, interrupted and waiting command records unchanged', (t) => {
  const db = memory(t)
  for (const status of ['done', 'failed', 'timeout', 'skipped', 'interrupted', 'pending', 'blocked']) {
    seed(db, status, status, { output: `output:${status}`, exitCode: status === 'done' ? 0 : null, finishedAt: status === 'pending' || status === 'blocked' ? null : 50 })
  }
  const before = db.prepare('SELECT * FROM executions ORDER BY message_id').all()
  assert.equal(recoverInterruptedExecutions(db, 100), 0)
  assert.deepEqual(db.prepare('SELECT * FROM executions ORDER BY message_id').all(), before)
})

test('recovery covers all conversations and does not append its notice again on subsequent restarts', (t) => {
  const db = memory(t)
  seed(db, 'a', 'running')
  seed(db, 'b', 'running', { conversationId: 'conversation-b' })
  assert.equal(recoverInterruptedExecutions(db, 100), 2)
  const before = db.prepare('SELECT * FROM executions ORDER BY message_id').all()
  assert.equal(recoverInterruptedExecutions(db, 200), 0)
  assert.deepEqual(db.prepare('SELECT * FROM executions ORDER BY message_id').all(), before)
  assert.equal(get(db, 'a').output, RESTART_INTERRUPTION_NOTICE)
})

test('file recovery retains unknown uploads and cancels unsent work without changing finished execution results', (t) => {
  const db = memory(t)
  seed(db, 'reading', 'running', { kind: 'read_files', deliveryStatus: 'pending' })
  seed(db, 'uploading-running', 'running', { kind: 'read_files', deliveryStatus: 'uploading' })
  seed(db, 'uploading-done', 'done', { kind: 'read_files', deliveryStatus: 'uploading', output: 'read result', finishedAt: 50 })
  seed(db, 'unsent', 'done', { kind: 'read_files', deliveryStatus: 'pending', finishedAt: 50 })
  seed(db, 'failed-delivery', 'failed', { kind: 'read_files', deliveryStatus: 'failed', finishedAt: 50 })
  seed(db, 'sent', 'done', { kind: 'read_files', deliveryStatus: 'sent', finishedAt: 50 })
  assert.equal(recoverInterruptedExecutions(db, 100), 2)
  assert.equal(get(db, 'reading').status, 'interrupted')
  assert.equal(get(db, 'reading').delivery_status, 'cancelled')
  assert.equal(get(db, 'uploading-running').delivery_status, 'unknown')
  assert.equal(get(db, 'uploading-done').delivery_status, 'unknown')
  assert.equal(get(db, 'uploading-done').status, 'done')
  assert.equal(get(db, 'uploading-done').output, 'read result')
  assert.equal(get(db, 'uploading-done').finished_at, 50)
  assert.equal(get(db, 'unsent').delivery_status, 'cancelled')
  assert.equal(get(db, 'failed-delivery').delivery_status, 'cancelled')
  assert.equal(get(db, 'sent').delivery_status, 'sent')
})

test('closing one runner interrupts only its active commands and leaves other sessions running', (t) => {
  const db = memory(t)
  seed(db, 'owned', 'running', { output: 'existing output' })
  seed(db, 'other-session', 'running', { conversationId: 'conversation-b' })
  seed(db, 'waiting', 'pending')
  seed(db, 'finished', 'done', { exitCode: 0, output: 'complete output', finishedAt: 50 })
  seed(db, 'files', 'running', { kind: 'read_files', deliveryStatus: 'uploading' })
  const untouched = ['other-session', 'waiting', 'finished', 'files'].map((id) => get(db, id))
  interruptRunningCommands(db, new Set(['owned', 'waiting', 'finished', 'files', 'missing']), 100)
  const record = get(db, 'owned')
  assert.equal(record.status, 'interrupted')
  assert.equal(record.output, `existing output\n${CLOSE_INTERRUPTION_NOTICE}`)
  assert.equal(record.exit_code, null)
  assert.equal(record.finished_at, 100)
  assert.deepEqual(['other-session', 'waiting', 'finished', 'files'].map((id) => get(db, id)), untouched)
})

test('closing repeatedly followed by a restart preserves the original interruption notice and time', (t) => {
  const db = memory(t)
  seed(db, 'owned', 'running')
  interruptRunningCommands(db, ['owned'], 100)
  const record = get(db, 'owned')
  interruptRunningCommands(db, ['owned'], 200)
  assert.equal(recoverInterruptedExecutions(db, 300), 0)
  assert.deepEqual(get(db, 'owned'), record)
  assert.equal(record.output, CLOSE_INTERRUPTION_NOTICE)
})
