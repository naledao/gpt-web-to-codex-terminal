export type MysqlTableVisitHistory = Record<string, string[]>

export const MYSQL_TABLE_HISTORY_STORAGE_KEY = 'mysql.tableVisits.v1'

type HistoryStorage = Pick<Storage, 'getItem' | 'setItem'>

interface TableConnection {
  host: string
  port: number
  username: string
}

/** Keep connections/databases separate, including a saved connection retargeted to another server. */
export function mysqlTableVisitScope(connectionId: string, connection: TableConnection, database: string): string {
  return JSON.stringify([
    connectionId,
    connection.host.trim().toLowerCase(),
    connection.port,
    connection.username.trim(),
    database.trim()
  ])
}

export function readMysqlTableVisitHistory(storage?: HistoryStorage): MysqlTableVisitHistory | null {
  try {
    const raw = (storage ?? window.localStorage).getItem(MYSQL_TABLE_HISTORY_STORAGE_KEY)
    if (raw === null) return {}
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    return Object.fromEntries(
      Object.entries(value)
        .filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]))
        .map(([scope, names]) => [scope, [...new Set(names.filter((name): name is string => typeof name === 'string' && name !== ''))]])
    )
  } catch {
    return null
  }
}

export function writeMysqlTableVisitHistory(history: MysqlTableVisitHistory, storage?: HistoryStorage): boolean {
  try {
    // Only connection identity and table names are stored, never credentials or row values.
    const target = storage ?? window.localStorage
    target.setItem(MYSQL_TABLE_HISTORY_STORAGE_KEY, JSON.stringify(history))
    return true
  } catch {
    // The dialog keeps its in-memory ordering if local storage is unavailable or full.
    return false
  }
}

export function recordMysqlTableVisit(history: MysqlTableVisitHistory, scope: string, table: string): MysqlTableVisitHistory {
  const previous = history[scope] ?? []
  if (previous[0] === table) return history
  return { ...history, [scope]: [table, ...previous.filter((name) => name !== table)] }
}

/** Access order is explicit, so rapid visits and a changing system clock cannot tie. */
export function sortMysqlTablesByVisits<T extends { name: string }>(tables: readonly T[], recent: readonly string[]): T[] {
  const rank = new Map(recent.map((name, index) => [name, index]))
  return [...tables].sort((left, right) =>
    (rank.get(left.name) ?? recent.length) - (rank.get(right.name) ?? recent.length)
  )
}

/** A new connection gets a permanent ID on its first save; preserve every database's visits. */
export function renameMysqlTableVisitConnection(
  history: MysqlTableVisitHistory,
  previousId: string,
  nextId: string
): MysqlTableVisitHistory {
  if (previousId === nextId) return history
  const next = { ...history }
  for (const [scope, names] of Object.entries(history)) {
    let identity: unknown
    try { identity = JSON.parse(scope) } catch { continue }
    if (!Array.isArray(identity) || identity.length !== 5 || identity[0] !== previousId) continue
    identity[0] = nextId
    const nextScope = JSON.stringify(identity)
    next[nextScope] = [...new Set([...names, ...(next[nextScope] ?? [])])]
    delete next[scope]
  }
  return next
}
