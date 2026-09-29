/**
 * Gemini DOM probe — and, first, whether a Google session can exist in this partition at all.
 *
 * WHY THE SECOND QUESTION COMES FIRST
 * -----------------------------------
 * `gemini.google.com` is a Google property and needs a Google account, and this repo has already
 * established that third-party OAuth cannot complete inside an embedded view:
 * `accounts.google.com` answers `/v3/signin/rejected` even with a patched UA and a corrected
 * Sec-CH-UA brand list (recorded in `src/shared/types.ts` beside EMBED_LOGIN_URL). So a DOM
 * descriptor is worthless if the page cannot get past a sign-in screen, and this probe answers
 * BOTH in one run rather than producing a beautiful dump of a login form.
 *
 * There is one reason to expect this to go differently, and it is in this repo's own notes:
 * Google **renders the sign-in form fine** in the embedded view, and the refusal lands one step
 * LATER, when the flow is handed off to OAuth. Gemini's sign-in is a DIRECT Google sign-in, not
 * a third-party OAuth hand-off — a path nothing here has measured. That is what makes the run
 * worth doing, and the hop log below is what records where it actually goes.
 *
 * WHAT IT REPORTS
 * ---------------
 *   1. Every navigation hop, classified: GEMINI / GOOGLE-AUTH / OTHER-GOOGLE / EXTERNAL, plus
 *      whether the app's candidate allowlist would have kept it embedded or pushed it to the
 *      system browser — which is how the real app would behave.
 *   2. Whether the page is Gemini, a Google sign-in screen, or something else, on every tick.
 *   3. Once (and only once) a real Gemini page is on screen: the same structural dump the Claude
 *      probe produces — composer, toolbar, turn markers, URL shape, one turn's raw markup — so
 *      `GEMINI_PAGE` / `GEMINI_PLATFORM` can be written from one run.
 *
 * Run (from the repo root, PowerShell):
 *
 *   node_modules\electron\dist\electron.exe tools\diag\gemini-dom-probe.js
 *
 * Optional proxy, if this machine cannot reach Google directly:
 *
 *   $env:PROBE_PROXY='http://127.0.0.1:7897'
 *
 * Log: %TEMP%\gpt-login-diag\gemini-dom-<timestamp>.log
 * Markup: the matching .markup.html beside it
 *
 * The probe never types, clicks or submits. The user drives.
 */
const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const PARTITION = process.env.PROBE_PARTITION || 'persist:gemini'
const LOG_DIR = process.env.PROBE_LOG_DIR || path.join(app.getPath('temp'), 'gpt-login-diag')

app.setPath(
  'userData',
  process.env.PROBE_USER_DATA || path.join(app.getPath('appData'), 'GPT Web to Codex Terminal')
)

const START_URL = process.env.PROBE_START_URL || 'https://gemini.google.com/app?hl=zh'
const PROXY = process.env.PROBE_PROXY || ''

/*
 * The client-hint rewrite, which matters MORE here than anywhere else.
 *
 * Electron advertises `["Not?A_Brand","Chromium"]` with no `"Google Chrome"` in `Sec-CH-UA`, and
 * this repo measured that a Chrome User-Agent with that brand list is what a browser pretending
 * to be Chrome looks like. On a Google property it is the first thing looked at. Copied from
 * `claude-dom-probe.js`, where its absence stalled a run on Cloudflare indefinitely.
 */
const chromeVersion = String(process.versions.chrome)
const majorVersion = chromeVersion.split('.')[0]
const CHROME_BRANDS =
  `"Google Chrome";v="${majorVersion}", "Chromium";v="${majorVersion}", "Not(A:Brand";v="24"`
const CHROME_FULL_VERSION_LIST =
  `"Google Chrome";v="${chromeVersion}", "Chromium";v="${chromeVersion}", "Not(A:Brand";v="24.0.0.0"`

app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled')

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
fs.mkdirSync(LOG_DIR, { recursive: true })
const LOG_FILE = path.join(LOG_DIR, `gemini-dom-${stamp}.log`)

/** Synchronous append: a write stream buffers 16 KB and can lose a whole run. */
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

function safeHost(url) {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * How the REAL APP would treat this hop, given the allowlist a Gemini platform would need.
 *
 * This is the decision the whole feature turns on. The app hands anything outside a platform's
 * `allowedOriginPattern` to the system browser — which is also how it deliberately kills
 * embedded OAuth. For Gemini the site IS a Google host, so the allowlist has to include Google,
 * and `accounts.google.com` is the hop that decides whether that is workable or fatal.
 *
 * `APP-WOULD-BLOCK` on the sign-in hop means the real app cannot log itself in, and the session
 * has to arrive some other way — the hand-copied cookie route in `src/main/session-import.ts`,
 * which currently knows only ChatGPT's cookie names.
 */
function classify(url) {
  const host = safeHost(url)
  if (host === 'gemini.google.com') return 'GEMINI'
  if (host === 'accounts.google.com') return 'GOOGLE-AUTH'
  if (/(^|\.)google\.com$/.test(host) || /(^|\.)googleusercontent\.com$/.test(host)) {
    return 'OTHER-GOOGLE'
  }
  return 'EXTERNAL'
}

/** Candidate allowlist for a Gemini platform. Hops that miss it would leave the embed. */
const GEMINI_ALLOWED = /^https:\/\/([a-z0-9-]+\.)*(gemini\.google\.com|google\.com|googleusercontent\.com|gstatic\.com)(\/|$)/i

let patchedRequests = 0
let notedIdentity = false

function installChromeIdentity(ses) {
  ses.webRequest.onBeforeSendHeaders({ urls: ['*://*/*'] }, (details, callback) => {
    const headers = { ...details.requestHeaders }
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
    if (!notedIdentity && touched && /(^|\.)(google\.com)$/.test(safeHost(details.url))) {
      notedIdentity = true
      const key = Object.keys(details.requestHeaders || {}).find(
        (candidate) => candidate.toLowerCase() === 'sec-ch-ua'
      )
      log(
        'identity patch on the wire for',
        safeHost(details.url),
        '| sec-ch-ua was',
        JSON.stringify(key ? details.requestHeaders[key] : '(absent)'),
        '-> now',
        JSON.stringify(CHROME_BRANDS)
      )
    }

    return callback({ requestHeaders: headers })
  })
}

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  `Chrome/${process.versions.chrome} Safari/537.36`

/**
 * Runs in the page. Pure observation — no clicks, no typing.
 *
 * Structure over hypothesis: it reports what EXISTS before it reports whether a guess was right,
 * so a run is not wasted when every guess is wrong.
 */
const INSPECT = `(() => {
  /*
   * Guesses, NOT knowledge. A miss means nothing; the structure below is the deliverable.
   *
   * The custom-element names are the interesting ones: Gemini is an Angular app, and Angular
   * component selectors (rich-textarea, model-response, user-query) are far more stable than the
   * generated class names beside them.
   */
  const HYPOTHESES = {
    composer: [
      'rich-textarea div[contenteditable="true"]',
      'div.ql-editor[contenteditable="true"]',
      'div[contenteditable="true"]',
      'textarea'
    ],
    sendButton: [
      'button[aria-label="Send message"]',
      'button[aria-label="发送消息"]',
      'button.send-button',
      'button[type="submit"]'
    ],
    stopButton: [
      'button[aria-label="Stop response"]',
      'button[aria-label="Stop"]',
      'button[aria-label="停止回答"]',
      'button[aria-label="停止生成"]'
    ],
    assistant: ['model-response', '[data-test-id="model-response"]', 'message-content'],
    message: ['user-query', 'model-response', '[data-test-id="user-query"]']
  }

  const clip = (value, max) => String(value == null ? '' : value).slice(0, max)

  const describe = (el, max) => {
    if (!el) return null
    const attrs = {}
    for (const a of el.attributes || []) {
      if (/^(data-|aria-|role$|type$|placeholder$|contenteditable$|id$|class$)/.test(a.name)) {
        attrs[a.name] = clip(a.value, 110)
      }
    }
    return { tag: el.tagName.toLowerCase(), attrs, text: clip(el.innerText || el.value || '', 70) }
  }

  const testSelector = (selector) => {
    let nodes = []
    try {
      nodes = [...document.querySelectorAll(selector)]
    } catch (error) {
      return { selector, error: String(error && error.message) }
    }
    return { selector, count: nodes.length, first: describe(nodes[0], 90) }
  }

  const hypothesisReport = {}
  for (const group of Object.keys(HYPOTHESES)) {
    hypothesisReport[group] = HYPOTHESES[group].map(testSelector)
  }

  /*
   * Both spellings. Angular projects tend to use data-test-id; the rest of the web uses
   * data-testid, and ChatGPT used neither by the end. Counting VALUES exposes role markers that
   * an attribute-name histogram cannot see.
   */
  const testIdHistogram = {}
  for (const attr of ['data-test-id', 'data-testid']) {
    for (const el of document.querySelectorAll('[' + attr + ']')) {
      const value = attr + '=' + (el.getAttribute(attr) || '')
      testIdHistogram[value] = (testIdHistogram[value] || 0) + 1
    }
  }

  const dataAttrHistogram = {}
  for (const el of document.querySelectorAll('*')) {
    for (const a of el.attributes || []) {
      if (!a.name.startsWith('data-')) continue
      dataAttrHistogram[a.name] = (dataAttrHistogram[a.name] || 0) + 1
    }
  }

  const idishAttrs = {}
  for (const name of Object.keys(dataAttrHistogram)) {
    if (/(^|-)id$|key|turn|message|uuid|index|seq|conversation|chat/i.test(name)) {
      idishAttrs[name] = dataAttrHistogram[name]
    }
  }

  /* Angular custom elements are the most stable structural hook available on this site. */
  const customElements = [...document.querySelectorAll('*')]
    .map((el) => el.tagName.toLowerCase())
    .filter((tag) => tag.indexOf('-') !== -1)
  const customElementHistogram = {}
  for (const tag of customElements) {
    customElementHistogram[tag] = (customElementHistogram[tag] || 0) + 1
  }

  const composerEl = document.querySelector(
    'rich-textarea div[contenteditable="true"], div.ql-editor[contenteditable="true"], div[contenteditable="true"], textarea, [role="textbox"]'
  )
  const composerText = composerEl
    ? clip(composerEl.value != null ? composerEl.value : composerEl.innerText, 80)
    : ''

  const composerCandidates = [
    ...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')
  ]
    .slice(0, 8)
    .map((el) => describe(el, 120))

  const composerChain = []
  let chainNode = composerEl
  let chainGuard = 0
  while (chainNode && chainNode !== document.body && chainGuard < 12) {
    const cls = typeof chainNode.className === 'string' ? chainNode.className : ''
    composerChain.push({
      tag: chainNode.tagName.toLowerCase(),
      cls: clip(cls, 70),
      controls: chainNode.querySelectorAll('button, [role="button"]').length,
      dataAttrs: [...(chainNode.attributes || [])]
        .filter((a) => a.name.startsWith('data-'))
        .map((a) => a.name + '=' + clip(a.value, 30))
    })
    chainNode = chainNode.parentElement
    chainGuard += 1
  }

  /*
   * The composer's toolbar, BOTH ENDS — the primary action is at the END, and taking only the
   * first N is how the ChatGPT probe once came back with twelve unrelated chips and no primary
   * action. toolbarCount says when the two windows left a gap.
   */
  let toolbar = composerEl
  let hops = 0
  while (toolbar && toolbar !== document.body && hops < 12) {
    if (toolbar.querySelectorAll('button, [role="button"]').length >= 2) break
    toolbar = toolbar.parentElement
    hops += 1
  }
  const toolbarControls =
    toolbar && toolbar !== document.body
      ? [...toolbar.querySelectorAll('button, [role="button"]')]
      : []

  const describeControl = (el) => {
    const cls = typeof el.className === 'string' ? el.className : ''
    return {
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || '',
      testid: el.getAttribute('data-test-id') || el.getAttribute('data-testid') || '',
      aria: clip(el.getAttribute('aria-label'), 60),
      title: clip(el.getAttribute('title'), 40),
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
      text: clip(el.innerText, 24),
      cls: clip(cls, 200)
    }
  }

  const seenControls = new Set()
  const pickedControls = []
  for (const el of [...toolbarControls.slice(0, 8), ...toolbarControls.slice(-16)]) {
    if (seenControls.has(el)) continue
    seenControls.add(el)
    pickedControls.push(el)
  }

  const buttons = [...document.querySelectorAll('button, [role="button"]')]
    .slice(0, 40)
    .map(describeControl)

  const turnAnchor =
    [...document.querySelectorAll('model-response')].pop() ||
    [...document.querySelectorAll('[data-test-id*="response" i], [data-test-id*="message" i]')].pop() ||
    [...document.querySelectorAll('[class*="response" i], [class*="message" i]')].pop() ||
    null

  const ancestorChain = (element, limit) => {
    const chain = []
    let node = element
    let guard = 0
    while (node && node !== document.body && guard < (limit || 20)) {
      const cls = typeof node.className === 'string' ? node.className : ''
      chain.push({
        tag: node.tagName.toLowerCase(),
        cls: clip(cls, 90),
        children: node.children.length,
        responses: node.querySelectorAll('model-response').length,
        dataAttrs: [...(node.attributes || [])]
          .filter((a) => a.name.startsWith('data-'))
          .map((a) => a.name + '=' + clip(a.value, 36))
      })
      node = node.parentElement
      guard += 1
    }
    return chain
  }

  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,

    pathname: location.pathname,
    pathSegments: location.pathname.split('/').filter((part) => part !== ''),
    search: location.search,
    hash: location.hash,

    identity: {
      webdriver: navigator.webdriver === true,
      brands:
        navigator.userAgentData && navigator.userAgentData.brands
          ? navigator.userAgentData.brands.map((b) => b.brand + '/' + b.version)
          : null,
      ua: clip(navigator.userAgent, 130)
    },

    /*
     * What KIND of page this is, decided from the DOM rather than from the URL alone — the URL
     * says gemini.google.com even while a sign-in form is what is actually rendered.
     */
    pageKind: (() => {
      if (document.querySelector('input[type="password"], input[name="Passwd"]')) return 'google-signin'
      if (document.querySelector('rich-textarea, model-response, user-query')) return 'gemini'
      if (/accounts\\.google\\.com/.test(location.host)) return 'google-account'
      if (document.querySelector('input[type="email"], input[name="identifier"]')) return 'google-identifier'
      return 'unknown'
    })(),
    bodyHead: clip((document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').trim(), 220),

    hypothesisReport,
    dataAttrHistogram,
    idishAttrs,
    testIdHistogram,
    customElementHistogram,

    composerText,
    composerCandidateCount: composerCandidates.length,
    composerCandidates,
    composerChain,
    toolbarCount: toolbarControls.length,
    toolbar: pickedControls.map(describeControl),

    buttons,
    buttonCount: document.querySelectorAll('button, [role="button"]').length,

    turnAnchor: describe(turnAnchor, 110),
    turnAncestors: turnAnchor ? ancestorChain(turnAnchor) : [],

    sidebarLinks: [...document.querySelectorAll('a[href]')]
      .map((a) => ({ href: clip(a.getAttribute('href'), 70), text: clip(a.innerText, 40) }))
      .filter((entry) => /^\\/app\\//.test(entry.href))
      .slice(0, 8),

    /*
     * Raw markup of one turn, so the descriptor can be written without another run.
     *
     * Text is replaced with a marker and long attribute values are truncated: the goal is the
     * SHAPE, and shipping the user's actual conversation out of the page is not part of that.
     */
    turnHtml: (() => {
      if (!turnAnchor) return ''
      const html = turnAnchor.outerHTML
      if (html.length < 400) return ''
      return html
        .replace(/>[^<]{40,}</g, '>«text»<')
        .replace(/="[^"]{80,}"/g, '="«long»"')
        .slice(0, 70000)
    })()
  }
})()`

/** Separate file: one turn's markup would bury the readable log lines. */
function dumpMarkup(label, html) {
  if (!html) {
    log(`${label} markup: (empty — no turn found yet)`)
    return
  }
  const file = LOG_FILE.replace(/\.log$/, '.markup.html')
  try {
    fs.appendFileSync(file, `\n<!-- ===== ${label} @ ${new Date().toISOString()} ===== -->\n${html}\n`)
    log(`${label} markup appended to`, file, `(${html.length} chars)`)
  } catch (error) {
    log(`${label} markup write failed:`, error.message)
  }
}

/**
 * HIT/MISS for one group of guesses.
 *
 * `qualifier` for the same reason as the other probes: a MISS is only evidence when the element
 * could have been on screen. On a sign-in page NOTHING is on screen, so every group misses and
 * none of it means anything — which the pageKind line above states outright.
 */
function summariseHypotheses(group, report, qualifier) {
  for (const entry of report) {
    const status = entry.error ? 'ERROR' : entry.count > 0 ? 'HIT ' : 'MISS'
    log(
      `    ${status} ${entry.selector}`,
      entry.error
        ? entry.error
        : `count=${entry.count}` + (entry.first ? ' first=' + JSON.stringify(entry.first) : '')
    )
  }
  const anyHit = report.some((entry) => entry.count > 0)
  log(`  ${group}: ${anyHit ? 'a guess LANDED' : 'no guess landed — use the structure below'}`)
  if (!anyHit && qualifier) log(`      ^ ${qualifier}`)
  return anyHit
}

let landedGroups = []
let sawGemini = false
let sawSignIn = false
let lastPageKind = ''

async function inspect(wc, label) {
  try {
    const info = await wc.executeJavaScript(INSPECT)
    log(`--- ${label} ---`)
    log(`${label} url=`, shorten(info.url))
    log(`${label} title=`, JSON.stringify(info.title), 'readyState=', info.readyState)
    log(
      `${label} path=`,
      JSON.stringify(info.pathname),
      'segments=',
      JSON.stringify(info.pathSegments),
      'search=',
      JSON.stringify(info.search)
    )
    log(
      `${label} identity:`,
      'webdriver=' + String(info.identity.webdriver),
      'brands=' + JSON.stringify(info.identity.brands)
    )
    /*
     * The headline of this run. Printed before anything else, because on a sign-in page the rest
     * of the section is noise and would otherwise read as "the selectors are broken".
     */
    lastPageKind = info.pageKind
    log(`${label} pageKind=`, info.pageKind, '| body starts:', JSON.stringify(info.bodyHead))
    if (info.pageKind !== 'gemini') {
      sawSignIn = true
      log(
        `    ^ NOT A GEMINI PAGE. Nothing below is evidence about the descriptor — this is the`
      )
      log(
        `      sign-in question, and the NAVIGATE lines above say which hop the app would block.`
      )
    } else {
      sawGemini = true
    }

    log(`${label} hypothesis selectors (guesses — a MISS means nothing):`)
    const qualifiers = {
      composer:
        info.pageKind === 'gemini'
          ? null
          : 'A MISS HERE PROVES NOTHING — this is not a Gemini page yet.',
      sendButton: {
        text: 'A MISS HERE PROVES NOTHING if the composer is empty or this is a sign-in page.'
      },
      stopButton: {
        text: 'A MISS HERE PROVES NOTHING unless a reply was streaming at this tick.'
      },
      assistant: null,
      message: null
    }
    landedGroups = []
    for (const group of Object.keys(info.hypothesisReport)) {
      if (summariseHypotheses(group, info.hypothesisReport[group], qualifiers[group])) {
        landedGroups.push(group)
      }
    }

    log(`${label} data-test-id VALUES (highest count first) — where role markers live:`)
    const testIds = Object.entries(info.testIdHistogram || {}).sort((a, b) => b[1] - a[1])
    if (testIds.length === 0) log('    (none)')
    for (const [value, count] of testIds.slice(0, 30)) {
      log(`    ${String(count).padStart(4)}x ${JSON.stringify(value)}`)
    }

    /*
     * Angular custom elements: on this site they are the most stable structural hook there is,
     * because the class names beside them are generated.
     */
    log(`${label} custom elements (Angular component tags), highest count first:`)
    const tags = Object.entries(info.customElementHistogram || {}).sort((a, b) => b[1] - a[1])
    if (tags.length === 0) log('    (none)')
    for (const [tag, count] of tags.slice(0, 30)) {
      log(`    ${String(count).padStart(4)}x <${tag}>`)
    }

    log(`${label} id-ish data-* attributes (candidates for messageIdAttr):`)
    const idish = Object.entries(info.idishAttrs || {}).sort((a, b) => b[1] - a[1])
    if (idish.length === 0) log('    (none)')
    for (const [name, count] of idish.slice(0, 20)) log(`    ${String(count).padStart(4)}x ${name}`)

    log(`${label} composer chain (innermost -> out):`)
    for (const [i, step] of (info.composerChain || []).entries()) {
      log(
        `    ${String(i).padStart(2)} <${step.tag} class="${step.cls}"> controls=${step.controls} ${step.dataAttrs.join(' ')}`
      )
    }
    log(`${label} composer toolbar (${info.toolbarCount}) — the primary action is at the END:`)
    for (const [i, b] of (info.toolbar || []).entries()) {
      log(
        `    ${String(i).padStart(2)} <${b.tag}> role="${b.role}" testid="${b.testid}" aria="${b.aria}" title="${b.title}" disabled=${b.disabled} text=${JSON.stringify(b.text)} class="${b.cls}"`
      )
    }
    log(`${label} composerText=`, JSON.stringify(info.composerText), 'candidates=', String(info.composerCandidateCount))
    for (const [i, c] of (info.composerCandidates || []).entries()) {
      log(`    ${String(i).padStart(2)} ${JSON.stringify(c)}`)
    }

    log(`${label} turnAnchor=`, JSON.stringify(info.turnAnchor))
    log(`${label} turn ancestors (innermost -> body):`)
    for (const [i, s] of (info.turnAncestors || []).entries()) {
      log(
        `    ${String(i).padStart(2)} <${s.tag} class="${s.cls}"> children=${s.children} responsesInside=${s.responses} ${s.dataAttrs.join(' ')}`
      )
    }

    log(`${label} sidebar links=`, String((info.sidebarLinks || []).length), JSON.stringify(info.sidebarLinks))

    log(`${label} buttons (${info.buttonCount}), first 40:`)
    for (const [i, b] of (info.buttons || []).entries()) {
      log(
        `    ${String(i).padStart(2)} <${b.tag}> role="${b.role}" testid="${b.testid}" aria="${b.aria}" disabled=${b.disabled} text=${JSON.stringify(b.text)} class="${b.cls}"`
      )
    }

    dumpMarkup(label, info.turnHtml)
  } catch (error) {
    log(`${label} inspect failed:`, error.message)
  }
}

app.whenReady().then(async () => {
  log('=== gemini DOM probe ===')
  log('electron', process.versions.electron, 'chrome', process.versions.chrome)
  log('partition', PARTITION)
  log('startUrl', START_URL)
  log('proxy', PROXY === '' ? '(none — set PROBE_PROXY if Google is unreachable)' : PROXY)
  log('sec-ch-ua brands ->', CHROME_BRANDS)
  log('logFile', LOG_FILE)
  log('')
  log('TWO QUESTIONS, IN THIS ORDER:')
  log('  1. Can a Google session exist in this partition at all? Gemini is a Google property,')
  log('     and this repo has already measured that third-party OAuth is refused inside an')
  log('     embedded view (accounts.google.com -> /v3/signin/rejected). What has NOT been')
  log('     measured is a DIRECT Google sign-in, which is what Gemini uses.')
  log('  2. If it can: what are the composer, turn markers and URL shape?')
  log('')
  log('DO THIS:')
  log('  1. If a Google sign-in form appears, TRY IT — that is question 1, and the answer is')
  log('     worth more than the DOM dump. Type your own account and password; the probe only')
  log('     watches. If it ends at /v3/signin/rejected or similar, that settles it.')
  log('  2. If Gemini loads: open a conversation that already has a few turns.')
  log('  3. Type a few characters into the composer and STOP — do not send. Wait ~15s so a tick')
  log('     lands with the text still in the box.')
  log('  4. Send it and leave the reply STREAMING ~15s, so a tick catches the stop control.')
  log('  5. Let it finish, wait ~15s more, then close the window.')

  const ses = session.fromPartition(PARTITION)
  installChromeIdentity(ses)

  /*
   * Report the cookie jar BEFORE loading anything.
   *
   * This is the difference between two failures that look identical on screen: the session was
   * never there (the import did not persist — Chromium flushes its cookie store asynchronously,
   * so a process that is KILLED rather than closed can lose it), versus the session is there and
   * Google rejected it. The second run of this probe landed on a signed-out Gemini page with no
   * way to tell which, which is exactly the round trip this line removes.
   *
   * Names and lengths only — a Google session cookie is a full account credential.
   */
  try {
    const jar = await ses.cookies.get({ domain: '.google.com' })
    log(`cookie jar for .google.com at startup: ${jar.length} cookie(s)`)
    if (jar.length === 0) {
      log('    ^ EMPTY. The import did not persist — run gemini-cookie-probe.js again and CLOSE')
      log('      its window with the X button, so Chromium flushes the store before exiting.')
    } else {
      for (const cookie of jar.slice(0, 40)) {
        log(`    ${cookie.name} (${String(cookie.value || '').length})`)
      }
      const have = new Set(jar.map((cookie) => cookie.name))
      const critical = ['SID', '__Secure-1PSID', '__Secure-3PSID']
      const missing = critical.filter((name) => !have.has(name))
      log(
        missing.length === 0
          ? '    ^ the critical auth cookies are present, so a signed-out page means Google' +
              ' rejected the session, not that it was lost'
          : `    ^ MISSING ${missing.join(', ')} — the import is incomplete`
      )
    }
  } catch (error) {
    log('could not read the cookie jar:', error.message)
  }

  if (PROXY !== '') {
    try {
      await ses.setProxy({ proxyRules: PROXY })
      log('proxy applied to', PARTITION)
    } catch (error) {
      log('proxy could not be applied:', error.message)
    }
  }

  ses.webRequest.onCompleted({ urls: ['*://*/*'] }, (details) => {
    if (details.statusCode < 400) return
    log(`NET ${details.statusCode} ${details.method} ${details.resourceType} ${shorten(details.url, 200)}`)
  })

  const win = new BrowserWindow({
    width: 1280,
    height: 940,
    title: 'Gemini DOM 探针 — 先试登录 → 再打开有内容的对话 → 打字但别发 → 停 15 秒 → 发送并保持流式 → 关窗',
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

  /*
   * Every hop, classified, with the verdict the REAL APP would reach.
   *
   * This is the log that decides the feature: if the sign-in hop is APP-WOULD-BLOCK, the embed
   * cannot log itself in and the session has to arrive by the hand-copied cookie route.
   */
  const reportHop = (kind, url) => {
    const category = classify(url)
    const allowed = GEMINI_ALLOWED.test(url)
    log(`${kind} ${category} ${allowed ? 'APP-ALLOWS' : 'APP-WOULD-BLOCK'} ${shorten(url, 200)}`)
  }

  wc.on('did-navigate', (_e, url) => reportHop('NAVIGATE', url))
  wc.on('did-navigate-in-page', (_e, url, isMain) => {
    if (isMain) reportHop('IN-PAGE', url)
  })
  wc.on('did-finish-load', () => log('FINISHED LOAD:', shorten(wc.getURL(), 160), '|', wc.getTitle()))

  log('loading', START_URL, '— the user drives; this probe only reads the DOM')
  await wc.loadURL(START_URL).catch((e) => log('loadURL rejected:', e.message))
  await new Promise((r) => setTimeout(r, 7000))
  await inspect(wc, 'INITIAL')

  /*
   * 5 seconds, not 15, and this probe is the reason.
   *
   * The first successful run ticked every 15s and never caught a reply MID-GENERATION: the user
   * typed (two ticks), sent, and by the next tick the toolbar was back to its idle 3 controls —
   * so the stop button, which only exists while generating, was never on screen at a sample.
   * Generation on this site is fast enough that a 15s window can step straight over it.
   *
   * The other probes can afford 15s because their selectors are tested against states that
   * persist. This one is still DISCOVERING, and the two states it needs — text in the composer,
   * and a reply in flight — are both transient. More samples is strictly better, and a run is
   * minutes long.
   */
  const timer = setInterval(() => {
    if (!win.isDestroyed()) void inspect(wc, 'TICK')
  }, 5000)

  win.on('closed', async () => {
    clearInterval(timer)
    await inspect(wc, 'FINAL')
    log('')
    log('=== VERDICT ===')
    log('last pageKind:', lastPageKind)
    log('a real Gemini page was seen:', String(sawGemini))
    log('')
    if (!sawGemini) {
      log('QUESTION 1 IS UNANSWERED BY THE DOM — no Gemini page ever loaded.')
      log('→ read the NAVIGATE lines: a GOOGLE-AUTH hop marked APP-WOULD-BLOCK is the one that')
      log('  decides it, because that is the hop the real app would push to the system browser.')
      log('→ if the sign-in was refused (look for /signin/rejected or a 4xx on accounts.google.com),')
      log('  the session cannot be established from inside the embed, and the hand-copied cookie')
      log('  route in src/main/session-import.ts is the only one left. That module knows only')
      log("  ChatGPT's cookie names, so it would need a Google name list.")
    } else if (landedGroups.length === 0) {
      log('a Gemini page loaded, but no guess landed — write the descriptor from the STRUCTURE:')
      log('  · custom elements  -> the Angular component tags are the stable hooks')
      log('  · data-test-id VALUES -> role markers and their counts')
      log('  · composer toolbar -> sendButtonSelectors (last control) / stopButtonSelectors')
      log('  · turn ancestors   -> assistantSelectors / messageSelectors')
      log('  · path= + NAVIGATE -> conversationIdFromPath / conversationUrl')
      log('  NOTE: check the id SHAPE. isConversationId() in src/shared/platforms.ts requires a')
      log('  UUID, and a site using some other shape needs that check widened — not assumed.')
    } else {
      log('guesses that LANDED:', landedGroups.join(', '))
      log('→ still write the descriptor from the STRUCTURE, and check the id shape as above.')
    }
    log('=== window closed, log complete ===')
    app.quit()
  })
})
