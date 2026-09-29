/**
 * Clear Cloudflare's bot-management cookies out of one embedded partition.
 *
 * THE QUESTION THIS ANSWERS: "the app works now — how do I get the challenge back?"
 *
 * When a Cloudflare challenge is solved, Cloudflare plants `cf_clearance` in the jar and stops
 * challenging that client for a while. That is why a failure caused by a bot check becomes
 * unreproducible the moment anything — the app or a probe — waits the check out. Deleting the
 * clearance cookie puts the partition back to "first visit", which is the only state in which
 * that code path can be tested again.
 *
 * Run (from the repo root, with the app CLOSED):
 *
 *   node --experimental-sqlite tools/diag/clear-cloudflare-state.mjs <partition>
 *
 *   <partition> is a bare name: claude, chatgpt, deepseek, gemini, or anything else under
 *   `<userData>/Partitions/`. Add `--login` to also remove the site's session cookies, which
 *   signs the partition out as well — usually NOT what you want, since a challenge can be
 *   reproduced while still signed in, and signing out costs a real login.
 *
 *   node --experimental-sqlite tools/diag/clear-cloudflare-state.mjs claude
 *
 * Why a script rather than the app: the jar is a SQLite file the running app holds under an
 * exclusive lock, and Electron's cookie API only exists inside the app. This edits the file
 * directly — after backing it up, and only for rows matching the families below.
 *
 * Values are never printed — only names, domains and row counts. `cf_clearance` is a bearer
 * token: anyone holding it can present as this client.
 */
import { copyFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const USER_DATA = join(
  process.env.APPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Roaming'),
  'GPT Web to Codex Terminal'
)

/** Cloudflare's client-state cookies. Removing these is what re-arms the challenge. */
const CLOUDFLARE_COOKIES = ['cf_clearance', '__cf_bm', '__cflb', '_cfuvid', 'cf_chl_%', '__cfwaitingroom']

/**
 * Login families, removed only with `--login`. Kept deliberately broad per platform because the
 * point of that flag is "sign me out", and a missed cookie means a confusing half-signed-out jar.
 */
const LOGIN_COOKIES = [
  'sessionKey%',
  '__Secure-next-auth%',
  '__Host-next-auth%',
  'next-auth.%',
  '__Secure-authjs%',
  'authjs.%',
  'auth-session-minimized%',
  'oai-sc',
  'login_session',
  'session'
]

function fail(message) {
  console.error(`\n[cf] ${message}\n`)
  process.exit(1)
}

const args = process.argv.slice(2)
const withLogin = args.includes('--login')
const partition = args.find((arg) => !arg.startsWith('--'))

if (!partition) {
  fail(
    'usage: node --experimental-sqlite tools/diag/clear-cloudflare-state.mjs <partition> [--login]\n' +
      '       e.g. … clear-cloudflare-state.mjs claude'
  )
}

const DB = join(USER_DATA, 'Partitions', partition, 'Network', 'Cookies')
if (!existsSync(DB)) {
  const dir = join(USER_DATA, 'Partitions')
  const available = existsSync(dir) ? readdirSync(dir).join(', ') : '(none)'
  fail(`no cookie database at:\n  ${DB}\npartitions present: ${available}`)
}

/*
 * The app holds this file open while it runs, and Windows refuses even a read-only copy then.
 * Say that plainly instead of surfacing a raw EPERM, which reads like a bug in this script.
 */
let backup
try {
  backup = `${DB}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
  copyFileSync(DB, backup)
} catch (error) {
  if (String(error.code) === 'EBUSY' || String(error.code) === 'EPERM') {
    fail(
      'the app is still running and holds the cookie database open.\n' +
        'Close "GPT Web to Codex Terminal" completely, then run this again.'
    )
  }
  fail(`could not back up the database: ${error.message}`)
}

console.log(`[cf] partition : ${partition}`)
console.log(`[cf] database  : ${DB}`)
console.log(`[cf] backup    : ${backup}`)
console.log(`[cf] mode      : ${withLogin ? 'cloudflare state + LOGIN cookies' : 'cloudflare state only (login kept)'}`)

const db = new DatabaseSync(DB)

const families = withLogin ? [...CLOUDFLARE_COOKIES, ...LOGIN_COOKIES] : CLOUDFLARE_COOKIES
const where = families.map(() => 'name LIKE ?').join(' OR ')

const victims = db
  .prepare(`SELECT host_key, name, length(value) AS len FROM cookies WHERE ${where} ORDER BY host_key, name`)
  .all(...families)

if (victims.length === 0) {
  console.log('\n[cf] nothing matched — this partition holds no Cloudflare state right now.')
} else {
  console.log(`\n[cf] removing ${victims.length} cookie(s):`)
  for (const row of victims) {
    console.log(`       ${String(row.host_key).padEnd(22)} ${String(row.name).padEnd(34)} ${row.len} bytes`)
  }
  const deleted = db.prepare(`DELETE FROM cookies WHERE ${where}`).run(...families)
  console.log(`[cf] deleted rows: ${deleted.changes}`)
}

const remaining = db.prepare('SELECT host_key, name FROM cookies ORDER BY host_key, name').all()
console.log(`\n[cf] remaining cookies in ${partition}: ${remaining.length}`)
for (const row of remaining) console.log(`       ${String(row.host_key).padEnd(22)} ${row.name}`)

db.close()

console.log(`\n[cf] done (backup: ${statSync(backup).size} bytes, left in place to undo).`)
console.log('[cf] start the app — the next load of this site should be challenged again.')
