/**
 * Clear the ChatGPT/OpenAI login cookies out of the app's embedded partition.
 *
 * Run (from the repo root, with the app CLOSED):
 *
 *   node --experimental-sqlite tools/diag/clear-embed-cookies.mjs
 *
 * The flag is required on the system Node (22.12): `node:sqlite` is still gated
 * there. The app itself does not need it, because it runs inside Electron 44, which
 * ships a newer Node where the module is available unflagged.
 *
 * Why a script: the cookie jar is a SQLite file that the running app holds under an
 * exclusive lock, and Electron's own cookie API only works from inside the app. This
 * edits the file directly — but only after backing it up, and only for rows matching
 * the auth families below.
 *
 * What it deliberately does NOT delete: cf_clearance, __cf_bm, __cflb, _cfuvid and
 * oai-did. Cloudflare's tokens are bot-management state rather than credentials:
 * dropping them just makes the next page load solve a challenge again, and oai-did is
 * the anonymous device id, which is not a login either.
 *
 * Values are never printed — only names, domains and row counts.
 */
import { copyFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const USER_DATA = join(
  process.env.APPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Roaming'),
  'GPT Web to Codex Terminal'
)
const DB = join(USER_DATA, 'Partitions', 'chatgpt', 'Network', 'Cookies')

/** Login/session families. Everything here is a credential or a login-flow token. */
const AUTH_PATTERNS = [
  '__Secure-next-auth%',
  '__Host-next-auth%',
  'next-auth.%',
  '__Secure-authjs%',
  '__Host-authjs%',
  'authjs.%',
  'oai-login-csrf%',
  'auth-session-minimized%',
  'oai-client-auth-session%',
  'oai-sc',
  'login_session',
  // Exact name only: "session" as a prefix would reach into unrelated cookies.
  'session'
]

/** Domains whose cookies belong to the login. */
const HOSTS = ['%chatgpt.com', '%openai.com']

/** Kept on purpose — bot management and anonymous ids, not credentials. */
const KEEP_EXACT = new Set(['oai-did', 'oai-mweb-route-desktop', '__cf_bm', '__cflb', 'cf_clearance', '_cfuvid'])

function fail(message) {
  console.error(`\n[clear] ${message}\n`)
  process.exit(1)
}

if (!existsSync(DB)) {
  fail(`cookie database not found at:\n  ${DB}\n(has the app ever run on this machine?)`)
}

/**
 * The app holds this file open while it runs, and Windows refuses even a read-only
 * copy then. Report that instead of a raw EPERM.
 */
let backup
try {
  backup = `${DB}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
  copyFileSync(DB, backup)
} catch (error) {
  if (String(error.code) === 'EBUSY' || String(error.code) === 'EPERM') {
    fail(
      'the app is still running and holds the cookie database open.\n' +
        'Close "GPT Web to Codex Terminal" completely (check the tray / task manager),\n' +
        'then run this again.'
    )
  }
  fail(`could not back up the database: ${error.message}`)
}

console.log(`[clear] database : ${DB}`)
console.log(`[clear] backup   : ${backup}`)

const db = new DatabaseSync(DB)

const where = AUTH_PATTERNS.map(() => 'name LIKE ?').join(' OR ')
const hostClause = HOSTS.map(() => 'host_key LIKE ?').join(' OR ')
const params = [...AUTH_PATTERNS, ...HOSTS]

const victims = db
  .prepare(`SELECT host_key, name, length(value) AS len FROM cookies WHERE (${where}) AND (${hostClause})`)
  .all(...params)
  .filter((row) => !KEEP_EXACT.has(row.name))

if (victims.length === 0) {
  console.log('[clear] nothing to remove — no login cookies found.')
} else {
  console.log(`[clear] removing ${victims.length} login cookie(s):`)
  for (const row of victims) {
    console.log(`          ${row.host_key}  ${row.name}  (${row.len} bytes)`)
  }
  const deleted = db
    .prepare(`DELETE FROM cookies WHERE (${where}) AND (${hostClause})`)
    .run(...params)
  console.log(`[clear] deleted rows: ${deleted.changes}`)
}

const remaining = db
  .prepare(`SELECT host_key, name FROM cookies WHERE ${hostClause} ORDER BY host_key, name`)
  .all(...HOSTS)
console.log(`[clear] remaining cookies for chatgpt/openai: ${remaining.length}`)
for (const row of remaining) console.log(`          ${row.host_key}  ${row.name}`)

db.exec('VACUUM')
db.close()

console.log('\n[clear] done. Start the app; chatgpt.com should be signed out.')
console.log(`[clear] the backup is left in place in case this needs to be undone: ${backup}`)

const dir = join(USER_DATA, 'Partitions', 'chatgpt', 'Network')
const stray = readdirSync(dir).filter((f) => f.startsWith('Cookies.bak-'))
if (stray.length > 3) {
  console.log(`[clear] note: ${stray.length} backups have accumulated in ${dir}`)
  for (const f of stray) {
    console.log(`          ${f}  ${statSync(join(dir, f)).size} bytes`)
  }
}
