/**
 * Gemini cookie-import probe — can a hand-copied Google session sign the embed in?
 *
 * WHY THIS RUN EXISTS
 * -------------------
 * The previous run answered the login question the expensive way: Google answered 无法登录 /
 * "此浏览器或应用可能不安全" to a DIRECT sign-in inside the embedded view. That is the third time
 * this wall has come up here (third-party OAuth, then Apple, now a first-party Google sign-in),
 * so the embedded-login route is settled and the session has to arrive from outside.
 *
 * `src/main/session-import.ts` already does exactly that for ChatGPT, but it cannot be reused
 * as-is: it imports ONE cookie (a NextAuth bearer token, reassembled from `.0`/`.1` chunks) onto
 * the platform's own domain. A Google session is a SET of cookies on `.google.com`, with no
 * chunks and no single bearer token — a different scheme, which that module's own comment says
 * will need its own name list.
 *
 * BEFORE WRITING THAT, THIS ANSWERS THE ONLY QUESTION THAT MATTERS:
 *
 *   Do copied Google cookies actually produce a signed-in Gemini session in this partition, or
 *   does Google reject them the way it rejects the embedded sign-in?
 *
 * If they are rejected, the feature is dead and nothing should be built. If they work, the
 * import path can be extended with evidence instead of hope.
 *
 * WHAT TO GIVE IT
 * ---------------
 * A text file containing your Google cookies. The easiest source is DevTools:
 *
 *   Network tab -> click any gemini.google.com request -> Headers -> Request Headers
 *   -> copy the whole `cookie:` line.
 *
 * "Copy as cURL" works too — the probe finds the cookie header inside it. So does the raw
 * `name=value; name=value` string on its own.
 *
 * Run (from the repo root, PowerShell):
 *
 *   $env:PROBE_COOKIE_FILE='C:\path\to\google-cookies.txt'
 *   node_modules\electron\dist\electron.exe tools\diag\gemini-cookie-probe.js
 *
 * Optional proxy:  $env:PROBE_PROXY='http://127.0.0.1:7897'
 *
 * COOKIE VALUES ARE NEVER LOGGED. Only names and lengths are written, by this probe and by every
 * other one in this directory — the log is a file that gets pasted around.
 *
 * Log: %TEMP%\gpt-login-diag\gemini-cookie-<timestamp>.log
 */
const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const PARTITION = process.env.PROBE_PARTITION || 'persist:gemini'
const LOG_DIR = process.env.PROBE_LOG_DIR || path.join(app.getPath('temp'), 'gpt-login-diag')
const COOKIE_FILE = (process.env.PROBE_COOKIE_FILE || '').trim()
const PROXY = process.env.PROBE_PROXY || ''
const START_URL = 'https://gemini.google.com/app?hl=zh'

app.setPath(
  'userData',
  process.env.PROBE_USER_DATA || path.join(app.getPath('appData'), 'GPT Web to Codex Terminal')
)

const chromeVersion = String(process.versions.chrome)
const majorVersion = chromeVersion.split('.')[0]
const CHROME_BRANDS =
  `"Google Chrome";v="${majorVersion}", "Chromium";v="${majorVersion}", "Not(A:Brand";v="24"`
const CHROME_FULL_VERSION_LIST =
  `"Google Chrome";v="${chromeVersion}", "Chromium";v="${chromeVersion}", "Not(A:Brand";v="24.0.0.0"`

app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled')

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
fs.mkdirSync(LOG_DIR, { recursive: true })
const LOG_FILE = path.join(LOG_DIR, `gemini-cookie-${stamp}.log`)

function log(...parts) {
  const line = `[${new Date().toISOString().slice(11, 23)}] ${parts.map(String).join(' ')}`
  try {
    fs.appendFileSync(LOG_FILE, line + '\n')
  } catch (error) {
    console.log('log write failed:', error.message)
  }
  console.log(line)
}

const shorten = (url, max = 180) => String(url).slice(0, max)
const safeHost = (url) => {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** Names whose PRESENCE is checked for, so the log can say what is missing, not just how many. */
const GOOGLE_AUTH_NAMES = [
  'SID',
  'HSID',
  'SSID',
  'APISID',
  'SAPISID',
  '__Secure-1PSID',
  '__Secure-3PSID',
  '__Secure-1PAPISID',
  '__Secure-3PAPISID',
  '__Secure-1PSIDTS',
  '__Secure-3PSIDTS',
  'LSID',
  'ACCOUNT_CHOOSER',
  'NID'
]

/**
 * Pull `name=value` pairs out of whatever the user pasted.
 *
 * Three shapes are accepted because all three are one copy-paste away in DevTools, and asking
 * the user to reformat is asking for a failed run:
 *
 *   cookie: A=1; B=2
 *   -H 'cookie: A=1; B=2'          (from "Copy as cURL")
 *   A=1; B=2
 */
function parseCookies(raw) {
  const text = String(raw || '')
  let body = text

  const headerMatch = /(?:^|\s|-H\s+['"]?)cookie:\s*([^\r\n'"]+)/i.exec(text)
  if (headerMatch) body = headerMatch[1]
  else {
    // No explicit header: take the longest line that looks like a cookie string.
    const candidates = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.includes('='))
      .sort((a, b) => b.length - a.length)
    if (candidates.length > 0) body = candidates[0]
  }

  const pairs = []
  for (const part of body.split(';')) {
    const trimmed = part.trim()
    if (trimmed === '') continue
    const at = trimmed.indexOf('=')
    if (at <= 0) continue
    const name = trimmed.slice(0, at).trim()
    const value = trimmed.slice(at + 1).trim()
    if (name === '' || value === '') continue
    pairs.push({ name, value })
  }
  return pairs
}

/**
 * Does the page look signed in?
 *
 * Decided from the DOM rather than the URL: Google serves the sign-in wall ON
 * gemini.google.com, so the hostname says nothing. The composer's presence is the honest signal
 * — it only exists for a signed-in user.
 */
const SIGNED_IN_CHECK = `(() => {
  const composer = document.querySelector('rich-textarea, div[contenteditable="true"], textarea')
  const body = (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').trim()
  const wall = /无法登录|此浏览器或应用可能不安全|Sign in|登录|accounts\\.google\\.com/i.test(body)
  return {
    host: location.host,
    href: location.href,
    title: document.title,
    hasComposer: composer !== null,
    composerTag: composer ? composer.tagName.toLowerCase() : null,
    bodyHead: body.slice(0, 240),
    looksLikeWall: wall
  }
})()`

async function inspect(wc, label) {
  try {
    const info = await wc.executeJavaScript(SIGNED_IN_CHECK)
    log(`--- ${label} ---`)
    log(`${label} host=`, info.host, '| title=', JSON.stringify(info.title))
    log(`${label} url=`, shorten(info.href))
    log(
      `${label} hasComposer=`,
      String(info.hasComposer),
      'composerTag=',
      String(info.composerTag),
      'looksLikeWall=',
      String(info.looksLikeWall)
    )
    log(`${label} body starts:`, JSON.stringify(info.bodyHead))
    return info
  } catch (error) {
    log(`${label} inspect failed:`, error.message)
    return null
  }
}

app.whenReady().then(async () => {
  log('=== gemini cookie-import probe ===')
  log('electron', process.versions.electron, 'chrome', process.versions.chrome)
  log('partition', PARTITION)
  log('cookieFile', COOKIE_FILE === '' ? '(NOT SET — nothing can be imported)' : COOKIE_FILE)
  log('proxy', PROXY === '' ? '(none)' : PROXY)
  log('logFile', LOG_FILE)
  log('')

  if (COOKIE_FILE === '') {
    log('REFUSING TO RUN: set PROBE_COOKIE_FILE to a file holding your Google cookies.')
    log("  $env:PROBE_COOKIE_FILE='C:\\path\\to\\google-cookies.txt'")
    log('=== nothing was done, log complete ===')
    setTimeout(() => app.quit(), 500)
    return
  }

  if (!fs.existsSync(COOKIE_FILE)) {
    log('REFUSING TO RUN: no such file:', COOKIE_FILE)
    log('=== nothing was done, log complete ===')
    setTimeout(() => app.quit(), 500)
    return
  }

  const raw = fs.readFileSync(COOKIE_FILE, 'utf8')
  const pairs = parseCookies(raw)
  log(`parsed ${pairs.length} cookie(s) from the file (${raw.length} bytes)`)
  if (pairs.length === 0) {
    log('REFUSING TO RUN: no name=value pairs found in that file.')
    log('=== nothing was done, log complete ===')
    setTimeout(() => app.quit(), 500)
    return
  }

  /*
   * Names and lengths ONLY. This log is a file that gets pasted into a chat, and a Google
   * session cookie is a full account credential.
   */
  log('cookie names present (value lengths in brackets):')
  const present = new Set(pairs.map((pair) => pair.name))
  for (const pair of pairs) log(`    ${pair.name} (${pair.value.length})`)
  log('')
  log('Google auth cookies the import is EXPECTED to need:')
  for (const name of GOOGLE_AUTH_NAMES) {
    log(`    ${present.has(name) ? 'present' : 'MISSING'}  ${name}`)
  }
  const missingCritical = ['SID', '__Secure-1PSID', '__Secure-3PSID'].filter(
    (name) => !present.has(name)
  )
  if (missingCritical.length > 0) {
    log('')
    log(
      `NOTE: ${missingCritical.join(', ')} missing. Google will almost certainly ignore the rest —`
    )
    log('  make sure the `cookie:` line came from a request to a google.com host while signed in.')
  }

  const ses = session.fromPartition(PARTITION)

  ses.webRequest.onBeforeSendHeaders({ urls: ['*://*/*'] }, (details, callback) => {
    const headers = { ...details.requestHeaders }
    for (const name of Object.keys(headers)) {
      const lower = name.toLowerCase()
      if (lower === 'sec-ch-ua') headers[name] = CHROME_BRANDS
      else if (lower === 'sec-ch-ua-full-version-list') headers[name] = CHROME_FULL_VERSION_LIST
      else if (lower === 'sec-ch-ua-full-version') headers[name] = `"${chromeVersion}"`
    }
    return callback({ requestHeaders: headers })
  })

  if (PROXY !== '') {
    try {
      await ses.setProxy({ proxyRules: PROXY })
      log('proxy applied to', PARTITION)
    } catch (error) {
      log('proxy could not be applied:', error.message)
    }
  }

  /*
   * Written onto `.google.com`, because the session has to cover gemini.google.com AND whatever
   * accounts.google.com hop the page makes on its own. A cookie scoped to gemini.google.com
   * alone would be absent on exactly the request that decides whether the session is real.
   */
  /*
   * `expirationDate` IS NOT OPTIONAL, and leaving it out cost a whole run.
   *
   * Without it Electron creates a SESSION cookie, and Chromium never writes session cookies to
   * disk. The first version of this probe therefore reported `wrote 25/25` and `jar now holds 25`,
   * loaded Gemini fully signed in — and left nothing behind: the next process found an empty jar
   * and a signed-out page. Measured afterwards in the on-disk store: the nine `SID`/`__Secure-*`
   * cookies were absent, while every cookie GOOGLE had re-set during the page load was present
   * with `has_expires=1, is_persistent=1`.
   *
   * A raw `cookie:` header carries no attributes, so the real expiry is unknowable from the
   * source this probe accepts. Thirty days is a deliberate stand-in: the server validates the
   * VALUE, not the client's expiry, and Google rotates what it cares about on its own.
   */
  const expiresIn = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60

  let written = 0
  for (const pair of pairs) {
    try {
      await ses.cookies.set({
        url: 'https://gemini.google.com/',
        name: pair.name,
        value: pair.value,
        domain: '.google.com',
        path: '/',
        secure: true,
        httpOnly: true,
        expirationDate: expiresIn
      })
      written += 1
    } catch (error) {
      log(`cookies.set FAILED for ${pair.name}: ${error.message}`)
    }
  }
  log('')
  log(`wrote ${written}/${pairs.length} cookie(s) onto .google.com`)

  /* Read back what actually landed — a write that silently did nothing is the failure to catch. */
  try {
    const stored = await ses.cookies.get({ domain: '.google.com' })
    log(`jar now holds ${stored.length} cookie(s) for .google.com:`)
    for (const cookie of stored.slice(0, 40)) {
      log(
        `    ${cookie.domain} ${cookie.name} (${String(cookie.value || '').length})` +
          (cookie.session === true ? '   <-- SESSION COOKIE' : '')
      )
    }
    /*
     * Named loudly, because this is the failure that hid behind a fully successful run.
     *
     * A session cookie is present in THIS process and gone in the next one, so the probe looks
     * like it worked and the app it was written for finds nothing. It is invisible unless
     * something says so, and the read-back is the only place that can.
     */
    const sessionOnly = stored.filter((cookie) => cookie.session === true)
    if (sessionOnly.length > 0) {
      log('')
      log(`WARNING: ${sessionOnly.length} of them are SESSION cookies and will NOT be written to`)
      log('  disk — they vanish when this process exits. Set expirationDate (see the write loop).')
      for (const cookie of sessionOnly.slice(0, 20)) log(`    ${cookie.name}`)
    } else {
      log('')
      log('all of them are PERSISTENT — the next process will find them.')
    }
  } catch (error) {
    log('could not read the jar back:', error.message)
  }

  const win = new BrowserWindow({
    width: 1280,
    height: 940,
    title: 'Gemini cookie 导入探针 — 用拷来的 Google cookie 试着登录',
    backgroundColor: '#141922',
    webPreferences: {
      partition: PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
        `Chrome/${process.versions.chrome} Safari/537.36`
    }
  })

  const wc = win.webContents
  wc.on('did-navigate', (_e, url) => log('NAVIGATE', shorten(url, 200)))
  wc.on('did-navigate-in-page', (_e, url, isMain) => {
    if (isMain) log('IN-PAGE', shorten(url, 200))
  })
  wc.on('did-finish-load', () => log('FINISHED LOAD:', shorten(wc.getURL(), 160), '|', wc.getTitle()))

  log('')
  log('loading', START_URL, '— the user drives; this probe only reads the DOM')
  await wc.loadURL(START_URL).catch((e) => log('loadURL rejected:', e.message))
  await new Promise((r) => setTimeout(r, 8000))
  const first = await inspect(wc, 'AFTER-IMPORT')

  const timer = setInterval(() => {
    if (!win.isDestroyed()) void inspect(wc, 'TICK')
  }, 15000)

  win.on('closed', async () => {
    clearInterval(timer)
    const final = await inspect(wc, 'FINAL')
    log('')
    log('=== VERDICT ===')
    log('cookies parsed   :', String(pairs.length))
    log('cookies written  :', String(written))
    log('after import     : hasComposer=' + String(first ? first.hasComposer : '?'),
        'looksLikeWall=' + String(first ? first.looksLikeWall : '?'))
    log('on close         : hasComposer=' + String(final ? final.hasComposer : '?'),
        'looksLikeWall=' + String(final ? final.looksLikeWall : '?'))
    log('')
    if (final && final.hasComposer && !final.looksLikeWall) {
      log('IMPORTED COOKIES WORK — Gemini rendered its composer, so the session is real.')
      log('→ the import path can be extended for Google. What it needs that ChatGPT\'s does not:')
      log('  · MANY cookies, not one, written onto the platform\'s registrable domain (.google.com)')
      log('  · no chunk reassembly (that is a NextAuth thing)')
      log('  · a Google name list + a raw `cookie:` header parser, not a single value box')
    } else if (final && final.looksLikeWall) {
      log('REJECTED — Google served the sign-in wall despite the imported cookies.')
      log('→ do NOT build the import feature on this route. Google binds the session more')
      log('  tightly than a bearer token; the remaining options are a real browser window or')
      log('  accepting that Gemini cannot be embedded at all.')
    } else {
      log('INCONCLUSIVE — no composer and no wall. Read the body text above: it usually says')
      log('  which it is (a consent screen, a country block, or a proxy failure).')
    }
    log('=== window closed, log complete ===')
    app.quit()
  })
})
