/**
 * Point any managed session whose stored URL is a dead end back at its platform's home page.
 *
 * THE PROBLEM THIS UNDOES. A session's URL is persisted so a restart reopens where you were. That
 * is fine until the site redirects through something a restart must not re-enter — an involuntary
 * logout (`/login?from=logout&reauth=1&returnTo=…`) or a Cloudflare interstitial. Loading a
 * `reauth=1` URL asks the site to log out and start over, so the app re-enters the auth flow on
 * every launch and can never get past the challenge that protects it. The rule that stops it
 * happening again lives in `isRestorableUrl` (`src/main/session-runtime.ts`); this repairs rows
 * that were already written under the old rule.
 *
 * Run (from the repo root, with the app CLOSED):
 *
 *   node --experimental-sqlite tools/diag/reset-session-urls.mjs
 *   node --experimental-sqlite tools/diag/reset-session-urls.mjs --apply
 *
 * Without `--apply` it only reports what it would change — check that list before writing.
 *
 * The check is deliberately a COPY of `isRestorableUrl` rather than an import: this is a plain
 * .mjs diagnostic and the app is TypeScript. **Keep the two in sync** — if the app's rule changes,
 * this starts disagreeing with it and will report sessions the app considers fine.
 *
 * Only the `url` column is touched, and only for rows that fail the check. Titles, conversations,
 * terminal cwd and SSH state are left alone, so the session keeps its identity.
 */
import { copyFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const USER_DATA = join(
  process.env.APPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Roaming'),
  'GPT Web to Codex Terminal'
)
const DB = join(USER_DATA, 'conversations.db')

/** Mirrors `isRestorableUrl` in src/main/session-runtime.ts. See the note above. */
function isRestorableUrl(raw) {
  let url
  try {
    url = new URL(String(raw))
  } catch {
    return false
  }
  if (/[?&]reauth=/.test(url.search)) return false
  if (url.searchParams.has('__cf_chl_tk') || url.searchParams.has('__cf_chl_rt_tk')) return false
  if (/^\/(log-?in|log-?out|sign-?in|sign-?up|register|auth)(\/|$)/i.test(url.pathname)) return false
  return true
}

/** Where each platform should reopen instead. Mirrors the descriptors' `homeUrl`. */
const HOME_BY_PLATFORM = {
  chatgpt: 'https://chatgpt.com/',
  deepseek: 'https://chat.deepseek.com/',
  claude: 'https://claude.ai/new',
  gemini: 'https://gemini.google.com/app'
}

const apply = process.argv.includes('--apply')

if (!existsSync(DB)) {
  console.error(`\n[reset] no database at ${DB}\n`)
  process.exit(1)
}

try {
  copyFileSync(DB, `${DB}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`)
} catch (error) {
  if (String(error.code) === 'EBUSY' || String(error.code) === 'EPERM') {
    console.error('\n[reset] the app is running and holds the database open. Close it first.\n')
    process.exit(1)
  }
  console.error(`\n[reset] could not back up the database: ${error.message}\n`)
  process.exit(1)
}

const db = new DatabaseSync(DB)
const rows = db.prepare('SELECT id, platform_id, url FROM managed_sessions').all()

const broken = rows.filter((row) => !isRestorableUrl(row.url))
console.log(`[reset] sessions: ${rows.length}, needing repair: ${broken.length}\n`)

if (broken.length === 0) {
  console.log('[reset] nothing to do.')
} else {
  const update = db.prepare('UPDATE managed_sessions SET url = ? WHERE id = ?')
  for (const row of broken) {
    const home = HOME_BY_PLATFORM[row.platform_id] ?? ''
    console.log(`  ${String(row.id).slice(0, 8)}  ${String(row.platform_id).padEnd(9)}`)
    console.log(`      was: ${row.url}`)
    console.log(`      ->   ${home === '' ? '(unknown platform — left alone)' : home}`)
    if (apply && home !== '') update.run(home, row.id)
  }
  if (!apply) console.log('\n[reset] dry run — nothing written. Re-run with --apply to write.')
  else console.log(`\n[reset] updated ${broken.filter((r) => HOME_BY_PLATFORM[r.platform_id]).length} row(s).`)
}

db.close()
console.log('\n[reset] done. Start the app; the repaired sessions should reopen at their home page.')
