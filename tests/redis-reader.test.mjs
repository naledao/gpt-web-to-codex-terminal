// Offline tests only: every Redis connection is replaced by an in-memory fake.
// Run with Node.js 22.18+ using npm run test:redis. Do not connect to a real server here.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  RedisReader, decodeRedisKey, normalizeRedisDraft, previewRedisValue,
  redisErrorMessage, redisSearchPattern
} from '../src/main/redis-reader.ts'
import { formatRedisJson, mergeRedisEntries } from '../src/shared/redis-display.ts'

const draft = { id: '', name: 'test', host: 'localhost', port: 6379, username: '', password: '', database: 0, tls: false }
const keyId = Buffer.from('test:key').toString('base64')
const buf = (value) => Buffer.from(String(value))

function fixture(overrides = {}) {
  const calls = []
  let options
  let disconnected = 0
  const methods = {
    on: () => {}, connect: async () => {}, disconnect: () => { disconnected += 1 },
    info: async () => '# Cluster\r\ncluster_enabled:0\r\n', ping: async () => 'PONG',
    select: async () => 'OK',
    type: async () => 'string', pttl: async () => -1, ...overrides
  }
  // Unknown methods, including all writes, fail immediately instead of falling back to Redis.
  const client = new Proxy({}, {
    get: (_, property) => {
      if (!(property in methods)) throw new Error(`Unexpected Redis operation: ${String(property)}`)
      return (...args) => { calls.push({ method: property, args }); return methods[property](...args) }
    }
  })
  const reader = new RedisReader((connectionOptions) => { options = connectionOptions; return client })
  return { reader, calls, get options() { return options }, get disconnected() { return disconnected } }
}

test('key search escapes glob syntax and preserves literal substrings', () => {
  assert.equal(redisSearchPattern(' user:*[0]?\\ '), '*user:\\*\\[0\\]\\?\\\\*')
  assert.equal(redisSearchPattern(''), '*')
})

test('binary keys round-trip exactly, including empty keys', () => {
  const binary = Buffer.from([0, 255, 42, 91, 92])
  assert.deepEqual(decodeRedisKey(binary.toString('base64')), binary)
  assert.deepEqual(decodeRedisKey(''), Buffer.alloc(0))
  assert.throws(() => decodeRedisKey('not-base64!'))
})

test('previews respect byte limits without corrupting a partial UTF-8 character', () => {
  const text = buf('你好世界')
  const preview = previewRedisValue(text, 5)
  assert.equal(preview.text, '你')
  assert.equal(preview.encoding, 'text')
  assert.equal(preview.bytes, 12)
  assert.equal(preview.truncated, true)
  assert.equal(previewRedisValue(Buffer.from([0, 255])).encoding, 'hex')
  assert.equal(previewRedisValue(Buffer.alloc(0)).text, '')
})

test('JSON formatting preserves large integers, exponent tokens and duplicate fields', () => {
  const output = formatRedisJson('{"id":9223372036854775807,"n":1e+20,"a":1,"a":2,"text":"a,b:[x]"}')
  assert.ok(output.includes('9223372036854775807'))
  assert.ok(output.includes('1e+20'))
  assert.equal((output.match(/"a":/g) ?? []).length, 2)
  assert.ok(output.includes('"a,b:[x]"'))
  assert.equal(formatRedisJson('not json'), null)
  assert.equal(formatRedisJson(' {"empty":[]} '), '{\n  "empty": []\n}')
})

test('deep JSON remains viewable without excessive indentation or changing its number tokens', () => {
  const raw = '['.repeat(3000) + '9223372036854775807' + ']'.repeat(3000)
  const formatted = formatRedisJson(raw)
  assert.equal(formatted, raw)
  assert.ok(formatted.length < 10000)
})

test('repeated SCAN entries merge without dropping distinct IDs', () => {
  const previous = [{ id: 'a', value: 1 }, { id: 'b', value: 2 }]
  assert.deepEqual(mergeRedisEntries(previous, [{ id: 'a', value: 3 }, { id: 'c', value: 4 }]), [
    { id: 'a', value: 3 }, { id: 'b', value: 2 }, { id: 'c', value: 4 }
  ])
  assert.equal(previous[0].value, 1)
})

test('invalid connection settings fail before any connection is constructed', async () => {
  const fake = fixture()
  assert.throws(() => normalizeRedisDraft({ ...draft, database: -1 }))
  assert.throws(() => normalizeRedisDraft({ ...draft, port: 1.5 }))
  const result = await fake.reader.testConnection({ ...draft, host: '' })
  assert.equal(result.ok, false)
  assert.equal(fake.options, undefined)
})

test('authentication failures disconnect and do not expose server error data', async () => {
  const fake = fixture({ connect: async () => { throw new Error('WRONGPASS secret-password') } })
  const result = await fake.reader.testConnection(draft)
  assert.equal(result.ok, false)
  assert.ok(result.message.includes('认证失败'))
  assert.ok(!result.message.includes('secret-password'))
  assert.equal(fake.disconnected, 1)
})

test('connection options disable reconnects and retain TLS and the selected DB', async () => {
  const fake = fixture()
  assert.equal((await fake.reader.testConnection({ ...draft, tls: true, database: 3 })).ok, true)
  assert.equal(fake.options.db, 0)
  assert.deepEqual(fake.calls.find((call) => call.method === 'select').args, [3])
  assert.deepEqual(fake.options.tls, {})
  assert.equal(fake.options.retryStrategy(), null)
  assert.equal(fake.options.enableOfflineQueue, false)
  assert.equal(fake.disconnected, 1)
})

test('a rejected database selection never falls back to reading DB 0', async () => {
  const fake = fixture({ select: async () => { throw new Error('ERR DB index is out of range') } })
  const result = await fake.reader.scanKeys({ ...draft, database: 999 }, '0', '')
  assert.equal(result.ok, false)
  assert.ok(result.message.includes('数据库编号'))
  assert.ok(!fake.calls.some((call) => call.method === 'scanBuffer'))
  assert.equal(fake.disconnected, 1)
})

test('Cluster is rejected before returning a partial single-node key list', async () => {
  const fake = fixture({ info: async () => 'cluster_enabled:1\r\n' })
  const result = await fake.reader.scanKeys(draft, '0', '')
  assert.equal(result.ok, false)
  assert.ok(result.message.includes('Cluster'))
  assert.ok(!fake.calls.some((call) => call.method === 'scanBuffer'))
})

test('SCAN advances through empty batches, deduplicates binary keys and omits expired keys', async () => {
  const binary = Buffer.from([0, 255])
  let scans = 0
  const fake = fixture({
    scanBuffer: async (cursor) => {
      scans += 1
      if (scans === 1) { assert.equal(cursor, '0'); return [buf('17'), []] }
      assert.equal(cursor, '17')
      return [buf('0'), [buf('live'), buf('live'), binary, buf('expired')]]
    },
    dbsize: async () => { throw new Error('NOPERM') },
    pipeline: () => {
      const operations = []
      const pipeline = {
        type: (key) => { operations.push(['type', key]); return pipeline },
        pttl: (key) => { operations.push(['pttl', key]); return pipeline },
        exec: async () => operations.map(([method, key]) => [null,
          method === 'type' ? key.toString() === 'expired' ? 'none' : 'string' : key.toString() === 'expired' ? -2 : -1])
      }
      return pipeline
    }
  })
  const result = await fake.reader.scanKeys(draft, '0', 'live')
  assert.equal(result.ok, true)
  assert.equal(result.keys.length, 2)
  assert.equal(result.complete, true)
  assert.equal(result.total, null)
  assert.ok(result.keys.some((key) => key.id === binary.toString('base64')))
  assert.equal(fake.disconnected, 1)
})

test('sparse searches stop after bounded work and retain a continuation cursor', async () => {
  let cursor = 0
  const fake = fixture({
    scanBuffer: async () => [buf(++cursor), []], pipeline: () => ({}), dbsize: async () => 50000
  })
  const result = await fake.reader.scanKeys(draft, '0', 'rare-key')
  assert.equal(cursor, 6)
  assert.equal(result.complete, false)
  assert.equal(result.cursor, '6')
})

test('large strings use GETRANGE and report the original size', async () => {
  const fake = fixture({
    strlen: async () => 700000,
    getrangeBuffer: async (_key, start, end) => {
      assert.equal(start, 0); assert.equal(end, 256 * 1024 - 1)
      return Buffer.alloc(end + 1, 65)
    }
  })
  const result = await fake.reader.readKey(draft, keyId, '0')
  assert.equal(result.ok, true)
  assert.equal(result.value.text.length, 256 * 1024)
  assert.equal(result.value.truncated, true)
  assert.equal(result.total, 700000)
  assert.ok(fake.calls.every((call) => ['on', 'connect', 'info', 'type', 'pttl', 'strlen', 'getrangeBuffer', 'disconnect'].includes(call.method)))
})

test('List paging uses one lookahead item and does not omit the next page boundary', async () => {
  const values = Array.from({ length: 200 }, (_, index) => buf(index))
  const fake = fixture({ type: async () => 'list', llen: async () => 200,
    lrangeBuffer: async (_key, start, end) => values.slice(start, end + 1) })
  const first = await fake.reader.readKey(draft, keyId, '0')
  const second = await fake.reader.readKey(draft, keyId, first.nextCursor)
  assert.equal(first.rows.length, 100)
  assert.equal(first.nextCursor, '100')
  assert.equal(second.rows[0].cells[1].text, '100')
  assert.equal(second.rows.length, 100)
  assert.equal(second.nextCursor, null)
})

test('Hash fields retain binary names and a server continuation cursor', async () => {
  const field = Buffer.from([0, 255])
  const fake = fixture({ type: async () => 'hash', hlen: async () => 1000,
    hscanBuffer: async () => [buf('37'), [field, buf('value')]] })
  const result = await fake.reader.readKey(draft, keyId, '0')
  assert.equal(result.rows[0].id, field.toString('base64'))
  assert.equal(result.rows[0].cells[0].encoding, 'hex')
  assert.equal(result.nextCursor, '37')
})

test('Set scanning retains a continuation even when a batch has no members', async () => {
  const fake = fixture({ type: async () => 'set', scard: async () => 1000,
    sscanBuffer: async () => [buf('37'), []] })
  const result = await fake.reader.readKey(draft, keyId, '0')
  assert.equal(result.ok, true)
  assert.equal(result.nextCursor, '37')
  assert.equal(result.rows.length, 0)
})

test('ZSet paging preserves the numeric score text paired with each member', async () => {
  const fake = fixture({ type: async () => 'zset', zcard: async () => 2,
    zrangeBuffer: async () => [buf('member-a'), buf('1.25'), buf('member-b'), buf('-3')] })
  const result = await fake.reader.readKey(draft, keyId, '0')
  assert.equal(result.rows[0].cells[1].text, '1.25')
  assert.equal(result.rows[1].cells[0].text, 'member-b')
  assert.equal(result.nextCursor, null)
})

test('a denied TTL command does not prevent permitted value reads', async () => {
  const fake = fixture({ pttl: async () => { throw new Error('NOPERM') },
    strlen: async () => 1, getrangeBuffer: async () => buf('a') })
  const result = await fake.reader.readKey(draft, keyId, '0')
  assert.equal(result.ok, true)
  assert.equal(result.key.ttl, null)
  assert.equal(result.value.text, 'a')
  assert.ok(result.notice.includes('TTL'))
})

test('Stream continuation skips only its boundary entry, including the valid 0-0 ID', async () => {
  const entries = Array.from({ length: 150 }, (_, index) => [buf(`${index}-0`), [buf('field'), buf(index)]])
  const fake = fixture({ type: async () => 'stream', xlen: async () => 150,
    xrangeBuffer: async (_key, start, _end, _token, count) => entries.slice(start === '-' ? 0 : Number(start.split('-')[0])).slice(0, count) })
  const first = await fake.reader.readKey(draft, keyId, '0')
  const second = await fake.reader.readKey(draft, keyId, first.nextCursor)
  assert.equal(first.rows[0].cells[0].text, '0-0')
  assert.equal(first.nextCursor, '99-0')
  assert.equal(second.rows[0].cells[0].text, '100-0')
  assert.equal(second.rows.length, 50)
  assert.equal(second.nextCursor, null)
})

test('a key disappearing before reading returns an explicit expiration notice', async () => {
  const fake = fixture({ type: async () => 'none', pttl: async () => -2 })
  const result = await fake.reader.readKey(draft, keyId, '0')
  assert.equal(result.ok, true)
  assert.ok(result.notice.includes('过期'))
  assert.equal(result.value, null)
})

test('a type change during reading discards the mixed snapshot', async () => {
  let reads = 0
  const fake = fixture({ type: async () => ++reads === 1 ? 'string' : 'list',
    strlen: async () => 1, getrangeBuffer: async () => buf('a') })
  const result = await fake.reader.readKey(draft, keyId, '0')
  assert.equal(result.ok, false)
  assert.equal(result.value, null)
})

test('unsupported module types show metadata without attempting generic commands', async () => {
  const fake = fixture({ type: async () => 'ReJSON-RL' })
  const result = await fake.reader.readKey(draft, keyId, '0')
  assert.equal(result.ok, true)
  assert.ok(result.notice.includes('ReJSON-RL'))
})

test('disposing a reader prevents any new connections', async () => {
  const fake = fixture()
  fake.reader.dispose()
  assert.equal((await fake.reader.testConnection(draft)).ok, false)
  assert.equal(fake.options, undefined)
  assert.ok(!redisErrorMessage(new Error('ERR contains confidential data')).includes('confidential'))
})
