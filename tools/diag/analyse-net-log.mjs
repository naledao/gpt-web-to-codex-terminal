/**
 * Reduce a Chromium net log to the failures that matter.
 *
 * Chromium's console message for a failed TLS handshake names no host
 * (`handshake failed; returned -1; SSL error code 1, net_error -100`), and this app embeds
 * two platforms at once — so the message alone cannot be acted on. The net log has the URL,
 * but it is a tens-of-megabytes stream of every event; this turns it into a short list.
 *
 * Run it against the file produced by `DSH_NET_LOG=1`:
 *
 *   node tools/diag/analyse-net-log.mjs "%APPDATA%\GPT Web to Codex Terminal\logs\netlog-….json"
 *
 * Pure reading: it never writes to the log or the network.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const input = process.argv[2]
if (!input) {
  console.error('usage: node tools/diag/analyse-net-log.mjs <netlog.json>')
  process.exit(2)
}

/** Chromium writes a JSON header line, then one JSON object per line. */
function readEvents(path) {
  const text = readFileSync(path, 'utf8')
  const lines = text.split('\n')
  const events = []
  let header = null
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed === ',') continue
    const candidate = trimmed.endsWith(',') ? trimmed.slice(0, -1) : trimmed
    if (!candidate.startsWith('{')) continue
    try {
      const parsed = JSON.parse(candidate)
      if (parsed.constants) header = parsed
      else if (parsed.source) events.push(parsed)
    } catch {
      // A truncated final line is normal when the app was killed; skip it.
    }
  }
  return { header, events }
}

const { header, events } = readEvents(input)
if (events.length === 0) {
  console.error(`${basename(input)}: no usable events (was the app closed normally?)`)
  process.exit(1)
}

const typeName = (id) => header?.constants?.logEventTypes?.[id] ?? `type${id}`
const sourceName = (id) => header?.constants?.logSourceType?.[id] ?? `source${id}`

/* Map source id → the URL it belongs to, built from the URL_REQUEST events. */
const urlBySource = new Map()
for (const event of events) {
  if (typeName(event.type) === 'URL_REQUEST_START_JOB' && event.params?.url) {
    urlBySource.set(event.source.id, event.params.url)
  }
}

const FAILURE_TYPES = new Set([
  'SSL_HANDSHAKE_ERROR',
  'SSL_CONNECT_ERROR',
  'SSL_CERTIFICATE_ERROR',
  'URL_REQUEST_FAILED',
  'REQUEST_ALIVE',
  'CONNECT_JOB_ERROR',
  'SOCKET_ERROR',
  'TCP_CLIENT_CONNECT',
  'HTTP2_SESSION_ERROR',
  'QUIC_SESSION_ERROR'
])

const failures = []
for (const event of events) {
  const type = typeName(event.type)
  const source = sourceName(event.source.type)
  const url = urlBySource.get(event.source.id) ?? null
  const params = event.params ?? {}

  const isFailure =
    (type === 'URL_REQUEST_FAILED') ||
    (type.startsWith('SSL_') && (params.net_error !== undefined || params.error_code !== undefined)) ||
    (url !== null && params.net_error !== undefined && params.net_error < 0) ||
    (source === 'SSL' && params.net_error !== undefined && params.net_error !== 0)

  if (!isFailure || !FAILURE_TYPES.has(type)) continue

  failures.push({
    time: event.time,
    type,
    netError: params.net_error ?? params.error_code ?? null,
    error: params.error ?? params.error_description ?? null,
    url: url ?? '(no URL recorded for this source)',
    phase: params.phase ?? null
  })
}

console.log(`events: ${events.length}   url requests: ${urlBySource.size}   failures: ${failures.length}\n`)

/* Group by host — the whole point is to name the endpoints, not the lines. */
const byHost = new Map()
for (const failure of failures) {
  let host = '(unknown)'
  try {
    host = new URL(failure.url).host
  } catch {
    /* keep the placeholder */
  }
  const entry = byHost.get(host) ?? { count: 0, errors: new Set(), urls: new Set() }
  entry.count += 1
  if (failure.netError !== null) entry.errors.add(`net_error ${failure.netError}`)
  entry.urls.add(String(failure.url).slice(0, 120))
  byHost.set(host, entry)
}

const ordered = [...byHost.entries()].sort((a, b) => b[1].count - a[1].count)
console.log('failures by host:')
for (const [host, entry] of ordered) {
  console.log(`\n  ${host}   (${entry.count} failure${entry.count === 1 ? '' : 's'})   ${[...entry.errors].join(', ')}`)
  for (const url of [...entry.urls].slice(0, 4)) console.log(`      ${url}`)
}

const report = join(
  process.env.TEMP ?? '.',
  `net-log-failures-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`
)
writeFileSync(
  report,
  ordered
    .map(([host, entry]) => `${host}\t${entry.count}\t${[...entry.errors].join(',')}\n  ${[...entry.urls].join('\n  ')}`)
    .join('\n\n'),
  'utf8'
)
console.log(`\nwritten: ${report}`)
