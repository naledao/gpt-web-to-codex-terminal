import type { Connection, ResultSetHeader } from 'mysql2/promise'
import type { MysqlRowKey, MysqlRowDeleteResult } from '../shared/types'

export interface MysqlColumnMetadata {
  name: string
  comment: string
  columnKey: string
  tableType: string
  dataType: string
  numericPrecision: number
  numericScale: number
}

type MysqlRowConnection = Pick<Connection, 'query' | 'execute'>
const INTEGER_TYPES = new Set(['tinyint', 'smallint', 'mediumint', 'int', 'bigint', 'year'])
const BINARY_TYPES = new Set(['binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob', 'bit'])

export async function readMysqlColumnMetadata(
  connection: Pick<Connection, 'query'>, database: string, table: string
): Promise<MysqlColumnMetadata[]> {
  const [rows] = await connection.query({
    sql: `SELECT c.COLUMN_NAME AS name, c.COLUMN_COMMENT AS comment, c.COLUMN_KEY AS columnKey,
      c.DATA_TYPE AS dataType, c.NUMERIC_PRECISION AS numericPrecision, c.NUMERIC_SCALE AS numericScale,
      t.TABLE_TYPE AS tableType
      FROM INFORMATION_SCHEMA.COLUMNS c JOIN INFORMATION_SCHEMA.TABLES t
      ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
      WHERE c.TABLE_SCHEMA = ? AND c.TABLE_NAME = ? ORDER BY c.ORDINAL_POSITION`,
    values: [database, table], timeout: 8000
  })
  return (Array.isArray(rows) ? rows as Array<Record<string, unknown>> : []).map((row) => ({
    name: String(row.name ?? ''), comment: String(row.comment ?? ''), columnKey: String(row.columnKey ?? ''),
    tableType: String(row.tableType ?? ''), dataType: String(row.dataType ?? '').toLowerCase(),
    numericPrecision: Number(row.numericPrecision), numericScale: Number(row.numericScale)
  }))
}

export function mysqlRowDeleteUnavailable(metadata: readonly MysqlColumnMetadata[]): string {
  if (metadata.length === 0) return '未读取到表的主键信息，暂不支持删除记录。'
  if (metadata.some((column) => column.tableType !== 'BASE TABLE')) return '视图暂不支持删除记录。'
  if (!metadata.some((column) => column.columnKey === 'PRI')) return '该表没有主键，暂不支持删除记录。'
  if (metadata.some((column) => column.columnKey === 'PRI' && (column.dataType === 'float' || column.dataType === 'double'))) {
    return '浮点主键无法可靠定位记录，暂不支持删除。'
  }
  return ''
}

export function mysqlRowKey(row: Record<string, unknown>, metadata: readonly MysqlColumnMetadata[]): MysqlRowKey | null {
  if (mysqlRowDeleteUnavailable(metadata) !== '') return null
  const key: MysqlRowKey = []
  for (const column of metadata.filter((entry) => entry.columnKey === 'PRI')) {
    const value = row[column.name]
    if (Buffer.isBuffer(value)) key.push({ column: column.name, value: value.toString('hex'), encoding: 'hex' })
    else if (typeof value === 'string') key.push({ column: column.name, value, encoding: 'text' })
    else if (typeof value === 'number' && Number.isFinite(value)
      && (!INTEGER_TYPES.has(column.dataType) || Number.isSafeInteger(value))) {
      key.push({ column: column.name, value: String(value), encoding: 'text' })
    } else return null
  }
  return key
}

function quoteIdentifier(name: string): string {
  if (typeof name !== 'string' || name.trim() === '' || name.includes('\0')) throw new Error('数据库或表名无效。')
  return '`' + name.replace(/`/g, '``') + '`'
}

export function buildMysqlRowDeleteQuery(
  database: string, table: string, key: unknown, metadata: readonly MysqlColumnMetadata[]
): { sql: string; values: Array<string | Buffer> } {
  const unavailable = mysqlRowDeleteUnavailable(metadata)
  if (unavailable) throw new Error(unavailable)
  const primary = metadata.filter((column) => column.columnKey === 'PRI')
  if (!Array.isArray(key) || key.length !== primary.length) throw new Error('删除需要完整的主键，请刷新表数据后重试。')
  const parts = new Map<string, { value: string; encoding: 'text' | 'hex' }>()
  for (const part of key) {
    if (!part || typeof part.column !== 'string' || typeof part.value !== 'string'
      || (part.encoding !== 'text' && part.encoding !== 'hex') || parts.has(part.column)) {
      throw new Error('主键数据无效，请刷新表数据后重试。')
    }
    parts.set(part.column, part)
  }
  const values: Array<string | Buffer> = []
  const conditions = primary.map((column) => {
    const part = parts.get(column.name)
    if (!part) throw new Error('表的主键已变化，请刷新表数据后重试。')
    const identifier = quoteIdentifier(column.name)
    if (BINARY_TYPES.has(column.dataType)) {
      if (part.encoding !== 'hex' || !/^(?:[0-9a-fA-F]{2})*$/.test(part.value)) throw new Error('二进制主键数据无效。')
      if (column.dataType === 'bit') {
        if (part.value.length > 16 || part.value === '') throw new Error('BIT 主键数据无效。')
        values.push(part.value)
        return `${identifier} = CAST(CONV(?, 16, 10) AS UNSIGNED)`
      }
      values.push(Buffer.from(part.value, 'hex'))
      return `${identifier} = ?`
    }
    if (part.encoding !== 'text') throw new Error('主键类型已变化，请刷新表数据后重试。')
    values.push(part.value)
    if (INTEGER_TYPES.has(column.dataType)) {
      if (!/^-?\d+$/.test(part.value)) throw new Error('整数主键数据无效。')
      // Explicit decimal comparison preserves BIGINT identities beyond JavaScript/double precision.
      return `${identifier} = CAST(? AS DECIMAL(65, 0))`
    }
    if (column.dataType === 'decimal') {
      const precision = column.numericPrecision, scale = column.numericScale
      if (!Number.isInteger(precision) || precision < 1 || precision > 65 || !Number.isInteger(scale)
        || scale < 0 || scale > 30 || scale > precision || !/^-?\d+(?:\.\d+)?$/.test(part.value)) {
        throw new Error('DECIMAL 主键数据无效。')
      }
      return `${identifier} = CAST(? AS DECIMAL(${precision}, ${scale}))`
    }
    return `${identifier} = ?`
  })
  return {
    sql: `DELETE FROM ${quoteIdentifier(database)}.${quoteIdentifier(table)} WHERE ${conditions.join(' AND ')} LIMIT 1`,
    values
  }
}

/** Validate against current server metadata; never accept SQL or a WHERE clause from the renderer. */
export async function deleteMysqlRowWithConnection(
  connection: MysqlRowConnection, database: string, table: string, key: unknown
): Promise<MysqlRowDeleteResult> {
  const metadata = await readMysqlColumnMetadata(connection, database, table)
  const query = buildMysqlRowDeleteQuery(database, table, key, metadata)
  const [result] = await connection.execute<ResultSetHeader>({ ...query, timeout: 8000 })
  return result.affectedRows === 1
    ? { ok: true, affectedRows: 1, message: '已删除 1 条记录。' }
    : { ok: false, affectedRows: result.affectedRows, message: '记录已不存在或主键已变化，请刷新表数据。' }
}
