import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatMysqlCell } from '../src/main/mysql-field-value.ts'

test('BIT(1) displays 0 or 1', () => {
  const field = { columnType: 16, columnLength: 1 }
  assert.equal(formatMysqlCell(Buffer.from([0]), field), '0')
  assert.equal(formatMysqlCell(Buffer.from([1]), field), '1')
})

test('other binary columns keep their byte-count placeholder', () => {
  assert.equal(formatMysqlCell(Buffer.from([1]), { columnType: 16, columnLength: 8 }), '<1 bytes>')
  assert.equal(formatMysqlCell(Buffer.from([1]), { columnType: 252, columnLength: 1 }), '<1 bytes>')
})

test('normal values and NULL retain their original representation', () => {
  assert.equal(formatMysqlCell(null), null)
  assert.equal(formatMysqlCell('hello'), 'hello')
  assert.equal(formatMysqlCell(12), '12')
})
