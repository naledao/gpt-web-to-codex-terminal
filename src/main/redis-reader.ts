import Redis from 'ioredis'
import type { RedisOptions } from 'ioredis'
import type {
  RedisConnectionDraft, RedisConnectionResult, RedisKeyData, RedisKeyInfo,
  RedisKeyPage, RedisValueCell
} from '../shared/types'

const PAGE_SIZE = 100
const STRING_PREVIEW_BYTES = 256 * 1024
const CELL_PREVIEW_BYTES = 4096
const REQUEST_TIMEOUT_MS = 12000

export function normalizeRedisDraft(draft: RedisConnectionDraft): RedisConnectionDraft {
  const host = String(draft?.host ?? '').trim()
  const port = Number(draft?.port)
  const database = Number(draft?.database)
  if (!host) throw new Error('请先填写 Redis 主机地址。')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须是 1 到 65535 的整数。')
  if (!Number.isInteger(database) || database < 0 || database > 2147483647) throw new Error('数据库编号必须是非负整数。')
  return {
    id: String(draft?.id ?? ''), name: String(draft?.name ?? '').trim(), host, port,
    username: String(draft?.username ?? '').trim(), password: String(draft?.password ?? ''),
    database, tls: Boolean(draft?.tls)
  }
}

/** Search is a literal substring, including Redis glob metacharacters. */
export function redisSearchPattern(search: string): string {
  return `*${String(search ?? '').trim().replace(/[\\*?\[\]]/g, '\\$&')}*`
}

export function previewRedisValue(value: Buffer, limit = CELL_PREVIEW_BYTES, totalBytes = value.length): RedisValueCell {
  const sample = value.subarray(0, limit)
  const truncated = totalBytes > sample.length
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(sample, { stream: truncated })
    // Control characters make serialized/binary values unreadable as plain text.
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) throw new Error('binary')
    return { text, encoding: 'text', bytes: totalBytes, truncated }
  } catch {
    return { text: sample.toString('hex'), encoding: 'hex', bytes: totalBytes, truncated }
  }
}

export function redisKeyName(key: Buffer): string {
  const value = previewRedisValue(key, CELL_PREVIEW_BYTES)
  return (value.encoding === 'hex' ? `0x${value.text}` : value.text) + (value.truncated ? '…' : '')
}

export function decodeRedisKey(id: string): Buffer {
  if (typeof id !== 'string' || id.length > 90000) throw new Error('键名无效或过长。')
  const key = Buffer.from(id, 'base64')
  if (key.toString('base64') !== id) throw new Error('键名编码无效。')
  return key
}

function scanCursor(cursor: string): string {
  if (typeof cursor !== 'string' || !/^\d{1,20}$/.test(cursor)) throw new Error('扫描游标无效，请刷新列表。')
  return cursor
}

function offsetCursor(cursor: string): number {
  scanCursor(cursor)
  const offset = Number(cursor)
  if (!Number.isSafeInteger(offset)) throw new Error('数据偏移量无效，请刷新。')
  return offset
}

export function redisErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  if (/WRONGPASS|NOAUTH|AUTH.*password/i.test(message)) return '认证失败，请检查用户名和密码。'
  if (/NOPERM/i.test(message)) return '当前 Redis 账号没有读取此数据所需的权限。'
  if (/ECONNREFUSED/i.test(message)) return '连接被拒绝，请检查主机、端口和 Redis 服务。'
  if (/ENOTFOUND|EAI_AGAIN/i.test(message)) return '无法解析主机地址。'
  if (/timeout|ETIMEDOUT/i.test(message)) return '读取超时，请检查网络或稍后重试。'
  if (/certificate|TLS|SSL/i.test(message)) return 'TLS 连接失败，请检查服务器证书和 TLS 设置。'
  if (/DB index|invalid DB/i.test(message)) return '数据库编号超出服务器范围。'
  if (/MOVED|ASK |cluster/i.test(message)) return '此版本支持单机 Redis 直连，暂不支持 Redis Cluster。'
  if (/WRONGTYPE/i.test(message)) return '键的数据类型已经改变，请刷新后重试。'
  // Only local validation messages are echoed. Server errors can include user data.
  if (/^(请先填写|端口必须|数据库编号必须|键名|扫描游标|数据偏移量|Stream 游标|键的数据)/.test(message)) return message
  return '连接或读取失败，请检查连接设置后重试。'
}

export function emptyRedisKeyPage(message = ''): RedisKeyPage {
  return { ok: false, keys: [], cursor: '0', complete: true, total: null, message, notice: '' }
}

export function emptyRedisKeyData(message = ''): RedisKeyData {
  return { ok: false, key: null, columns: [], rows: [], value: null, total: null, nextCursor: null, message, notice: '' }
}

/** A fixed read API. No arbitrary commands or data mutation methods cross IPC. */
export class RedisReader {
  private readonly clients = new Set<Redis>()
  private disposed = false
  private readonly createClient: (options: RedisOptions) => Redis

  constructor(createClient: (options: RedisOptions) => Redis = (options) => new Redis(options)) {
    this.createClient = createClient
  }

  private async withClient<T>(draft: RedisConnectionDraft, read: (client: Redis) => Promise<T>): Promise<T> {
    if (this.disposed) throw new Error('连接已关闭。')
    const connection = normalizeRedisDraft(draft)
    const client = this.createClient({
      host: connection.host, port: connection.port, username: connection.username || undefined,
      password: connection.password || undefined, db: 0,
      tls: connection.tls ? {} : undefined, lazyConnect: true, enableReadyCheck: false,
      enableOfflineQueue: false, connectTimeout: 5000, commandTimeout: 5000,
      retryStrategy: () => null, maxRetriesPerRequest: 0, autoResendUnfulfilledCommands: false,
      disableClientInfo: true
    })
    let connectionError: Error | null = null
    client.on('error', (error: Error) => { connectionError = error })
    this.clients.add(client)
    let timer: ReturnType<typeof setTimeout> | undefined
    const operation = async (): Promise<T> => {
      try { await client.connect() } catch (error) { throw connectionError ?? error }
      // Detect Cluster where INFO is allowed, so a single node cannot masquerade as the full DB.
      let clusterInfo = ''
      try { clusterInfo = await client.info('cluster') } catch (error) {
        if (!(error instanceof Error) || !/NOPERM/i.test(error.message)) throw error
      }
      if (/cluster_enabled:1/.test(clusterInfo)) throw new Error('Redis Cluster is not supported')
      // ioredis' automatic SELECT only emits an error on failure. Await it explicitly
      // before reading, so an invalid DB cannot silently show DB 0's data.
      if (connection.database !== 0) await client.select(connection.database)
      return read(client)
    }
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Redis request timeout')), REQUEST_TIMEOUT_MS)
        })
      ])
    } finally {
      clearTimeout(timer)
      client.disconnect(false)
      this.clients.delete(client)
    }
  }

  async testConnection(draft: RedisConnectionDraft): Promise<RedisConnectionResult> {
    try {
      await this.withClient(draft, async (client) => { await client.ping() })
      return { ok: true, message: '连接成功。' }
    } catch (error) { return { ok: false, message: redisErrorMessage(error) } }
  }

  async scanKeys(draft: RedisConnectionDraft, cursor: string, search: string): Promise<RedisKeyPage> {
    try {
      const start = scanCursor(cursor)
      if (typeof search !== 'string' || search.length > 1024) throw new Error('键名搜索词过长。')
      return await this.withClient(draft, async (client) => {
        const unique = new Map<string, Buffer>()
        let next = start
        // Sparse matches can return empty batches. Continue for a bounded amount of work.
        for (let batch = 0; batch < 6; batch += 1) {
          const [position, keys] = await client.scanBuffer(next, 'MATCH', redisSearchPattern(search), 'COUNT', PAGE_SIZE)
          next = position.toString()
          for (const key of keys) unique.set(key.toString('base64'), key)
          if (next === '0' || unique.size >= PAGE_SIZE) break
        }
        const rawKeys = [...unique.values()]
        const pipeline = client.pipeline()
        for (const key of rawKeys) { pipeline.type(key); pipeline.pttl(key) }
        const replies = rawKeys.length ? await pipeline.exec() : []
        let notice = ''
        const keys: RedisKeyInfo[] = rawKeys.map((key, index) => {
          const typeReply = replies?.[index * 2]
          const ttlReply = replies?.[index * 2 + 1]
          if (!typeReply || !ttlReply || typeReply[0] || ttlReply[0]) notice = '部分键的类型或过期时间无法读取，请检查账号权限。'
          return {
            id: key.toString('base64'), name: redisKeyName(key),
            type: typeReply && !typeReply[0] ? String(typeReply[1]) : 'unknown',
            ttl: ttlReply && !ttlReply[0] ? Number(ttlReply[1]) : null
          }
        }).filter((key) => key.type !== 'none' && key.ttl !== -2)
        let total: number | null = null
        try { total = await client.dbsize() } catch { /* Key browsing also works without DBSIZE permission. */ }
        return { ok: true, keys, cursor: next, complete: next === '0', total, message: '', notice }
      })
    } catch (error) { return emptyRedisKeyPage(redisErrorMessage(error)) }
  }

  async readKey(draft: RedisConnectionDraft, keyId: string, cursor: string): Promise<RedisKeyData> {
    try {
      const key = decodeRedisKey(keyId)
      return await this.withClient(draft, async (client) => {
        const type = await client.type(key)
        let ttl: number | null = null
        let ttlNotice = ''
        try { ttl = await client.pttl(key) } catch (error) {
          if (!(error instanceof Error) || !/NOPERM/i.test(error.message)) throw error
          ttlNotice = '账号无权读取 TTL，已显示可读取的数据。'
        }
        const info: RedisKeyInfo = { id: keyId, name: redisKeyName(key), type, ttl }
        const data: RedisKeyData = { ...emptyRedisKeyData(), ok: true, key: info }
        const cell = (value: Buffer | string | number): RedisValueCell => previewRedisValue(
          Buffer.isBuffer(value) ? value : Buffer.from(String(value))
        )
        const size = async (read: () => Promise<number>): Promise<number | null> => {
          try { return await read() } catch (error) {
            if (error instanceof Error && /NOPERM/i.test(error.message)) return null
            throw error
          }
        }
        if (type === 'none' || ttl === -2) return { ...data, notice: '这个键已过期或被删除，请刷新键列表。' }
        switch (type) {
          case 'string': {
            const length = await client.strlen(key)
            const value = await client.getrangeBuffer(key, 0, STRING_PREVIEW_BYTES - 1)
            data.total = length
            data.value = previewRedisValue(value, STRING_PREVIEW_BYTES, length)
            if (data.value.truncated) data.notice = '字符串仅预览前 256 KiB。'
            break
          }
          case 'hash': {
            const [next, fields] = await client.hscanBuffer(key, scanCursor(cursor), 'COUNT', PAGE_SIZE)
            data.columns = ['字段', '值']
            data.total = await size(() => client.hlen(key))
            for (let index = 0; index < fields.length; index += 2) {
              data.rows.push({ id: fields[index].toString('base64'), cells: [cell(fields[index]), cell(fields[index + 1])] })
            }
            data.nextCursor = next.toString() === '0' ? null : next.toString()
            break
          }
          case 'set': {
            const [next, members] = await client.sscanBuffer(key, scanCursor(cursor), 'COUNT', PAGE_SIZE)
            data.columns = ['成员']
            data.total = await size(() => client.scard(key))
            data.rows = members.map((member) => ({ id: member.toString('base64'), cells: [cell(member)] }))
            data.nextCursor = next.toString() === '0' ? null : next.toString()
            break
          }
          case 'list':
          case 'zset': {
            const offset = offsetCursor(cursor)
            const values = type === 'list'
              ? await client.lrangeBuffer(key, offset, offset + PAGE_SIZE)
              : await client.zrangeBuffer(key, offset, offset + PAGE_SIZE, 'WITHSCORES')
            const stride = type === 'list' ? 1 : 2
            const count = values.length / stride
            data.columns = type === 'list' ? ['索引', '值'] : ['成员', '分数']
            data.total = await size(() => type === 'list' ? client.llen(key) : client.zcard(key))
            for (let index = 0; index < Math.min(PAGE_SIZE, count); index += 1) {
              data.rows.push({
                id: String(offset + index),
                cells: type === 'list' ? [cell(offset + index), cell(values[index])]
                  : [cell(values[index * 2]), cell(values[index * 2 + 1])]
              })
            }
            data.nextCursor = count > PAGE_SIZE ? String(offset + PAGE_SIZE) : null
            break
          }
          case 'stream': {
            if (cursor !== '0' && !/^\d+-\d+$/.test(cursor)) throw new Error('Stream 游标无效，请刷新。')
            const entries = await client.xrangeBuffer(key, cursor === '0' ? '-' : cursor, '+', 'COUNT', PAGE_SIZE + 2)
            const next = entries.filter(([id]) => id.toString() !== cursor)
            data.columns = ['消息 ID', '字段', '值']
            data.total = await size(() => client.xlen(key))
            for (const [id, fields] of next.slice(0, PAGE_SIZE)) {
              for (let index = 0; index < fields.length; index += 2) {
                data.rows.push({ id: `${id.toString()}:${index}`, cells: [cell(id), cell(fields[index]), cell(fields[index + 1])] })
              }
            }
            data.nextCursor = next.length > PAGE_SIZE ? next[PAGE_SIZE - 1][0].toString() : null
            break
          }
          default:
            data.notice = `暂不支持展开 ${type} 类型，当前仅展示键的类型和过期时间。`
        }
        if (await client.type(key) !== type) throw new Error('键的数据类型已经改变，请刷新后重试。')
        if (data.rows.some((row) => row.cells.some((value) => value.truncated))) {
          data.notice = '较长的字段或成员仅预览前 4 KiB。'
        }
        data.notice = [data.notice, ttlNotice].filter(Boolean).join(' ')
        return data
      })
    } catch (error) { return emptyRedisKeyData(redisErrorMessage(error)) }
  }

  dispose(): void {
    this.disposed = true
    for (const client of this.clients) client.disconnect(false)
    this.clients.clear()
  }
}
