// Pure ordering/storage fixtures only; no Electron, live MySQL or user storage.
// User-run command: node --experimental-strip-types --test tests/mysql-table-history.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MYSQL_TABLE_HISTORY_STORAGE_KEY,
  mysqlTableVisitScope,
  readMysqlTableVisitHistory,
  recordMysqlTableVisit,
  renameMysqlTableVisitConnection,
  sortMysqlTablesByVisits,
  writeMysqlTableVisitHistory
} from '../src/renderer/src/mysql-table-history.ts'

const connection = { host: 'db.example', port: 3306, username: 'reader', password: 'must-not-be-stored' }
const scope = mysqlTableVisitScope('connection-a', connection, 'app')
const tables = ['alpha', 'beta', 'gamma', 'delta'].map((name) => ({ name, comment: `${name} table` }))
const names = (list) => list.map((table) => table.name)

function memoryStorage(raw = null) {
  const items = new Map(raw === null ? [] : [[MYSQL_TABLE_HISTORY_STORAGE_KEY, raw]])
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => items.set(key, value)
  }
}

test('the newest visit leads, revisiting moves the table ahead without duplicates', () => {
  let history = recordMysqlTableVisit({}, scope, 'beta')
  history = recordMysqlTableVisit(history, scope, 'delta')
  history = recordMysqlTableVisit(history, scope, 'beta')
  assert.deepEqual(history[scope], ['beta', 'delta'])
  assert.deepEqual(names(sortMysqlTablesByVisits(tables, history[scope])), ['beta', 'delta', 'alpha', 'gamma'])
  assert.equal(recordMysqlTableVisit(history, scope, 'beta'), history)
})

test('unvisited tables retain their source order and sorting never mutates the response', () => {
  const response = Object.freeze([...tables])
  assert.deepEqual(names(sortMysqlTablesByVisits(response, [])), names(tables))
  assert.deepEqual(names(sortMysqlTablesByVisits(response, ['removed-table', 'gamma'])), ['gamma', 'alpha', 'beta', 'delta'])
  assert.deepEqual(names(response), ['alpha', 'beta', 'gamma', 'delta'])
})

test('filtered matches keep recent-first order with names or comments as search terms', () => {
  const response = [
    { name: 'account', comment: '业务表' },
    { name: 'account_log', comment: '日志' },
    { name: 'team', comment: '业务表' }
  ]
  const recent = ['team', 'account_log', 'account']
  assert.deepEqual(names(sortMysqlTablesByVisits(response.filter((table) => table.name.includes('account')), recent)), ['account_log', 'account'])
  assert.deepEqual(names(sortMysqlTablesByVisits(response.filter((table) => table.comment.includes('业务')), recent)), ['team', 'account'])
})

test('connection, server, user and database each isolate the visit order', () => {
  const otherScopes = [
    mysqlTableVisitScope('connection-b', connection, 'app'),
    mysqlTableVisitScope('connection-a', connection, 'other'),
    mysqlTableVisitScope('connection-a', { ...connection, host: 'other.example' }, 'app'),
    mysqlTableVisitScope('connection-a', { ...connection, port: 3307 }, 'app'),
    mysqlTableVisitScope('connection-a', { ...connection, username: 'another' }, 'app')
  ]
  let history = recordMysqlTableVisit({}, scope, 'delta')
  for (const other of otherScopes) history = recordMysqlTableVisit(history, other, 'alpha')
  assert.deepEqual(history[scope], ['delta'])
  for (const other of otherScopes) assert.deepEqual(history[other], ['alpha'])
  assert.equal(mysqlTableVisitScope('connection-a', { ...connection, host: ' DB.EXAMPLE ', username: ' reader ' }, ' app '), scope)
  assert.notEqual(mysqlTableVisitScope('connection-a', connection, 'APP'), scope)
})

test('persisted visits survive reloading and contain no password or row contents', () => {
  const storage = memoryStorage()
  let history = recordMysqlTableVisit({}, scope, 'delta')
  history = recordMysqlTableVisit(history, scope, 'beta')
  assert.equal(writeMysqlTableVisitHistory(history, storage), true)
  const reloaded = readMysqlTableVisitHistory(storage)
  assert.deepEqual(reloaded, history)
  assert.deepEqual(names(sortMysqlTablesByVisits(tables, reloaded[scope])), ['beta', 'delta', 'alpha', 'gamma'])
  assert.equal(storage.getItem(MYSQL_TABLE_HISTORY_STORAGE_KEY).includes(connection.password), false)
})

test('missing or malformed storage is safe; malformed entries and duplicates are discarded', () => {
  assert.deepEqual(readMysqlTableVisitHistory(memoryStorage()), {})
  for (const raw of ['broken json', 'null', '[]', '42']) assert.equal(readMysqlTableVisitHistory(memoryStorage(raw)), null)
  const storage = memoryStorage(JSON.stringify({ [scope]: ['beta', null, 123, '', 'beta', 'delta'], invalid: 'not an array' }))
  assert.deepEqual(readMysqlTableVisitHistory(storage), { [scope]: ['beta', 'delta'] })
})

test('blocked storage reports failure without throwing or changing the in-memory history', () => {
  const storage = {
    getItem() { throw new Error('storage blocked') },
    setItem() { throw new Error('storage full') }
  }
  const history = recordMysqlTableVisit({}, scope, 'gamma')
  assert.equal(readMysqlTableVisitHistory(storage), null)
  assert.equal(writeMysqlTableVisitHistory(history, storage), false)
  assert.deepEqual(history[scope], ['gamma'])
})

test('the first save keeps visits from all databases and leaves other connections intact', () => {
  const draftApp = mysqlTableVisitScope('new:1', connection, 'app')
  const draftOther = mysqlTableVisitScope('new:1', connection, 'other')
  const savedApp = mysqlTableVisitScope('saved-id', connection, 'app')
  const savedOther = mysqlTableVisitScope('saved-id', connection, 'other')
  const unrelated = mysqlTableVisitScope('connection-b', connection, 'app')
  const history = { [draftApp]: ['delta', 'beta'], [draftOther]: ['gamma'], [unrelated]: ['alpha'] }
  const next = renameMysqlTableVisitConnection(history, 'new:1', 'saved-id')
  assert.deepEqual(next, { [savedApp]: ['delta', 'beta'], [savedOther]: ['gamma'], [unrelated]: ['alpha'] })
  assert.deepEqual(history[draftApp], ['delta', 'beta'])
  const storage = memoryStorage()
  writeMysqlTableVisitHistory(next, storage)
  assert.deepEqual(readMysqlTableVisitHistory(storage), next)
})
