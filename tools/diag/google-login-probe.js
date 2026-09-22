/**
 * Google-login diagnostic probe  (decision run)
 *
 * ONE question: with the embedded identity patched on the wire (User-Agent plus
 * Sec-CH-UA client hints), does Google's OAuth flow run to completion — or is it
 * still cut off at /signin/rejected?
 *
 * Run it (from the repo root):
 *
 *   node_modules\electron\dist\electron.exe tools\diag\google-login-probe.js
 *
 * The user clicks through the real sign-in; the probe records every Google request
 * and response and writes a verdict. It never types, submits, or reads credentials.
 *
 * Logs: %TEMP%\gpt-login-diag\google-login-<timestamp>.log
 *
 * WHY THE IDENTITY IS PATCHED, AND WHAT WAS LEARNED FIRST
 * ------------------------------------------------------
 * `webContents.setUserAgent()` DOES reach the wire (verified against
 * onBeforeSendHeaders on this runtime), and this Electron's stock UA has no
 * "Electron" token anyway. So the refusal is not about the UA string.
 *
 * What IS visibly wrong is the client-hint brand list: the page reports
 * `navigator.userAgentData.brands = ["Not?A_Brand", "Chromium"]` — a real Chrome
 * also advertises `"Google Chrome"`. Electron 44 has no `setUserAgentMetadata`,
 * so the only way to correct that is to rewrite `Sec-CH-UA*` in
 * `onBeforeSendHeaders` on the partition's session.
 *
 * That rewrite is the whole experiment. If the flow still dies at
 * /signin/rejected, spoofing is not the answer and the app needs a different route.
 */
const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const PARTITION = process.env.PROBE_PARTITION || 'persist:chatgpt'
const LOG_DIR = process.env.PROBE_LOG_DIR || path.join(app.getPath('temp'), 'gpt-login-diag')

// Same jar as the real app, so what is observed is the app's real login state.
app.setPath(
  'userData',
  process.env.PROBE_USER_DATA || path.join(app.getPath('appData'), 'GPT Web to Codex Terminal')
)

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
fs.mkdirSync(LOG_DIR, { recursive: true })
const LOG_FILE = path.join(LOG_DIR, `google-login-${stamp}.log`)

/**
 * Synchronous append, deliberately.
 *
 * A write stream buffers up to 16 KB, so a run that ends with the window closed
 * mid-flow leaves a 0-byte file with the whole session still in memory — which is
 * how the first version of this probe lost a run.
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

const chromeVersion = String(process.versions.chrome)
const majorVersion = chromeVersion.split('.')[0]
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  `Chrome/${chromeVersion} Safari/537.36`

/** What a real Chrome advertises in Sec-CH-UA. */
const CHROME_BRANDS = `"Google Chrome";v="${majorVersion}", "Chromium";v="${majorVersion}", "Not(A:Brand";v="24"`
const CHROME_FULL_VERSION_LIST =
  `"Google Chrome";v="${chromeVersion}", "Chromium";v="${chromeVersion}", "Not(A:Brand";v="24.0.0.0"`

let patchedRequests = 0

/**
 * Rewrite the client-hint headers on every request this partition makes.
 *
 * Electron exposes no API for the brand list, and a mismatch here is exactly the
 * fingerprint an embedded browser shows: same UA, wrong brands.
 */
function installIdentityPatch(ses) {
  /*
   * Record FIRST, then rewrite — in ONE handler, on purpose.
   *
   * Electron keeps a single `onBeforeSendHeaders` listener per session: a second
   * registration replaces the first. Registering a separate recorder would
   * therefore either be silently dropped or overwrite the patch, and the log would
   * show unpatched headers while the wire carried patched ones — the exact
   * ambiguity that wastes a diagnostic run.
   */
  ses.webRequest.onBeforeSendHeaders({ urls: ['*://*/*'] }, (details, callback) => {
    const host = safeHost(details.url)
    const googleOwned = /(^|\.)google\.com$/.test(host)
    const headers = { ...details.requestHeaders }

    const find = (source, name) => {
      const key = Object.keys(source).find((k) => k.toLowerCase() === name)
      return key ? source[key] : '(absent)'
    }

    // What the request WOULD have carried (before the rewrite below).
    if (googleOwned && /accounts\.google\.com/.test(host)) {
      const key = `HDR ${details.resourceType} ${details.url.split('?')[0]}`
      if (!seen.has(key)) {
        seen.add(key)
        log(
          `HDR-IN  ${details.resourceType} ${shorten(details.url, 140)}`,
          `| ua=${find(headers, 'user-agent')}`,
          `| sec-ch-ua=${find(headers, 'sec-ch-ua')}`
        )
      }
    }

    if (!googleOwned) return callback({ requestHeaders: headers })

    let touched = false
    for (const name of Object.keys(headers)) {
      const lower = name.toLowerCase()
      if (lower === 'sec-ch-ua') {
        headers[name] = CHROME_BRANDS
        touched = true
      } else if (lower === 'sec-ch-ua-full-version-list') {
        headers[name] = CHROME_FULL_VERSION_LIST
        touched = true
      } else if (lower === 'sec-ch-ua-full-version') {
        headers[name] = `"${chromeVersion}"`
        touched = true
      } else if (lower === 'user-agent') {
        headers[name] = CHROME_UA
        touched = true
      }
    }
    if (touched) patchedRequests += 1

    // What it will actually carry.
    if (googleOwned && /accounts\.google\.com/.test(host)) {
      const key = `HDR-OUT ${details.resourceType} ${details.url.split('?')[0]}`
      if (!seen.has(key)) {
        seen.add(key)
        log(
          `HDR-OUT ${details.resourceType} ${shorten(details.url, 140)}`,
          `| ua=${find(headers, 'user-agent')}`,
          `| sec-ch-ua=${find(headers, 'sec-ch-ua')}`
        )
      }
    }

    return callback({ requestHeaders: headers })
  })
}

function safeHost(url) {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/* ------------------------------------------------------------------ *
 * What the flow actually did
 * ------------------------------------------------------------------ */

/**
 * Furthest point the sign-in reached.
 *
 * The lesson from the previous run: "Google rendered the login form" says NOTHING
 * — that page loads fine in an embedded browser and the refusal lands a step
 * later. Only these stages mean anything.
 */
let stage = 'started'
const STAGE_ORDER = [
  'started',
  'form',
  'credentials',
  'challenge',
  'rejected',
  'error-return',
  'completed'
]

function noteStage(next, why) {
  if (STAGE_ORDER.indexOf(next) < STAGE_ORDER.indexOf(stage)) return
  if (next === stage) return
  stage = next
  log(`STAGE -> ${next}  (${why})`)
}

function classify(url) {
  if (/accounts\.google\.com\/v3\/signin\/rejected/.test(url)) {
    noteStage('rejected', 'Google sent the flow to /signin/rejected')
  } else if (/accounts\.google\.com\/v3\/signin\/challenge/.test(url)) {
    noteStage('challenge', 'Google asked for a second factor')
  } else if (/accounts\.google\.com\/v3\/signin\/(identifier|pwd)/.test(url)) {
    noteStage('form', 'Google rendered a sign-in form')
  } else if (/chatgpt\.com|\/auth\/|auth\.openai\.com/.test(url) && /[?&]error=/.test(url)) {
    noteStage('error-return', 'the callback came back with an error parameter')
  }
}

/* ------------------------------------------------------------------ *
 * Observation
 * ------------------------------------------------------------------ */

const seen = new Set()

function watchNetwork(ses) {
  ses.webRequest.onCompleted({ urls: ['*://*/*'] }, (details) => {
    const host = safeHost(details.url)
    const google = /(^|\.)google\.com$/.test(host)
    if (!google && !/chatgpt\.com|openai\.com/.test(host)) return

    // Every Google response that is not a plain 200 for a static asset.
    const isNoise = /\.(png|jpg|jpeg|svg|woff2?|css|gif|ico)(\?|$)/i.test(details.url)
    const interesting = details.statusCode >= 300 || details.resourceType === 'xhr'
    if (!interesting || isNoise) return

    const key = `${details.statusCode} ${details.method} ${details.resourceType} ${details.url.split('?')[0]}`
    if (seen.has(key)) return
    seen.add(key)
    log(`NET ${details.statusCode} ${details.method} ${details.resourceType} ${shorten(details.url, 260)}`)
  })

  // `onBeforeSendHeaders` is deliberately NOT registered here: it holds the single
  // slot for this session, and installIdentityPatch() owns it.
}

async function snapshot(wc, label) {
  try {
    const info = await wc.executeJavaScript(
      `(() => {
         const html = document.documentElement ? document.documentElement.outerHTML : ''
         return {
           url: location.href,
           title: document.title,
           text: (document.body ? document.body.innerText : '').replace(/\\n{2,}/g, '\\n').slice(0, 900),
           blocked: /disallowed_useragent|此浏览器或应用可能不安全|browser or app may not be secure|无法登录/i.test(html),
           brands: navigator.userAgentData ? navigator.userAgentData.brands : null,
           highEntropy: null
         }
       })()`
    )
    if (info.brands && /accounts\.google\.com/.test(info.url)) {
      info.highEntropy = await wc
        .executeJavaScript(
          `navigator.userAgentData.getHighEntropyValues(['fullVersionList','platformVersion','architecture','model','bitness','wow64'])
             .then(v => v).catch(e => ({ error: String(e) }))`
        )
        .catch((error) => ({ error: error.message }))
    }
    log(`${label} url=`, shorten(info.url, 220))
    log(`${label} title=`, JSON.stringify(info.title), '| blocked=', String(info.blocked))
    log(`${label} brands=`, JSON.stringify(info.brands))
    log(`${label} highEntropy=`, JSON.stringify(info.highEntropy))
    if (info.blocked) log(`${label} body=`, JSON.stringify(info.text.slice(0, 500)))
    return info
  } catch (error) {
    log(`${label} snapshot failed:`, error.message)
    return null
  }
}

async function dumpCookies(ses, label) {
  try {
    const cookies = await ses.cookies.get({})
    const auth = cookies
      .filter((c) => /next-auth|__Secure-next-auth|oai-sc|session/i.test(c.name))
      .map((c) => `${c.domain} ${c.name}(len=${String(c.value || '').length})`)
    log(`${label} COOKIES total=${cookies.length}`)
    log(`${label} AUTH COOKIES=`, JSON.stringify([...new Set(auth)].slice(0, 20)))
  } catch (error) {
    log(`${label} cookie dump failed:`, error.message)
  }
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

app.whenReady().then(async () => {
  log('=== google-login-probe (identity-patched decision run) ===')
  log('electron', process.versions.electron, 'chrome', chromeVersion)
  log('partition', PARTITION)
  log('userAgent', CHROME_UA)
  log('sec-ch-ua', CHROME_BRANDS)
  log('logFile', LOG_FILE)

  const ses = session.fromPartition(PARTITION)
  watchers(ses)
  installIdentityPatch(ses)
  await dumpCookies(ses, 'BEFORE')

  const win = new BrowserWindow({
    width: 1180,
    height: 940,
    title: 'Google 登录诊断 — 请完整走一遍 Google 登录',
    backgroundColor: '#141922',
    webPreferences: {
      partition: PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: false,
      userAgent: CHROME_UA
    }
  })

  const wc = win.webContents
  wc.setUserAgent(CHROME_UA)

  wc.on('did-navigate', (_e, url) => {
    log('NAVIGATE', shorten(url, 220))
    classify(url)
    if (/^https:\/\/chatgpt\.com\//.test(url) && STAGE_ORDER.indexOf(stage) >= 2) {
      noteStage('completed', 'returned to chatgpt.com from the Google flow')
    }
  })
  wc.on('did-navigate-in-page', (_e, url) => {
    log('IN-PAGE', shorten(url, 220))
    classify(url)
  })
  wc.on('did-fail-load', (_e, code, desc, url) =>
    log('FAIL-LOAD', code, desc, shorten(url, 200))
  )
  wc.on('console-message', (d) => {
    const m = String(d.message)
    // The FedCM / GSI logger lines are the interesting ones on a Google page.
    if (/GSI_LOGGER|FedCM|AbortError|disallowed/i.test(m)) log('console:', m.slice(0, 240))
  })
  wc.setWindowOpenHandler(({ url, disposition }) => {
    log('WINDOW-OPEN REQUEST', `[${disposition}]`, shorten(url))
    return { action: 'allow' }
  })
  wc.on('did-create-window', (child) => {
    log('CHILD WINDOW CREATED')
    child.webContents.setUserAgent(CHROME_UA)
    child.webContents.on('did-navigate', (_e, url) => {
      log('CHILD NAVIGATE', shorten(url, 220))
      classify(url)
    })
  })

  const timer = setInterval(() => {
    if (win.isDestroyed()) return
    void snapshot(wc, `TICK(${stage})`)
  }, 12000)

  log('loading https://chatgpt.com/ — the user now drives')
  await wc.loadURL('https://chatgpt.com/').catch((e) => log('loadURL rejected:', e.message))

  win.on('closed', async () => {
    clearInterval(timer)
    log(`FINAL STAGE: ${stage}`)
    log(`patchedRequests=${patchedRequests}`)
    await dumpCookies(ses, 'AFTER')

    if (stage === 'rejected') {
      log('VERDICT: Google still refused with the brand list patched -> spoofing is NOT the answer.')
    } else if (stage === 'challenge') {
      log('VERDICT: Google asked for a second factor -> the identity was ACCEPTED. Feature is buildable.')
    } else if (stage === 'completed') {
      log('VERDICT: the flow returned to chatgpt.com -> check AUTH COOKIES above for a session token.')
    } else if (stage === 'error-return') {
      log('VERDICT: OpenAI rejected or failed the callback — read the NET/NAVIGATE lines for the reason.')
    } else {
      log(`VERDICT: inconclusive (ended at stage "${stage}") — the flow was not driven to the end.`)
    }
    log('=== window closed, log complete ===')
    app.quit()
  })
})

// Response/status observers only — see the note in installIdentityPatch() about
// why the header slot stays single-owner.
function watchers(ses) {
  watchNetwork(ses)
}
