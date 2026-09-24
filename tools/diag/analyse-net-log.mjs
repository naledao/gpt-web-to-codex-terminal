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
 *
 * WHY IT DOES NOT USE THE EVENT-TYPE TABLE
 * ----------------------------------------
 * The obvious design — read `constants.logEventTypes`, then match on names — is broken on any
 * file written by a *running* app, and that is the normal case. Chromium streams the events
 * first and writes the `constants` block **last, when the log is closed**; until then the
 * block is an unterminated JSON object that cannot be parsed. The first version of this script
 * fell back to `type117`-style placeholders and cheerfully reported "url requests: 0,
 * failures: 0" against a file that was in fact full of failures — a silent wrong answer,
 * which is the worst possible output for a diagnostic.
 *
 * So the URL is recovered structurally instead. A connection's destination rides on the
 * `HTTP_STREAM_JOB` event (`params.destination`), which carries the full URL, and every event
 * of that connection names its owning source by `source.id`. That is enough to attribute each
 * failure to a host without decoding a single type id.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const input = process.argv[2]
if (!input) {
  console.error('usage: node tools/diag/analyse-net-log.mjs <netlog.json>')
  process.exit(2)
}

/**
 * Chromium writes a JSON header line, then one JSON object per line. The `constants` line is
 * only closed on exit, so it is parsed separately and tolerated as absent.
 */
function readEvents(path) {
  const lines = readFileSync(path, 'utf8').split('\n')
  const events = []
  let header = null
  let headerTruncated = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed === ',') continue
    const candidate = trimmed.endsWith(',') ? trimmed.slice(0, -1) : trimmed
    if (!candidate.startsWith('{')) continue
    if (candidate.includes('"constants"')) {
      headerTruncated = true
      try {
        header = JSON.parse(candidate)
        headerTruncated = false
      } catch {
        // Still being written: expected while the app runs. Structure alone is enough.
      }
      continue
    }
    try {
      const parsed = JSON.parse(candidate)
      if (parsed.source) events.push(parsed)
    } catch {
      // A truncated final line is normal when the app was killed; skip it.
    }
  }
  return { header, headerTruncated, events }
}

const { header, headerTruncated, events } = readEvents(input)
if (events.length === 0) {
  console.error(`${basename(input)}: no usable events (was the app closed normally?)`)
  process.exit(1)
}

/* Map source id → the URL it belongs to, by structure rather than by type name. */
const urlBySource = new Map()
for (const event of events) {
  const url = event.params?.destination ?? event.params?.url
  if (typeof url === 'string' && url.includes('://')) urlBySource.set(event.source.id, url)
}

/*
 * A failure is any event carrying a negative `net_error`. That is the property that actually
 * matters and it needs no type table; the type id is only used to label the row.
 */
const failures = []
for (const event of events) {
  const netError = event.params?.net_error
  if (typeof netError !== 'number' || netError >= 0) continue
  failures.push({
    time: event.time,
    type: event.type,
    source: event.source.id,
    netError,
    error: event.params?.error ?? event.params?.error_description ?? null,
    url: urlBySource.get(event.source.id) ?? null,
    phase: event.params?.phase ?? event.phase ?? null
  })
}

const named = (id) => header?.constants?.logEventTypes?.[id] ?? `type${id}`
console.log(
  `events: ${events.length}   destinations seen: ${urlBySource.size}   failures: ${failures.length}`
)
if (headerTruncated) {
  console.log(
    'note: the event-type table is still being written (the app is running, or was killed),\n' +
      '      so rows are labelled by numeric type. Host attribution is unaffected — it is\n' +
      '      structural, not table-driven.'
  )
}
console.log('')

/* Group by host — the whole point is to name the endpoints, not the lines. */
const byHost = new Map()
for (const failure of failures) {
  let host = '(no destination recorded for this connection)'
  try {
    host = new URL(failure.url).host
  } catch {
    /* keep the placeholder */
  }
  const entry = byHost.get(host) ?? { count: 0, errors: new Set(), types: new Set(), first: null, last: null }
  entry.count += 1
  entry.errors.add(`net_error ${failure.netError}`)
  entry.types.add(named(failure.type))
  entry.first = entry.first === null ? failure.time : Math.min(entry.first, failure.time)
  entry.last = entry.last === null ? failure.time : Math.max(entry.last, failure.time)
  byHost.set(host, entry)
}

/** netlog timestamps are milliseconds since an arbitrary origin; the gap is what matters. */
const span = (entry) => {
  const seconds = (Number(entry.last) - Number(entry.first)) / 1000
  return `${seconds.toFixed(1)}s`
}

const ordered = [...byHost.entries()].sort((a, b) => b[1].count - a[1].count)
console.log('failures by host:')
for (const [host, entry] of ordered) {
  console.log(
    `\n  ${host}   (${entry.count} failure${entry.count === 1 ? '' : 's'} over ${span(entry)})   ` +
      `${[...entry.errors].join(', ')}`
  )
  console.log(`      events: ${[...entry.types].join(', ')}`)
  if (entry.count > 1) {
    const every = (Number(entry.last) - Number(entry.first)) / 1000 / (entry.count - 1)
    console.log(`      repeating every ~${every.toFixed(1)}s`)
  }
}

const report = join(
  process.env.TEMP ?? '.',
  `net-log-failures-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`
)
writeFileSync(
  report,
  [
    `# ${basename(input)}`,
    `events: ${events.length}  destinations: ${urlBySource.size}  failures: ${failures.length}`,
    '',
    ...ordered.map(
      ([host, entry]) =>
        `${host}\t${entry.count} failures over ${span(entry)}\t${[...entry.errors].join(',')}`
    ),
    '',
    '# every failure',
    ...failures.map(
      (f) => `${f.time}\t${named(f.type)}\tnet_error ${f.netError}\t${f.url ?? '(no destination)'}`
    )
  ].join('\n'),
  'utf8'
)
console.log(`\nwritten: ${report}`)
