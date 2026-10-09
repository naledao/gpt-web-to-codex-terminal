// User-run fixtures only: fake MySQL connection, no Electron, database or network.
// node --experimental-strip-types --test tests/mysql-table-rows.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildMysqlRowDeleteQuery,
  deleteMysqlRowWithConnection,
  mysqlRowDeleteUnavailable,
  mysqlRowKey
} from '../src/main/mysql-table-rows.ts'

function column(name = 'id', extra = {}) {
  return {
    name, comment: '', columnKey: 'PRI', tableType: 'BASE TABLE', dataType: 'bigint',
    numericPrecision: 20, numericScale: 0, ...extra
  }
}
const key = (value, name = 'id', encoding = 'text') => ({ column: name, value, encoding })

function fakeConnection(metadata, affectedRows = 1) {
  const writes = [], reads = []
  return {
    reads, writes,
    async query(options) { reads.push(options); return [metadata, []] },
    async execute(options) { writes.push(options); return [{ affectedRows }, []] }
  }
}

test('a selected integer primary key always produces a bounded parameterized delete', () => {
  const query = buildMysqlRowDeleteQuery('app', 'items', [key('13')], [column()])
  assert.equal(query.sql, 'DELETE FROM `app`.`items` WHERE `id` = CAST(? AS DECIMAL(65, 0)) LIMIT 1')
  assert.deepEqual(query.values, ['13'])
})

test('all composite-key parts are required and matched by column, regardless of renderer order', () => {
  const metadata = [column('tenant_id'), column('code', { dataType: 'varchar' })]
  const query = buildMysqlRowDeleteQuery('app', 'items', [key('MT053', 'code'), key('1', 'tenant_id')], metadata)
  assert.deepEqual(query.values, ['1', 'MT053'])
  assert.match(query.sql, /`tenant_id` = CAST\(\? AS DECIMAL\(65, 0\)\) AND `code` = \? LIMIT 1$/)
  for (const incomplete of [[], [key('1', 'tenant_id')], [key('1', 'tenant_id'), key('13', 'id')]]) {
    assert.throws(() => buildMysqlRowDeleteQuery('app', 'items', incomplete, metadata), /主键/)
  }
})

test('BIGINT, DECIMAL and timestamp identities retain exact text and precision', () => {
  const metadata = [column('id'), column('price', { dataType: 'decimal', numericPrecision: 65, numericScale: 30 }), column('created', { dataType: 'datetime' })]
  const row = { id: '18446744073709551615', price: '123456789012345678901234567890.123456789012345678901234567890', created: '2026-10-09 13:12:38.123456' }
  const identity = mysqlRowKey(row, metadata)
  assert.deepEqual(identity.map((part) => part.value), [row.id, row.price, row.created])
  const query = buildMysqlRowDeleteQuery('app', 'items', identity, metadata)
  assert.deepEqual(query.values, [row.id, row.price, row.created])
  assert.match(query.sql, /DECIMAL\(65, 30\)/)
})

test('binary keys keep exact bytes and never use the byte-count placeholder', () => {
  const metadata = [column('token', { dataType: 'binary' })]
  const bytes = Buffer.from([0, 255, 39, 92])
  const identity = mysqlRowKey({ token: bytes }, metadata)
  assert.deepEqual(identity, [key('00ff275c', 'token', 'hex')])
  assert.deepEqual(buildMysqlRowDeleteQuery('app', 'items', identity, metadata).values, [bytes])
  for (const value of ['<4 bytes>', 'f', 'zz']) {
    assert.throws(() => buildMysqlRowDeleteQuery('app', 'items', [key(value, 'token', 'hex')], metadata), /二进制/)
  }
  assert.throws(() => buildMysqlRowDeleteQuery('app', 'items', [key('<4 bytes>', 'token')], metadata), /二进制/)
})

test('BIT primary keys use their unsigned integer value without binary-string coercion', () => {
  const metadata = [column('flags', { dataType: 'bit' })]
  const identity = mysqlRowKey({ flags: Buffer.from('ffffffffffffffff', 'hex') }, metadata)
  const query = buildMysqlRowDeleteQuery('app', 'items', identity, metadata)
  assert.deepEqual(query.values, ['ffffffffffffffff'])
  assert.match(query.sql, /CAST\(CONV\(\?, 16, 10\) AS UNSIGNED\)/)
})

test('identifiers are quoted and a SQL-shaped key remains a bound value', () => {
  const payload = "' OR 1=1; DELETE FROM other; --"
  const metadata = [column('co`de', { dataType: 'varchar' })]
  const query = buildMysqlRowDeleteQuery('db`name', 'table`name', [key(payload, 'co`de')], metadata)
  assert.equal(query.sql, 'DELETE FROM `db``name`.`table``name` WHERE `co``de` = ? LIMIT 1')
  assert.deepEqual(query.values, [payload])
  assert.throws(() => buildMysqlRowDeleteQuery('', 'items', [key('13')], [column()]), /无效/)
})

test('missing, duplicate, extra and malformed key parts fail closed', () => {
  for (const malformed of [null, {}, [], [null], [key(null)], [key('13', 'another')], [key('13'), key('14')], [key('1 OR 1=1')], [key('13', 'id', 'sql')]]) {
    assert.throws(() => buildMysqlRowDeleteQuery('app', 'items', malformed, [column()]))
  }
  const metadata = [column('id'), column('tenant_id')]
  assert.throws(() => buildMysqlRowDeleteQuery('app', 'items', [key('13'), key('14')], metadata), /无效/)
})

test('views, tables without a primary key and floating keys disable deletion', () => {
  for (const metadata of [[], [column('id', { columnKey: '' })], [column('id', { tableType: 'VIEW' })], [column('id', { dataType: 'float' })], [column('id', { dataType: 'double' })]]) {
    assert.notEqual(mysqlRowDeleteUnavailable(metadata), '')
    assert.equal(mysqlRowKey({ id: '13' }, metadata), null)
    assert.throws(() => buildMysqlRowDeleteQuery('app', 'items', [key('13')], metadata))
  }
})

test('null, missing or already-rounded integer identities cannot enable deletion', () => {
  for (const row of [{}, { id: null }, { id: undefined }, { id: {} }, { id: 9007199254740992 }]) {
    assert.equal(mysqlRowKey(row, [column()]), null)
  }
  assert.deepEqual(mysqlRowKey({ id: 13 }, [column()]), [key('13')])
})

test('server metadata is checked immediately before exactly one prepared delete', async () => {
  const connection = fakeConnection([column()])
  const result = await deleteMysqlRowWithConnection(connection, 'app', 'items', [key('13')])
  assert.deepEqual(result, { ok: true, affectedRows: 1, message: '已删除 1 条记录。' })
  assert.equal(connection.reads.length, 1)
  assert.deepEqual(connection.reads[0].values, ['app', 'items'])
  assert.equal(connection.writes.length, 1)
  assert.deepEqual(connection.writes[0].values, ['13'])
  assert.match(connection.writes[0].sql, /WHERE .* LIMIT 1$/)
})

test('a changed primary key or metadata failure never reaches the write operation', async () => {
  const changed = fakeConnection([column('new_id')])
  await assert.rejects(deleteMysqlRowWithConnection(changed, 'app', 'items', [key('13')]), /主键/)
  assert.equal(changed.writes.length, 0)
  const unavailable = fakeConnection([column()])
  unavailable.query = async () => { throw new Error('metadata permission denied') }
  await assert.rejects(deleteMysqlRowWithConnection(unavailable, 'app', 'items', [key('13')]), /permission/)
  assert.equal(unavailable.writes.length, 0)
})

test('zero affected rows reports a stale selection; permission/FK failures are never retried', async () => {
  const missing = fakeConnection([column()], 0)
  assert.equal((await deleteMysqlRowWithConnection(missing, 'app', 'items', [key('13')])).ok, false)
  assert.equal(missing.writes.length, 1)
  for (const code of ['ER_ROW_IS_REFERENCED_2', 'ER_TABLEACCESS_DENIED_ERROR', 'PROTOCOL_CONNECTION_LOST']) {
    const connection = fakeConnection([column()])
    connection.execute = async (options) => {
      connection.writes.push(options)
      throw Object.assign(new Error(code), { code })
    }
    await assert.rejects(deleteMysqlRowWithConnection(connection, 'app', 'items', [key('13')]), { code })
    assert.equal(connection.writes.length, 1)
  }
})
