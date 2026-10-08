/** SCAN can return the same key/member again, including across consecutive pages. */
export function mergeRedisEntries<T extends { id: string }>(previous: T[], next: T[]): T[] {
  return [...new Map([...previous, ...next].map((entry) => [entry.id, entry])).values()]
}

/** Preserve the original JSON number tokens, duplicate fields and escape sequences. */
export function formatRedisJson(raw: string): string | null {
  try { JSON.parse(raw) } catch { return null }
  const tokens = raw.match(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:]+/g) ?? []
  let depth = 0
  let result = ''
  const newline = (): string => '\n' + '  '.repeat(depth)
  tokens.forEach((token, index) => {
    const previous = tokens[index - 1]
    const next = tokens[index + 1]
    if (token === '{' || token === '[') {
      result += token
      depth += 1
      if (next !== '}' && next !== ']') result += newline()
    } else if (token === '}' || token === ']') {
      depth -= 1
      if (previous !== '{' && previous !== '[') result += newline()
      result += token
    } else if (token === ',') {
      result += ',' + newline()
    } else if (token === ':') {
      result += ': '
    } else {
      result += token
    }
  })
  return result
}
