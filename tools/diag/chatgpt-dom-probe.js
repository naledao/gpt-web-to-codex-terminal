/**
 * ChatGPT DOM probe — did the page change out from under the interceptor?
 *
 * The interceptor is built on facts read off the live page: the composer is a
 * contenteditable div, an assistant turn is found through its message wrapper, and the
 * composer clearing is the only trustworthy "the send really happened" signal. The FIRST
 * generation of that list — `#prompt-textarea`, `data-testid="send-button"`,
 * `data-message-author-role`, `data-message-id` — stopped matching in the 2026-09 markup
 * change and took the automation down silently; what replaced it is recorded in
 * `src/shared/platforms.ts`.
 *
 * A selector that stops matching fails SILENTLY — no error, no log, the automation
 * just never fires again — so "the page changed" has to be measured, not guessed.
 *
 * This probe opens chatgpt.com in the app's own partition and READS the DOM. It never
 * types, never clicks, never submits; the user drives. Two jobs:
 *
 *   1. Test every selector the app currently ships, and say HIT or MISS for each.
 *   2. If something missed, dump enough structure to write the replacement from ONE
 *      run: a data-* histogram, a full button inventory, the ancestor chain above a
 *      reply, and the raw markup of one turn.
 *
 * Run (from the repo root, PowerShell):
 *
 *   node_modules\electron\dist\electron.exe tools\diag\chatgpt-dom-probe.js
 *
 * Log: %TEMP%\gpt-login-diag\chatgpt-dom-<timestamp>.log
 * Markup: the matching .markup.html beside it
 */
const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const PARTITION = process.env.PROBE_PARTITION || 'persist:chatgpt'
const LOG_DIR = process.env.PROBE_LOG_DIR || path.join(app.getPath('temp'), 'gpt-login-diag')

app.setPath(
  'userData',
  process.env.PROBE_USER_DATA || path.join(app.getPath('appData'), 'GPT Web to Codex Terminal')
)

const START_URL = process.env.PROBE_START_URL || 'https://chatgpt.com/'

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
fs.mkdirSync(LOG_DIR, { recursive: true })
const LOG_FILE = path.join(LOG_DIR, `chatgpt-dom-${stamp}.log`)

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

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  `Chrome/${process.versions.chrome} Safari/537.36`

/**
 * Runs in the page. Pure observation — no clicks, no typing.
 *
 * Structure over hypothesis: it reports what EXISTS before it reports whether a
 * guess was right, so a run is not wasted when the guess is wrong.
 */
const INSPECT = `(() => {
  /*
   * The selectors the app SHIPS, copied verbatim.
   *
   * Duplicated on purpose so the probe can say which one broke, and it has to be kept
   * in sync by hand — CHANGE THIS LIST WHENEVER src/shared/platforms.ts CHANGES, or the
   * probe starts reporting on selectors nobody uses any more.
   */
  const APP_SELECTORS = {
    composer: [
      'div[contenteditable="true"][data-composer-markdown]',
      'div[contenteditable="true"][role="textbox"]',
      '#prompt-textarea',
      'div[contenteditable="true"]'
    ],
    sendButton: [
      '[data-testid="send-button"]',
      'button[aria-label="Send message"]',
      'button[aria-label="发送消息"]'
    ],
    stopButton: [
      '[data-testid="stop-button"]',
      'button[aria-label="Stop generating"]',
      'button[aria-label="Stop streaming"]',
      'button[aria-label="停止生成"]'
    ],
    assistant: ['[data-chatgpt-selection-message-id]'],
    message: ['[data-content-search-unit-key]', '[data-chatgpt-selection-message-id]']
  }

  const clip = (value, max) => String(value == null ? '' : value).slice(0, max)

  const describe = (el, max) => {
    if (!el) return null
    const attrs = {}
    for (const a of el.attributes || []) {
      if (/^(data-|aria-|role$|type$|placeholder$|contenteditable$|id$|class$|href$)/.test(a.name)) {
        attrs[a.name] = clip(a.value, 110)
      }
    }
    return {
      tag: el.tagName.toLowerCase(),
      attrs,
      text: clip(el.innerText || el.value || '', 70)
    }
  }

  /** HIT/MISS for one shipped selector: the headline this run exists to produce. */
  const testSelector = (selector) => {
    let nodes = []
    try {
      nodes = [...document.querySelectorAll(selector)]
    } catch (error) {
      return { selector, error: String(error && error.message) }
    }
    return {
      selector,
      count: nodes.length,
      first: describe(nodes[0], 90)
    }
  }

  const selectorReport = {}
  for (const group of Object.keys(APP_SELECTORS)) {
    selectorReport[group] = APP_SELECTORS[group].map(testSelector)
  }

  /* The id attribute the app dedupes executions by. Presence is a boolean fact. */
  const messageIdAttr = {
    'data-message-id': document.querySelectorAll('[data-message-id]').length,
    'data-testid': document.querySelectorAll('[data-testid]').length,
    'data-turn-id': document.querySelectorAll('[data-turn-id]').length,
    'data-message-author-role': document.querySelectorAll('[data-message-author-role]').length,
    // The generation that replaced the four above. The messageIdAttr the app now ships is
    // the second entry here, so its count going to zero is the same class of silent break.
    'data-chatgpt-selection-message-id': document.querySelectorAll(
      '[data-chatgpt-selection-message-id]'
    ).length,
    'data-content-search-unit-key': document.querySelectorAll('[data-content-search-unit-key]')
      .length,
    'data-content-search-unit-key$=":assistant"': document.querySelectorAll(
      '[data-content-search-unit-key$=":assistant"]'
    ).length,
    'data-content-search-unit-key$=":user"': document.querySelectorAll(
      '[data-content-search-unit-key$=":user"]'
    ).length,
    'data-markdown-text-style="assistant-message"': document.querySelectorAll(
      '[data-markdown-text-style="assistant-message"]'
    ).length
  }

  /* Every element the framework tagged with data-*, grouped by name. This is how a
     RENAMED attribute is found without guessing. */
  const dataAttrHistogram = {}
  for (const el of document.querySelectorAll('*')) {
    for (const a of el.attributes || []) {
      if (!a.name.startsWith('data-')) continue
      dataAttrHistogram[a.name] = (dataAttrHistogram[a.name] || 0) + 1
    }
  }

  /* Composer candidates, all of them: a TEXTAREA would mean the write path has to
     change from execCommand to a native setter. The word is spelled without quotes on
     purpose — this block is a template literal, and one backtick inside it ends the
     string and breaks the whole file. */
  const composerCandidates = [
    ...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')
  ]
    .slice(0, 8)
    .map((el) => describe(el, 120))

  /* Full button inventory — "the button whose label says send" has already produced a
     null once on the other site, so listing them all beats guessing a second filter. */
  const describeButton = (el) => {
    const cls = typeof el.className === 'string' ? el.className : ''
    return {
      tag: el.tagName.toLowerCase(),
      testid: el.getAttribute('data-testid') || el.getAttribute('data-test-id') || '',
      ariaLabel: clip(el.getAttribute('aria-label'), 60),
      title: clip(el.getAttribute('title'), 40),
      // The app sends by clicking; a disabled button is ignored while a reply streams,
      // which is why this flag matters more than the label does.
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
      text: clip(el.innerText, 20),
      // Long enough to hold a full utility-class list: the send button is likely to be
      // identified by shape — size-token-button-composer and friends — rather than by a
      // test id, and 80 chars cut that off mid-class in the earlier runs. No backticks in
      // this comment: this block is a template literal and one would end the whole file.
      cls: clip(cls, 200)
    }
  }

  const buttons = [...document.querySelectorAll('button, [role="button"]')]
    .slice(0, 45)
    .map(describeButton)

  /*
   * The composer's OWN subtree, which is where the send button lives.
   *
   * A flat inventory is not enough: this page has 129 buttons and the sidebar fills the
   * first 45, so the one button that matters was outside the window and the first run
   * came back without it. Walking UP from the composer and listing only what is inside
   * that container is small, precise, and immune to how many sidebar rows exist.
   */
  const composerEl = document.querySelector('div[contenteditable="true"], textarea, [role="textbox"]')

  const composerChain = []
  let chainNode = composerEl
  let chainGuard = 0
  while (chainNode && chainNode !== document.body && chainGuard < 10) {
    composerChain.push({
      tag: chainNode.tagName.toLowerCase(),
      cls: clip(typeof chainNode.className === 'string' ? chainNode.className : '', 70),
      buttons: chainNode.querySelectorAll('button').length,
      dataAttrs: [...(chainNode.attributes || [])]
        .filter((a) => a.name.startsWith('data-'))
        .map((a) => a.name + '=' + clip(a.value, 30))
    })
    chainNode = chainNode.parentElement
    chainGuard += 1
  }

  /* The toolbar is the first ancestor holding more than one button. */
  let toolbar = composerEl
  let hops = 0
  while (toolbar && toolbar !== document.body && hops < 10) {
    if (toolbar.querySelectorAll('button').length >= 2) break
    toolbar = toolbar.parentElement
    hops += 1
  }
  const composerButtons =
    toolbar && toolbar !== document.body
      ? [...toolbar.querySelectorAll('button, [role="button"]')].slice(0, 25).map(describeButton)
      : []

  /*
   * Every attribute the NEW markup is built on, with sample values.
   *
   * This is the section that answers "what replaced data-message-author-role": the role
   * discriminator is the SUFFIX of one of these values, and the message id is another one
   * of them. Reporting plain counts and raw values keeps the answer readable without
   * having to re-run.
   */
  const CANDIDATE_ATTRS = [
    'data-markdown-text-style',
    'data-chatgpt-selection-message-id',
    'data-chatgpt-selection-conversation-id',
    'data-content-search-unit-key',
    'data-chatgpt-search-unit-key',
    'data-chatgpt-search-message-ids',
    'data-content-search-turn-key',
    'data-turn-key',
    'data-composer-markdown',
    'data-testid',
    'data-test-id'
  ]
  const attrCarriers = {}
  for (const name of CANDIDATE_ATTRS) {
    const found = [...document.querySelectorAll('[' + name + ']')]
    attrCarriers[name] = {
      count: found.length,
      sample: found.slice(0, 5).map((el) => clip(el.getAttribute(name), 70))
    }
  }

  /* The ancestor chain above one marker. Walking UP is the only way to name the turn
     wrapper and the thread list: their own attributes say nothing, and the class names
     are hashed. */
  const ancestorChain = (element, markerSelector, limit) => {
    const chain = []
    let node = element
    let guard = 0
    while (node && node !== document.body && guard < (limit || 18)) {
      const cls = typeof node.className === 'string' ? node.className : ''
      chain.push({
        tag: node.tagName.toLowerCase(),
        cls: clip(cls, 80),
        children: node.children.length,
        markers: node.querySelectorAll(markerSelector).length,
        dataAttrs: [...(node.attributes || [])]
          .filter((a) => a.name.startsWith('data-'))
          // String concatenation, NOT a template literal: this code lives inside one,
          // and an inner backtick would terminate it or interpolate the wrong thing.
          .map((a) => a.name + '=' + clip(a.value, 36))
      })
      node = node.parentElement
      guard += 1
    }
    return chain
  }

  /* Reply bodies by observation, not by selector guess. */
  const markdownBlocks = [
    ...document.querySelectorAll('[class*="markdown"], [class*="prose"]')
  ].filter((el) => (el.innerText || '').length > 20)

  const turns = [...document.querySelectorAll('[data-message-author-role]')]
  const lastTurn = turns.length > 0 ? turns[turns.length - 1] : null

  /*
   * Ancestor chain of the LAST turn, which is what the interceptor actually reads. The
   * first turn would under-report: ChatGPT renders a placeholder turn before its text
   * arrives, so the newest one is the interesting shape.
   */
  const turnAnchor = lastTurn || markdownBlocks[0] || null

  const activeElement = document.activeElement

  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,

    selectorReport,
    messageIdAttr,
    dataAttrHistogram,
    attrCarriers,

    composerCandidates,
    composerCandidateCount: composerCandidates.length,
    /*
     * Whether the composer is focused and whether it holds text. Both are read-only
     * observations that tell us if the user had started typing when this tick landed —
     * the app's send-confirmation depends on the box clearing, so a filled box is
     * evidence about the disabled state of the send button.
     */
    activeIsComposer: activeElement
      ? /^(div|textarea)$/i.test(activeElement.tagName) &&
        (activeElement.getAttribute('contenteditable') === 'true' ||
          activeElement.tagName === 'TEXTAREA')
      : false,
    composerText: activeElement
      ? clip(activeElement.value != null ? activeElement.value : activeElement.innerText, 60)
      : '',

    buttons,
    buttonCount: document.querySelectorAll('button, [role="button"]').length,
    composerChain,
    composerButtons,

    turnCount: turns.length,
    turnIds: turns.slice(-6).map((el) => el.getAttribute('data-message-id') || '(none)'),
    lastTurn: describe(lastTurn, 90),
    assistantCount: document.querySelectorAll('[data-message-author-role="assistant"]').length,

    markdownCount: markdownBlocks.length,
    markdownFirst: describe(markdownBlocks[0], 90),

    turnAncestors: turnAnchor
      ? ancestorChain(turnAnchor, '[data-message-author-role]')
      : [],
    replyAncestors:
      markdownBlocks[0] && markdownBlocks[0] !== turnAnchor
        ? ancestorChain(markdownBlocks[0], '[class*="markdown"]')
        : [],

    /* Conversation links, for the sidebar sync feature. ChatGPT uses /c/<uuid>. */
    sidebarLinks: [...document.querySelectorAll('a[href^="/c/"]')]
      .slice(0, 6)
      .map((a) => ({ href: clip(a.getAttribute('href'), 60), text: clip(a.innerText, 40) })),
    sidebarLinkCount: document.querySelectorAll('a[href^="/c/"]').length,
    urlLooksLikeConversation: /\\/c\\/[0-9a-f-]{20,}/i.test(location.pathname),

    /*
     * Raw markup of one turn, so the adapter can be written without another run.
     *
     * Text is replaced with a marker and long attribute values are truncated: the goal
     * is the SHAPE — tag names, which element holds one turn — and shipping the user's
     * actual conversation out of the page is not part of that.
     */
    messageHtml: (() => {
      for (const target of [turnAnchor, markdownBlocks[0]].filter(Boolean)) {
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
 * HIT/MISS summary for a group of shipped selectors.
 *
 * `qualifier` exists because a MISS is only evidence when the element could have been on
 * screen at all. ChatGPT renders no send button while the composer is empty, and no stop
 * button while nothing is generating — so on those two groups a MISS is the EXPECTED result
 * of a page state, not a broken selector. Two runs of this probe printed
 * "*** BROKEN — every selector missed ***" for exactly that reason and sent a whole
 * debugging round after selectors that had never been given a chance to match.
 */
function summariseSelectors(group, report, qualifier) {
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
  log(
    `  ${group}: ${
      anyHit ? 'OK (at least one selector still matches)' : '*** BROKEN — every selector missed ***'
    }`
  )
  if (!anyHit && qualifier) log(`      ^ ${qualifier.text}`)
  return anyHit
}

let brokenGroups = []
/** Groups whose absence is explained by the page state, i.e. never actually tested. */
let unmeasuredGroups = []

async function inspect(wc, label) {
  try {
    const info = await wc.executeJavaScript(INSPECT)
    log(`--- ${label} ---`)
    log(`${label} url=`, shorten(info.url))
    log(`${label} title=`, JSON.stringify(info.title), 'readyState=', info.readyState)
    log(`${label} urlLooksLikeConversation=`, String(info.urlLooksLikeConversation))

    log(`${label} shipped selectors:`)
    /*
     * Whether a MISS on a button group means anything depends on the page state, which is
     * only known here — `info.composerText` is read in the page, the verdict is printed in
     * the main process.
     */
    const composerEmpty = String(info.composerText || '').trim() === ''
    const qualifiers = {
      sendButton: {
        text: composerEmpty
          ? 'A MISS HERE PROVES NOTHING — the composer is EMPTY, and ChatGPT renders no send button until it holds text (the last toolbar slot held 开始语音 instead). Type a few characters, do NOT send, and let a tick land. These selectors are in fact still WORKING — clicking send injects the system prompt — so an all-MISS here is purely a page-state artefact.'
          : 'The composer HELD TEXT at this tick, so a send button should have been on screen. This MISS is real.',
        conclusive: !composerEmpty
      },
      stopButton: {
        text: 'A MISS HERE PROVES NOTHING unless a reply was streaming at this tick — the stop button exists only while generating. Send something and let a tick land mid-reply.',
        conclusive: false
      }
    }

    brokenGroups = []
    unmeasuredGroups = []
    for (const group of Object.keys(info.selectorReport)) {
      if (summariseSelectors(group, info.selectorReport[group], qualifiers[group])) continue
      // A button group that the page never had a reason to render was not tested, and
      // reporting it as broken is what made the first two runs unreadable.
      const qualifier = qualifiers[group]
      if (qualifier && !qualifier.conclusive) unmeasuredGroups.push(group)
      else brokenGroups.push(group)
    }

    log(`${label} id-ish attribute counts=`, JSON.stringify(info.messageIdAttr))
    log(`${label} data-* histogram=`, JSON.stringify(info.dataAttrHistogram))

    /*
     * The replacement attributes, printed BEFORE the ancestor chains: this is the section
     * that says what took over from data-message-author-role / data-message-id, and it is
     * readable even when everything below it is noise.
     */
    log(`${label} candidate attributes (what the new markup is built on):`)
    for (const [name, entry] of Object.entries(info.attrCarriers || {})) {
      log(`    ${String(entry.count).padStart(4)}x ${name}  ${JSON.stringify(entry.sample)}`)
    }

    log(`${label} composer chain (innermost -> out):`)
    for (const [i, step] of (info.composerChain || []).entries()) {
      log(`    ${String(i).padStart(2)} <${step.tag} class="${step.cls}"> buttons=${step.buttons} ${step.dataAttrs.join(' ')}`)
    }
    log(`${label} composer toolbar buttons (${(info.composerButtons || []).length}) — the send/stop button is here:`)
    for (const [i, b] of (info.composerButtons || []).entries()) {
      log(
        `    ${String(i).padStart(2)} <${b.tag}> testid="${b.testid}" aria="${b.ariaLabel}" title="${b.title}" disabled=${b.disabled} text=${JSON.stringify(b.text)} class="${b.cls}"`
      )
    }
    log(`${label} turns=`, String(info.turnCount), 'assistant=', String(info.assistantCount))
    log(`${label} last turn ids=`, JSON.stringify(info.turnIds))
    log(`${label} lastTurn=`, JSON.stringify(info.lastTurn))
    log(`${label} markdown=`, String(info.markdownCount), JSON.stringify(info.markdownFirst))
    log(`${label} sidebar links=`, String(info.sidebarLinkCount), JSON.stringify(info.sidebarLinks))
    log(`${label} activeIsComposer=`, String(info.activeIsComposer), 'composerText=', JSON.stringify(info.composerText))

    log(`${label} composer candidates (${info.composerCandidateCount}):`)
    for (const [i, c] of (info.composerCandidates || []).entries()) log(`    ${String(i).padStart(2)} ${JSON.stringify(c)}`)

    log(`${label} buttons (${info.buttonCount}):`)
    for (const [i, b] of (info.buttons || []).entries()) {
      log(
        `    ${String(i).padStart(2)} <${b.tag}> testid="${b.testid}" aria="${b.ariaLabel}" title="${b.title}" disabled=${b.disabled} text=${JSON.stringify(b.text)} class="${b.cls}"`
      )
    }

    log(`${label} turn ancestors (innermost -> body):`)
    for (const [i, s] of (info.turnAncestors || []).entries()) {
      log(`    ${String(i).padStart(2)} <${s.tag} class="${s.cls}"> children=${s.children} turnsInside=${s.markers} ${s.dataAttrs.join(' ')}`)
    }
    log(`${label} reply ancestors:`)
    for (const [i, s] of (info.replyAncestors || []).entries()) {
      log(`    ${String(i).padStart(2)} <${s.tag} class="${s.cls}"> children=${s.children} markers=${s.markers} ${s.dataAttrs.join(' ')}`)
    }

    dumpMarkup(label, info.messageHtml)
    return info
  } catch (error) {
    log(`${label} inspect failed:`, error.message)
    return null
  }
}

app.whenReady().then(async () => {
  log('=== chatgpt DOM probe ===')
  log('electron', process.versions.electron, 'chrome', process.versions.chrome)
  log('partition', PARTITION)
  log('startUrl', START_URL)
  log('logFile', LOG_FILE)
  log('')
  log('WHAT THIS RUN ANSWERS: does every selector the app ships still match?')
  log('')
  log('DO THIS, IN ORDER. The two button groups are only testable while the page is in the')
  log('right state, and a run that skips this reports MISSes that mean nothing:')
  log('  1. Open a conversation that already has a few turns.')
  log('  2. Type a few characters into the composer, then STOP — do not send.')
  log('  3. Wait ~15s so a tick lands with the text still sitting in the box.')
  log('  4. Press Enter to send it, and leave the reply STREAMING ~15s so a tick catches')
  log('     the stop button.')
  log('  5. Let the reply finish, wait ~15s more, then close the window.')

  const ses = session.fromPartition(PARTITION)
  ses.webRequest.onCompleted({ urls: ['*://*/*'] }, (details) => {
    if (details.statusCode < 400) return
    log(`NET ${details.statusCode} ${details.method} ${details.resourceType} ${shorten(details.url, 200)}`)
  })

  const win = new BrowserWindow({
    width: 1280,
    height: 940,
    title: 'ChatGPT DOM 探针 — 先打字但别发送 → 停 15 秒 → 再发送并让它流式输出 → 关窗',
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

  let sawConversationUrl = false
  // `includes`, not a regex: this literal sits inside a nested-escape minefield and an
  // escaped regex here has already terminated early once on the other probe.
  const isConversationUrl = (url) => String(url).includes('/c/')

  wc.on('did-navigate', (_e, url) => {
    log('NAVIGATE', shorten(url, 200))
    if (isConversationUrl(url)) sawConversationUrl = true
  })
  wc.on('did-navigate-in-page', (_e, url, isMain) => {
    if (!isMain) return
    log('IN-PAGE', shorten(url, 200))
    if (isConversationUrl(url)) sawConversationUrl = true
  })
  wc.on('did-finish-load', () => log('FINISHED LOAD:', shorten(wc.getURL(), 160), '|', wc.getTitle()))

  log('loading', START_URL, '— the user drives; this probe only reads the DOM')
  await wc.loadURL(START_URL).catch((e) => log('loadURL rejected:', e.message))
  await new Promise((r) => setTimeout(r, 7000))
  await inspect(wc, 'INITIAL')

  // Periodic re-inspection: the interesting structure only exists AFTER a message has
  // been sent, and the user is the one who sends it.
  const timer = setInterval(() => {
    if (!win.isDestroyed()) void inspect(wc, sawConversationUrl ? 'TICK(in-conversation)' : 'TICK')
  }, 15000)

  win.on('closed', async () => {
    clearInterval(timer)
    await inspect(wc, 'FINAL')
    log('')
    log('=== VERDICT ===')
    if (brokenGroups.length === 0 && unmeasuredGroups.length === 0) {
      log('every shipped selector still matched on the last tick')
    } else {
      if (unmeasuredGroups.length > 0) {
        log('NEVER TESTED (the page had no reason to render these, so a MISS is not')
        log('evidence — re-run and follow the steps at the top of this log):')
        log('  ' + unmeasuredGroups.join(', '))
      }
      if (brokenGroups.length > 0) {
        log('BROKEN selector groups:', brokenGroups.join(', '))
        log('→ read the data-* histogram, the button inventory and the ancestor chains above;')
        log('  the replacement is in there. Do NOT guess a new selector.')
      } else if (unmeasuredGroups.length > 0) {
        log('nothing was PROVEN broken — every group that missed was one the page never had')
        log('a reason to render.')
      }
    }
    log('=== window closed, log complete ===')
    app.quit()
  })
})
