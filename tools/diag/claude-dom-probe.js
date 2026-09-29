/**
 * Claude DOM probe — what does claude.ai actually look like, from scratch?
 *
 * WHY THIS ONE IS DIFFERENT FROM chatgpt-dom-probe.js
 * --------------------------------------------------
 * That probe tests a list of selectors the app ALREADY ships and says HIT or MISS. This one
 * has no such list: Claude is a new platform, so its job is DISCOVERY. A handful of plausible
 * selectors are still tried, because a lucky hit short-circuits the whole exercise, but they
 * are labelled as hypotheses and the real deliverable is the STRUCTURE — the `data-testid`
 * value table, the composer chain, the toolbar, the ancestor chain above a turn, and one turn's
 * raw markup. From those, `CHATGPT_PAGE`-style descriptor entries can be written in one pass.
 *
 * WHAT IT IS FOR (the PageAdapter fields it has to fill in)
 * ---------------------------------------------------------
 *   composerKind / composerSelectors   which element, and is it contenteditable or a textarea
 *   sendButtonSelectors                the control that submits
 *   stopButtonSelectors                the control that stops generation, if there is one
 *   assistantSelectors                 one element per assistant turn
 *   assistantReplySelectors            the element holding ONLY the answer, if the turn carries
 *                                      reasoning or citations too
 *   messageSelectors                   one element per turn of either role
 *   messageIdAttr                      a per-message id — the idempotency key. May not exist,
 *                                      which is a real finding and not a failure.
 *   ChatPlatform.conversationIdFromPath  the URL shape ( /chat/<uuid>? something else? )
 *   sidebarScript                      how conversation links are marked up
 *
 * Run (from the repo root, PowerShell):
 *
 *   node_modules\electron\dist\electron.exe tools\diag\claude-dom-probe.js
 *
 * Log: %TEMP%\gpt-login-diag\claude-dom-<timestamp>.log
 * Markup: the matching .markup.html beside it
 *
 * OPTIONAL proxy, because claude.ai is not reachable from every network:
 *
 *   $env:PROBE_PROXY='http://127.0.0.1:7897'
 *
 * The probe never types, clicks or submits; the user drives. Same partition the app will use
 * (`persist:claude`), so a login done here is a login the app inherits.
 */
const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const PARTITION = process.env.PROBE_PARTITION || 'persist:claude'
const LOG_DIR = process.env.PROBE_LOG_DIR || path.join(app.getPath('temp'), 'gpt-login-diag')

app.setPath(
  'userData',
  process.env.PROBE_USER_DATA || path.join(app.getPath('appData'), 'GPT Web to Codex Terminal')
)

const START_URL = process.env.PROBE_START_URL || 'https://claude.ai/new'
const PROXY = process.env.PROBE_PROXY || ''

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
fs.mkdirSync(LOG_DIR, { recursive: true })
const LOG_FILE = path.join(LOG_DIR, `claude-dom-${stamp}.log`)

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

const shorten = (url, max = 160) => String(url).slice(0, max)

function safeHost(url) {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * Rewrite the identity headers on every request this partition makes.
 *
 * ONE handler, on purpose: Electron keeps a single `onBeforeSendHeaders` slot per session, so a
 * second registration replaces the first — the lesson `google-login-probe.js` already paid for.
 * A separate "recorder" would therefore either vanish or overwrite the patch, and the log would
 * then disagree with the wire.
 */
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
    /*
     * One line proving the patch reached the wire, with the BEFORE value. Without it a failed
     * run cannot be told apart from a patch that never applied.
     */
    if (!notedIdentity && touched && /(^|\.)(claude\.ai|anthropic\.com)$/.test(safeHost(details.url))) {
      notedIdentity = true
      const before = Object.keys(details.requestHeaders || {}).find(
        (k) => k.toLowerCase() === 'sec-ch-ua'
      )
      log(
        'identity patch on the wire for',
        safeHost(details.url),
        '| sec-ch-ua was',
        JSON.stringify(before ? details.requestHeaders[before] : '(absent)'),
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

/*
 * The client-hint brand list, and the reason the FIRST run of this probe never got past
 * Cloudflare's 正在验证您是否是真人 page.
 *
 * The probe set a Chrome User-Agent and nothing else. But Electron's `Sec-CH-UA` advertises
 * `["Not?A_Brand","Chromium"]` with no `"Google Chrome"` in it — recorded in this repo's README
 * from the Google login work — so every request said "same UA as Chrome, different browser",
 * which is exactly what a browser pretending to be Chrome looks like. A User-Agent cannot fix
 * it: the brand list is browser metadata, not a header the page chooses, and Electron 44 has no
 * `setUserAgentMetadata` to change it (also recorded there).
 *
 * `google-login-probe.js` already rewrites these headers, but scopes the rewrite to
 * google.com. This applies it to the WHOLE partition, because claude.ai sits behind the same
 * Cloudflare — and the app will need the identical patch on every request it makes there.
 */
const chromeVersion = String(process.versions.chrome)
const majorVersion = chromeVersion.split('.')[0]
const CHROME_BRANDS = `"Google Chrome";v="${majorVersion}", "Chromium";v="${majorVersion}", "Not(A:Brand";v="24"`
const CHROME_FULL_VERSION_LIST = `"Google Chrome";v="${chromeVersion}", "Chromium";v="${chromeVersion}", "Not(A:Brand";v="24.0.0.0"`

/*
 * Chromium reports `navigator.webdriver = true` only under `--enable-automation`, which Electron
 * does not pass — but the blink feature is cheap to disable and is one of the things a challenge
 * script looks at. Must be set before `app.whenReady()`.
 */
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled')

/**
 * Runs in the page. Pure observation — no clicks, no typing.
 *
 * Structure over hypothesis: it reports what EXISTS before it reports whether a guess was
 * right, so a run is not wasted when every guess is wrong.
 */
const INSPECT = `(() => {
  /*
   * Guesses, NOT knowledge, and deliberately short.
   *
   * These exist only because a hit would save a whole round of descriptor-writing. A MISS
   * here means nothing at all — unlike the ChatGPT probe, there is no shipped selector to
   * regress, so nothing below should be read as "broken".
   */
  const HYPOTHESES = {
    composer: [
      'div[contenteditable="true"]',
      '[data-testid="chat-input"]',
      'div.ProseMirror',
      'textarea'
    ],
    sendButton: [
      'button[aria-label="Send message"]',
      'button[aria-label="发送消息"]',
      '[data-testid="send-button"]',
      'button[type="submit"]'
    ],
    stopButton: [
      'button[aria-label="Stop response"]',
      'button[aria-label="Stop generating"]',
      'button[aria-label="停止响应"]',
      '[data-testid="stop-button"]'
    ],
    assistant: ['[data-testid="assistant-message"]', 'div.font-claude-message', '[data-is-streaming]'],
    message: ['[data-testid="user-message"]', '[data-testid="assistant-message"]']
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
    return {
      tag: el.tagName.toLowerCase(),
      attrs,
      text: clip(el.innerText || el.value || '', 70)
    }
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
   * THE TABLE THAT MATTERS MOST ON THIS SITE.
   *
   * Claude marks up its chat with data-testid, so counting VALUES (not just attribute names)
   * is what exposes the role markers: a row reading "assistant-message 12 / user-message 12"
   * names both turn selectors outright. The generic data-* histogram below cannot do that,
   * because it only counts attribute NAMES.
   */
  const testIdHistogram = {}
  for (const el of document.querySelectorAll('[data-testid]')) {
    const value = el.getAttribute('data-testid') || ''
    testIdHistogram[value] = (testIdHistogram[value] || 0) + 1
  }

  /* Every data-* attribute on the page, counted — how a RENAMED attribute is found. */
  const dataAttrHistogram = {}
  for (const el of document.querySelectorAll('*')) {
    for (const a of el.attributes || []) {
      if (!a.name.startsWith('data-')) continue
      dataAttrHistogram[a.name] = (dataAttrHistogram[a.name] || 0) + 1
    }
  }

  /*
   * The same histogram, narrowed to names that smell like IDENTITY.
   *
   * messageIdAttr is the one field that cannot be inferred from shape — it has to be an
   * attribute whose VALUE is unique per turn. Names are the only cheap way to find it, and
   * the id-ish subset is short enough to read at a glance.
   */
  const idishAttrs = {}
  for (const name of Object.keys(dataAttrHistogram)) {
    if (/(^|-)id$|key|turn|message|uuid|index|seq/i.test(name)) {
      idishAttrs[name] = dataAttrHistogram[name]
    }
  }

  /*
   * The composer. Read text from the ELEMENT rather than document.activeElement: the user may
   * not have the caret in the box when a tick lands, and whether the box holds text is what
   * decides if a missing send button is evidence or nothing.
   */
  const composerEl = document.querySelector(
    'div[contenteditable="true"], textarea, [role="textbox"]'
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
      buttons: chainNode.querySelectorAll('button, [role="button"]').length,
      dataAttrs: [...(chainNode.attributes || [])]
        .filter((a) => a.name.startsWith('data-'))
        .map((a) => a.name + '=' + clip(a.value, 30))
    })
    chainNode = chainNode.parentElement
    chainGuard += 1
  }

  /*
   * The composer's toolbar, BOTH ENDS.
   *
   * The control that matters is the primary action — send, or stop while streaming — and it
   * sits at the END of the row. Taking only the first N is how the ChatGPT probe came back
   * with twelve unrelated chips and no primary action at all. The field toolbarCount says
   * when the two windows left a gap.
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
      testid: el.getAttribute('data-testid') || el.getAttribute('data-test-id') || '',
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

  /*
   * The newest turn, found WITHOUT a known selector.
   *
   * Tried in order of how likely each is to mean "one message": a testid containing the word,
   * then a class containing it, then anything that looks like rendered prose. The ancestor
   * chain above whatever wins is what names the per-turn wrapper.
   */
  const turnAnchor =
    [...document.querySelectorAll('[data-testid*="message" i]')].pop() ||
    [...document.querySelectorAll('[class*="message" i]')].pop() ||
    [...document.querySelectorAll('[class*="markdown"], [class*="prose"]')]
      .filter((el) => (el.innerText || '').length > 20)
      .pop() ||
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
        prose: node.querySelectorAll('[class*="markdown"], [class*="prose"]').length,
        dataAttrs: [...(node.attributes || [])]
          .filter((a) => a.name.startsWith('data-'))
          .map((a) => a.name + '=' + clip(a.value, 36))
      })
      node = node.parentElement
      guard += 1
    }
    return chain
  }

  const proseBlocks = [
    ...document.querySelectorAll('[class*="markdown"], [class*="prose"], [class*="response"]')
  ].filter((el) => (el.innerText || '').length > 20)

  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,

    /*
     * What the JS side of the page believes about itself — which the header patch CANNOT change.
     *
     * Sec-CH-UA is a request header, but navigator.userAgentData is generated inside the
     * renderer, so rewriting headers leaves this one still advertising Electron's brands. If the
     * challenge passes, this is academic. If it does not, this line is the difference between
     * "the patch did not apply" and "the patch applied and the JS-visible identity is the
     * remaining tell" — and those need different fixes.
     */
    identity: {
      webdriver: navigator.webdriver === true,
      brands:
        navigator.userAgentData && navigator.userAgentData.brands
          ? navigator.userAgentData.brands.map((b) => b.brand + '/' + b.version)
          : null,
      ua: clip(navigator.userAgent, 130),
      looksLikeChallenge:
        /cdn-cgi\\/challenge|__cf_chl/i.test(location.href) ||
        /just a moment|验证|verify you are human/i.test(document.title)
    },

    /*
     * The URL shape, which decides conversationIdFromPath / conversationUrl. Read from the
     * PATH, because that is all the adapter is given, and reported raw so the pattern can be
     * written from the log instead of assumed.
     */
    pathname: location.pathname,
    pathSegments: location.pathname.split('/').filter((part) => part !== ''),
    pathLooksLikeConversation: /\\/chat\\/[0-9a-z-]{8,}/i.test(location.pathname),

    hypothesisReport,
    dataAttrHistogram,
    idishAttrs,
    testIdHistogram,

    composerText,
    composerCandidateCount: composerCandidates.length,
    composerCandidates,
    composerChain,
    toolbarCount: toolbarControls.length,
    toolbar: pickedControls.map(describeControl),
    toolbarFound: toolbar !== null && toolbar !== undefined && toolbar !== document.body,

    buttons,
    buttonCount: document.querySelectorAll('button, [role="button"]').length,

    turnAnchor: describe(turnAnchor, 110),
    turnAncestors: turnAnchor ? ancestorChain(turnAnchor) : [],
    proseCount: proseBlocks.length,
    proseFirst: describe(proseBlocks[0], 90),

    /* Conversation links, for the sidebar sync feature. Path shape unknown — filter loosely. */
    sidebarLinks: [...document.querySelectorAll('a[href]')]
      .map((a) => ({ href: clip(a.getAttribute('href'), 70), text: clip(a.innerText, 40) }))
      .filter((entry) => /^\\/(chat|recents?|chats)\\//.test(entry.href))
      .slice(0, 8),

    /*
     * Raw markup of one turn, so the descriptor can be written without another run.
     *
     * Text is replaced with a marker and long attribute values are truncated: the goal is the
     * SHAPE — tag names, which element holds one turn — and shipping the user's actual
     * conversation out of the page is not part of that.
     */
    turnHtml: (() => {
      for (const target of [turnAnchor, proseBlocks[0]].filter(Boolean)) {
        const html = target.outerHTML
        if (html.length < 400) continue
        return html
          .replace(/>[^<]{40,}</g, '>«text»<')
          .replace(/="[^"]{80,}"/g, '="«long»"')
          .slice(0, 70000)
      }
      return ''
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
 * HIT/MISS summary for one group of HYPOTHESES.
 *
 * `qualifier` is here for the same reason it is in the ChatGPT probe, and the reason is worth
 * repeating: a MISS is only evidence when the element could have been on screen at all. Claude
 * renders no send button while the composer is empty and no stop button while nothing is
 * generating, so on those two groups a MISS is the expected result of a page STATE. Two runs
 * of the ChatGPT probe were wasted treating exactly that as a broken selector.
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
      'conversationLike=',
      String(info.pathLooksLikeConversation)
    )
    /*
     * Printed FIRST, because a run that stalls on Cloudflare produces nothing else worth
     * reading — and this says whether the identity patch held on the JS side or not.
     */
    log(
      `${label} identity:`,
      'webdriver=' + String(info.identity.webdriver),
      'brands=' + JSON.stringify(info.identity.brands),
      'challenge=' + String(info.identity.looksLikeChallenge)
    )
    if (info.identity.looksLikeChallenge) {
      log(
        `    ^ STILL ON THE CHALLENGE PAGE. If this repeats on every tick, the identity patch ` +
          `did not satisfy it — compare brands= above with a real Chrome, which reports ` +
          `["Google Chrome", "Chromium", "Not(A:Brand"].`
      )
    }

    log(`${label} hypothesis selectors (guesses — a MISS means nothing):`)
    const composerEmpty = String(info.composerText || '').trim() === ''
    const qualifiers = {
      composer: null,
      sendButton: {
        text: composerEmpty
          ? 'A MISS HERE PROVES NOTHING — the composer is EMPTY, and claude.ai may not render a send button until it holds text. Type a few characters, do NOT send, and let a tick land.'
          : 'The composer HELD TEXT at this tick, so a send control should have been on screen.'
      },
      stopButton: {
        text: 'A MISS HERE PROVES NOTHING unless a reply was streaming at this tick — a stop control only exists while generating.'
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

    /*
     * The table that names the role markers on this site. Printed before the raw histograms
     * because it is short, it is sorted by count, and it usually contains the answer.
     */
    log(`${label} data-testid VALUES (highest count first) — this is where role markers live:`)
    const testIds = Object.entries(info.testIdHistogram || {}).sort((a, b) => b[1] - a[1])
    for (const [value, count] of testIds.slice(0, 40)) {
      log(`    ${String(count).padStart(4)}x ${JSON.stringify(value)}`)
    }
    log(`    (${testIds.length} distinct data-testid values in total)`)

    log(`${label} id-ish data-* attributes (candidates for messageIdAttr):`)
    const idish = Object.entries(info.idishAttrs || {}).sort((a, b) => b[1] - a[1])
    if (idish.length === 0) log('    (none — this site may have no per-message id at all)')
    for (const [name, count] of idish) log(`    ${String(count).padStart(4)}x ${name}`)

    log(`${label} full data-* histogram=`, JSON.stringify(info.dataAttrHistogram))

    log(`${label} composer chain (innermost -> out):`)
    for (const [i, step] of (info.composerChain || []).entries()) {
      log(
        `    ${String(i).padStart(2)} <${step.tag} class="${step.cls}"> controls=${step.buttons} ${step.dataAttrs.join(' ')}`
      )
    }
    log(
      `${label} composer toolbar (${info.toolbarCount}) — the primary action is at the END:`
    )
    for (const [i, b] of (info.toolbar || []).entries()) {
      log(
        `    ${String(i).padStart(2)} <${b.tag}> role="${b.role}" testid="${b.testid}" aria="${b.aria}" title="${b.title}" disabled=${b.disabled} text=${JSON.stringify(b.text)} class="${b.cls}"`
      )
    }
    log(
      `${label} composerText=`,
      JSON.stringify(info.composerText),
      'candidates=',
      String(info.composerCandidateCount)
    )
    for (const [i, c] of (info.composerCandidates || []).entries()) {
      log(`    ${String(i).padStart(2)} ${JSON.stringify(c)}`)
    }

    log(`${label} turnAnchor=`, JSON.stringify(info.turnAnchor))
    log(`${label} turn ancestors (innermost -> body):`)
    for (const [i, s] of (info.turnAncestors || []).entries()) {
      log(
        `    ${String(i).padStart(2)} <${s.tag} class="${s.cls}"> children=${s.children} proseInside=${s.prose} ${s.dataAttrs.join(' ')}`
      )
    }
    log(`${label} prose count=`, String(info.proseCount), JSON.stringify(info.proseFirst))

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
  log('=== claude DOM probe ===')
  log('electron', process.versions.electron, 'chrome', process.versions.chrome)
  log('partition', PARTITION)
  log('startUrl', START_URL)
  log('proxy', PROXY === '' ? '(none — set PROBE_PROXY if claude.ai is unreachable)' : PROXY)
  log('sec-ch-ua brands ->', CHROME_BRANDS)
  log('logFile', LOG_FILE)
  log('')
  log('WHAT THIS RUN ANSWERS: what are claude.ai\'s composer, send/stop controls, turn')
  log('markers and URL shape — so a platform descriptor can be written in one pass?')
  log('')
  log('DO THIS, IN ORDER:')
  log('  1. Log in if the window shows a sign-in page. The partition is persist:claude, so')
  log('     the login is kept and the app will inherit it.')
  log('  2. Open a conversation that already has a few turns.')
  log('  3. Type a few characters into the composer and STOP — do not send. Wait ~15s so a')
  log('     tick lands with the text still in the box. Without this the send control is not')
  log('     on screen and its row below means nothing.')
  log('  4. Send it, and leave the reply STREAMING ~15s so a tick catches the stop control.')
  log('  5. Let it finish, wait ~15s more, then close the window.')

  const ses = session.fromPartition(PARTITION)
  installChromeIdentity(ses)

  if (PROXY !== '') {
    // Same knob the app's per-platform proxy setting uses. Applied to this partition only,
    // and only for the life of the probe.
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
    title: 'Claude DOM 探针 — 登录 → 打开有内容的对话 → 打字但别发 → 停 15 秒 → 发送并保持流式 → 关窗',
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
   * Every navigation is logged with its PATH, because the conversation-id pattern is one of
   * the things this run has to produce and the transition into a real conversation is the only
   * place it is visible.
   */
  wc.on('did-navigate', (_e, url) => log('NAVIGATE', shorten(url, 200)))
  wc.on('did-navigate-in-page', (_e, url, isMain) => {
    if (!isMain) return
    log('IN-PAGE', shorten(url, 200))
  })
  wc.on('did-finish-load', () => log('FINISHED LOAD:', shorten(wc.getURL(), 160), '|', wc.getTitle()))

  log('loading', START_URL, '— the user drives; this probe only reads the DOM')
  await wc.loadURL(START_URL).catch((e) => log('loadURL rejected:', e.message))
  await new Promise((r) => setTimeout(r, 7000))
  await inspect(wc, 'INITIAL')

  const timer = setInterval(() => {
    if (!win.isDestroyed()) void inspect(wc, 'TICK')
  }, 15000)

  win.on('closed', async () => {
    clearInterval(timer)
    await inspect(wc, 'FINAL')
    log('')
    log('=== VERDICT ===')
    if (landedGroups.length > 0) {
      log('hypotheses that LANDED:', landedGroups.join(', '))
    } else {
      log('no hypothesis landed — expected on a first run for a new site.')
    }
    log('→ write the descriptor from the STRUCTURE, not from the guesses:')
    log('  · data-testid VALUES  -> the role markers (assistant/user) and their counts')
    log('  · id-ish data-*       -> messageIdAttr, or proof that there is none')
    log('  · composer chain      -> composerSelectors, and contenteditable vs textarea')
    log('  · composer toolbar    -> sendButtonSelectors (last control) and stopButtonSelectors')
    log('  · turn ancestors      -> assistantSelectors / messageSelectors')
    log('  · path= + NAVIGATE    -> conversationIdFromPath / conversationUrl')
    log('=== window closed, log complete ===')
    app.quit()
  })
})
