/**
 * Email/OTP login probe — the run that decides whether the email route works.
 *
 * WHY THIS EXISTS
 * ---------------
 * Google OAuth cannot sign in inside the embedded view (verified: Google answers
 * /v3/signin/rejected even with a patched UA and a corrected Sec-CH-UA brand list),
 * so email/OTP is the only route that can establish the session the embed needs.
 *
 * Two unknowns remain, and this run answers both:
 *
 *   1. `auth.openai.com/log-in` rendered the email form once and rendered
 *      "你的会话已结束" (no form at all) on a later attempt. Which one you get, and
 *      what the page reports about itself, is logged here.
 *   2. Whether the steps AFTER the email address stay inside the app's navigation
 *      allowlist. If a hop leaves it, the real app would hand that hop to the system
 *      browser and the flow would die there — that is logged as APP-WOULD-BLOCK.
 *
 * Run (from the repo root, PowerShell):
 *
 *   node_modules\electron\dist\electron.exe tools\diag\email-login-probe.js
 *
 * The user types their own email / code; the probe never fills a field and never
 * reads a credential. Logs: %TEMP%\gpt-login-diag\email-login-<timestamp>.log
 *
 * The window uses the app's REAL `persist:chatgpt` partition, so a successful login
 * here also logs the app in.
 */
const { app, BrowserWindow, session, shell } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const PARTITION = process.env.PROBE_PARTITION || 'persist:chatgpt'
const LOG_DIR = process.env.PROBE_LOG_DIR || path.join(app.getPath('temp'), 'gpt-login-diag')

app.setPath(
  'userData',
  process.env.PROBE_USER_DATA || path.join(app.getPath('appData'), 'GPT Web to Codex Terminal')
)

const START_URL = process.env.PROBE_START_URL || 'https://auth.openai.com/log-in'

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
fs.mkdirSync(LOG_DIR, { recursive: true })
const LOG_FILE = path.join(LOG_DIR, `email-login-${stamp}.log`)

/**
 * Synchronous append: a write stream buffers 16 KB and can lose an entire run when
 * the window is closed mid-flow.
 */
function log(...parts) {
  const line = `[${new Date().toISOString().slice(11, 23)}] ${parts.map(String).join(' ')}`
  try {
    fs.appendFileSync(LOG_FILE, line + '\n')
  } catch (error) {
    console.log('log write failed:', error.message)
  }
  console.log(line)
}

const shorten = (url, max = 200) => String(url).slice(0, max)

/**
 * The app's own allowlist, copied verbatim from src/main/embed.ts.
 *
 * Duplicated on purpose so this probe can say whether the REAL app would have kept
 * each hop inside the embed. Keep it in sync when that regex changes, or the
 * verdict becomes a lie.
 */
const APP_ALLOWLIST =
  /^https:\/\/([a-z0-9-]+\.)*(chatgpt\.com|openai\.com|oaistatic\.com|oaiusercontent\.com)(\/|$)/i

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  `Chrome/${process.versions.chrome} Safari/537.36`

const hops = []
let lastDescription = null

function noteHop(kind, url) {
  const allowed = APP_ALLOWLIST.test(url)
  hops.push({ kind, url, allowed, at: Date.now() })
  log(`${kind} ${allowed ? 'APP-ALLOWS' : 'APP-WOULD-BLOCK'} ${shorten(url, 220)}`)
  if (!allowed) {
    try {
      log(`  ^ host ${new URL(url).hostname} is NOT in the embed allowlist -> the real app sends this to the system browser`)
    } catch {
      /* ignore */
    }
  }
}

/** Everything the page is willing to say about itself. */
async function describe(wc, label) {
  try {
    const info = await wc.executeJavaScript(
      `(() => {
         const html = document.documentElement ? document.documentElement.outerHTML : ''
         return {
           url: location.href,
           title: document.title,
           emailField: !!document.querySelector('input[type=email], input[name=email], input#email-input'),
           codeField: !!document.querySelector('input[autocomplete=one-time-code], input[name=code], input#code'),
           passwordField: !!document.querySelector('input[type=password]'),
           phoneField: !!document.querySelector('input[type=tel]'),
           inputs: [...document.querySelectorAll('input')].map(i => (i.type || '') + ':' + (i.name || i.id || '')).slice(0, 12),
           buttons: [...document.querySelectorAll('button, a[href]')]
             .map(el => (el.innerText || '').trim()).filter(Boolean).slice(0, 16),
           text: (document.body ? document.body.innerText : '').replace(/\\n{2,}/g, '\\n').slice(0, 700),
           cloudflare: /cf-challenge|Just a moment|Checking your browser|cf_chl|Verify you are human|Enable JavaScript and cookies/i.test(html),
           sessionEnded: /会话已结束|session (has )?ended|session expired/i.test(html)
         }
       })()`
    )
    lastDescription = info
    log(`${label} url=`, shorten(info.url, 220))
    log(`${label} title=`, JSON.stringify(info.title))
    log(
      `${label} fields email=${info.emailField} code=${info.codeField} password=${info.passwordField} phone=${info.phoneField}` +
        ` | cloudflare=${info.cloudflare} sessionEnded=${info.sessionEnded}`
    )
    log(`${label} inputs=`, JSON.stringify(info.inputs))
    log(`${label} controls=`, JSON.stringify(info.buttons))
    log(`${label} body=`, JSON.stringify(info.text.slice(0, 700)))
    return info
  } catch (error) {
    log(`${label} describe failed:`, error.message)
    return null
  }
}

async function cookieSummary(ses, label) {
  try {
    const cookies = await ses.cookies.get({})
    const interesting = [...new Set(
      cookies
        .filter((c) => /openai|chatgpt/i.test(c.domain))
        .map((c) => `${c.domain} ${c.name}(len=${String(c.value || '').length})`)
    )]
    log(`${label} COOKIES total=${cookies.length} openai/chatgpt=`, JSON.stringify(interesting.slice(0, 30)))
  } catch (error) {
    log(`${label} cookie dump failed:`, error.message)
  }
}

app.whenReady().then(async () => {
  log('=== email-login-probe ===')
  log('electron', process.versions.electron, 'chrome', process.versions.chrome)
  log('partition', PARTITION)
  log('startUrl', START_URL)
  log('logFile', LOG_FILE)

  const ses = session.fromPartition(PARTITION)

  // Anything the real app would have pushed to the system browser: recorded, and
  // deliberately NOT opened here so this window stays the single observer.
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(false))

  ses.webRequest.onCompleted({ urls: ['*://*/*'] }, (details) => {
    let host = ''
    try {
      host = new URL(details.url).hostname
    } catch {
      /* ignore */
    }
    if (!/openai|chatgpt|cloudflare/i.test(host)) return
    if (details.statusCode < 400 && details.resourceType !== 'xhr') return
    log(`NET ${details.statusCode} ${details.method} ${details.resourceType} ${shorten(details.url, 240)}`)
  })

  const win = new BrowserWindow({
    width: 1120,
    height: 920,
    title: '邮箱登录探针 — 请用你自己的邮箱走完登录，然后关掉窗口',
    backgroundColor: '#141922',
    webPreferences: {
      partition: PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      userAgent: CHROME_UA
    }
  })

  const wc = win.webContents
  wc.setUserAgent(CHROME_UA)

  wc.on('did-start-navigation', (d) => {
    if (d.isMainFrame) noteHop('START', d.url)
  })
  wc.on('did-navigate', (_e, url, code) => {
    noteHop(`NAV(${code})`, url)
    setTimeout(() => void describe(wc, 'AFTER-NAV'), 2500)
  })
  wc.on('did-navigate-in-page', (_e, url, isMain) => {
    if (isMain) {
      noteHop('IN-PAGE', url)
      setTimeout(() => void describe(wc, 'AFTER-IN-PAGE'), 2000)
    }
  })
  wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (isMain) log(`FAIL-LOAD ${code} ${desc} ${shorten(url, 200)}`)
  })
  wc.on('did-finish-load', () => log('FINISHED LOAD:', shorten(wc.getURL(), 200), '|', wc.getTitle()))
  wc.on('console-message', (d) => {
    const m = String(d.message)
    if (/error|fail|block|denied|unauthor|expired/i.test(m)) log('console:', m.slice(0, 260))
  })

  // The app denies new windows and opens the system browser instead. Same decision
  // here, but recorded instead of launched — that difference is what makes the log
  // readable.
  wc.setWindowOpenHandler(({ url, disposition }) => {
    log(`WINDOW-OPEN REQUEST [${disposition}] ${shorten(url, 220)}`)
    if (!APP_ALLOWLIST.test(url)) log('  ^ popup to a non-allowlisted host -> real app would call shell.openExternal')
    return { action: 'deny' }
  })

  void shell // kept explicit: this probe deliberately never calls openExternal

  const timer = setInterval(() => {
    if (!win.isDestroyed()) void describe(wc, 'TICK')
  }, 15000)

  await cookieSummary(ses, 'BEFORE')
  log('loading', START_URL, '— the user now drives')
  await wc.loadURL(START_URL).catch((e) => log('loadURL rejected:', e.message))
  await new Promise((r) => setTimeout(r, 8000))
  await describe(wc, 'INITIAL')

  win.on('closed', async () => {
    clearInterval(timer)
    await cookieSummary(ses, 'AFTER')

    log('--- HOP SUMMARY (last 30) ---')
    for (const hop of hops.slice(-30)) {
      log(`  ${hop.allowed ? 'allow' : 'BLOCK'} ${hop.kind} ${shorten(hop.url, 150)}`)
    }

    const blocked = hops.filter((h) => !h.allowed)
    if (blocked.length > 0) {
      const hosts = [...new Set(blocked.map((h) => {
        try {
          return new URL(h.url).hostname
        } catch {
          return h.url
        }
      }))]
      log('VERDICT: the email flow leaves the allowlist at', JSON.stringify(hosts))
      log('VERDICT: those hops would be handed to the system browser by the real app -> fix the allowlist or the entry point.')
    } else if (lastDescription?.sessionEnded) {
      log('VERDICT: page rendered the "session ended" dead end — no form. Not an allowlist problem.')
    } else if (lastDescription?.cloudflare) {
      log('VERDICT: blocked by a Cloudflare interstitial, not by policy.')
    } else if (lastDescription?.codeField || lastDescription?.passwordField) {
      log('VERDICT: the flow reached a code/password step inside the allowlist -> the email route is usable.')
    } else if (lastDescription?.emailField) {
      log('VERDICT: stopped at the email form (flow not driven to the end).')
    } else {
      log('VERDICT: inconclusive — read the describe lines above.')
    }
    log('=== window closed, log complete ===')
    app.quit()
  })
})
