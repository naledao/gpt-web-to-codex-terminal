/**
 * DeepSeek adapter probe — what the embed needs to know about chat.deepseek.com.
 *
 * The ChatGPT interceptor is built on facts that were read off the live page (assistant
 * nodes carry `data-message-author-role` and `data-message-id`; the composer is a
 * contenteditable div; the send button clears the box when the send really happened).
 * None of that can be assumed for another site, and guessing selectors produces an
 * adapter that silently never fires.
 *
 * This probe does not drive anything. It opens the site, the user sends one message, and
 * it records the structure: composer, send button, reply elements, whether a stable id
 * exists on them, and the conversation URL shape.
 *
 * Run (from the repo root, PowerShell):
 *
 *   node_modules\electron\dist\electron.exe tools\diag\deepseek-probe.js
 *
 * Log: %TEMP%\gpt-login-diag\deepseek-<timestamp>.log
 *
 * It NEVER sends, clicks or types: every observation is a read of the DOM. The user
 * sends the message; the probe just looks.
 */
const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const PARTITION = process.env.PROBE_PARTITION || 'persist:deepseek'
const LOG_DIR = process.env.PROBE_LOG_DIR || path.join(app.getPath('temp'), 'gpt-login-diag')

app.setPath(
  'userData',
  process.env.PROBE_USER_DATA || path.join(app.getPath('appData'), 'GPT Web to Codex Terminal')
)

const START_URL = process.env.PROBE_START_URL || 'https://chat.deepseek.com/'

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
fs.mkdirSync(LOG_DIR, { recursive: true })
const LOG_FILE = path.join(LOG_DIR, `deepseek-${stamp}.log`)

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
 * Deliberately generic: it reports what EXISTS rather than testing one hypothesis, so a
 * wrong guess about the markup still yields usable data instead of an empty result.
 */
const INSPECT = `(() => {
  const describe = (el) => {
    if (!el) return null
    const attrs = {}
    for (const a of el.attributes || []) {
      if (/^data-|^aria-|^role$|^type$|^placeholder$|^contenteditable$|^id$|^class$/.test(a.name)) {
        attrs[a.name] = String(a.value).slice(0, 120)
      }
    }
    return {
      tag: el.tagName.toLowerCase(),
      attrs,
      text: (el.innerText || el.value || '').slice(0, 80)
    }
  }

  const composerCandidate = document.querySelector('textarea, [contenteditable="true"], div[role="textbox"]')
  const sendButton = [...document.querySelectorAll('button, [role="button"]')].find((b) => {
    const label = (b.getAttribute('aria-label') || '') + ' ' + (b.className || '')
    return /send|发送/i.test(label)
  })

  /*
   * Every element carrying a per-item key.
   *
   * This is the one signal that identifies the message list WITHOUT guessing at hashed
   * class names — and it is why the thread gets captured at all. The first version of this
   * probe picked "the smallest container with text", which selected the SIDEBAR (100 short
   * rows) and left the thread, smaller still, out of the dump entirely.
   */
  const keyedItems = [...document.querySelectorAll('[data-virtual-list-item-key]')]
  const messageList = keyedItems.length > 0 ? keyedItems[0].parentElement : null

  /** Rendered markdown blocks — one per reply body, by observation. */
  const markdownBlocks = [...document.querySelectorAll('[class*="markdown"]')]

  /**
   * The ancestor chain of a marker element, with how many markers each level contains.
   *
   * Walking UP is the only way to name the per-turn wrapper and the list: a container's own
   * attributes say nothing about what it holds, and the interesting elements have hashed
   * class names that cannot be guessed. The markersInside count is what identifies the list
   * — the level where the count stops growing is the one holding every turn.
   */
  const ancestorChain = (element, markerSelector) => {
    const chain = []
    let node = element
    let guard = 0
    while (node && node !== document.body && guard < 20) {
      const cls = typeof node.className === 'string' ? node.className : ''
      chain.push({
        tag: node.tagName.toLowerCase(),
        class: cls.slice(0, 90),
        childCount: node.children.length,
        markersInside: markerSelector ? node.querySelectorAll(markerSelector).length : 0,
        dataAttrs: [...(node.attributes || [])]
          .filter((a) => a.name.startsWith('data-'))
          // String concatenation, NOT a template literal: this code lives inside one, and
          // an inner backtick would either terminate it or interpolate against this file's
          // variables instead of the page's.
          .map((a) => a.name + '=' + String(a.value).slice(0, 40))
      })
      node = node.parentElement
      guard += 1
    }
    return chain
  }

  /**
   * Every button-like element, fully described.
   *
   * "The button whose label says send" produced null even with text sitting in the
   * composer, so that assumption is simply wrong on this site. Listing them all beats
   * guessing a second filter and burning another run.
   */
  const allButtons = [...document.querySelectorAll('button, [role="button"], [class*="ds-button"]')]
    .slice(0, 40)
    .map((el) => {
      const cls = typeof el.className === 'string' ? el.className : ''
      return {
        tag: el.tagName.toLowerCase(),
        class: cls.slice(0, 110),
        ariaLabel: el.getAttribute('aria-label') || '',
        title: el.getAttribute('title') || '',
        disabled: el.getAttribute('aria-disabled') === 'true' || /disabled/.test(cls),
        text: (el.innerText || '').trim().slice(0, 24),
        svgPaths: el.querySelectorAll('svg path').length
      }
    })

  // Every element that the framework tagged with a data-* attribute, grouped by name.
  // The message list is in here somewhere; this is how we find it without guessing.
  const dataAttrHistogram = {}
  for (const el of document.querySelectorAll('*')) {
    for (const a of el.attributes || []) {
      if (!a.name.startsWith('data-')) continue
      dataAttrHistogram[a.name] = (dataAttrHistogram[a.name] || 0) + 1
    }
  }

  // Structure of the message list: the deepest element that contains several siblings
  // of the same shape. Reported as a path + a sample of its children.
  const messageish = []
  for (const el of document.querySelectorAll('[class]')) {
    const kids = [...el.children]
    if (kids.length < 2) continue
    const tagCounts = {}
    for (const k of kids) tagCounts[k.tagName] = (tagCounts[k.tagName] || 0) + 1
    const dominant = Math.max(...Object.values(tagCounts))
    if (dominant / kids.length < 0.9) continue
    // Only report "conversation-like" containers: tall, multiple children, real text.
    if ((el.innerText || '').length < 200) continue
    messageish.push({
      selectorGuess: el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(/[ ]+/)[0] : ''),
      childTag: kids[0].tagName.toLowerCase(),
      childCount: kids.length,
      childClasses: [...new Set(kids.map((k) => String(k.className).split(/[ ]+/)[0]))].slice(0, 4),
      textLen: (el.innerText || '').length
    })
  }

  // Does any element carry an id-looking attribute we could dedupe messages by?
  const idLike = []
  for (const el of document.querySelectorAll('[data-message-id], [data-id], [id^="message"], [data-testid]')) {
    idLike.push(describe(el))
    if (idLike.length >= 5) break
  }

  return {
    url: location.href,
    title: document.title,
    composer: describe(composerCandidate),
    composerIsTextarea: composerCandidate ? composerCandidate.tagName === 'TEXTAREA' : null,
    sendButton: describe(sendButton),
    sendButtonCount: document.querySelectorAll('button, [role="button"]').length,
    stopButton: describe(
      [...document.querySelectorAll('button, [role="button"]')].find((b) =>
        /stop|停止/i.test((b.getAttribute('aria-label') || '') + ' ' + (b.className || ''))
      )
    ),
    dataAttrHistogram,
    messageish: messageish.slice(0, 8),
    idLike,
    /*
     * The message-list facts, reported as their own fields so they are readable even when
     * the outline below is noisy: how many keyed rows exist, what the list element looks
     * like, and the shape of one row.
     */
    keyedItemCount: keyedItems.length,
    keyedItemKeys: keyedItems.slice(0, 6).map((el) => el.getAttribute('data-virtual-list-item-key')),
    messageList: describe(messageList),
    firstItem: describe(keyedItems[0]),
    markdownCount: markdownBlocks.length,
    markdownFirst: describe(markdownBlocks[0]),
    /*
     * The structures that actually decide the adapter: the chain of ancestors above one
     * reply body, and the full button inventory.
     */
    replyAncestors: markdownBlocks[0] ? ancestorChain(markdownBlocks[0], '[class*="markdown"]') : [],
    itemAncestors: keyedItems[0] ? ancestorChain(keyedItems[0], '[data-virtual-list-item-key]') : [],
    allButtons,
    /* Composer text, so a snapshot proves whether the input was filled when it was taken. */
    composerText: composerCandidate
      ? String(composerCandidate.value ?? composerCandidate.innerText ?? '').slice(0, 60)
      : '',
    // Sidebar conversation links, for the "sync conversations" feature.
    sidebarLinks: [...document.querySelectorAll('a[href^="/a/chat/s/"]')]
      .slice(0, 5)
      .map((a) => ({ href: a.getAttribute('href'), text: (a.innerText || '').trim().slice(0, 40) })),
    sidebarLinkCount: document.querySelectorAll('a[href^="/a/chat/s/"]').length,
    /*
     * The raw markup of the reply container, so the adapter can be written even if the
     * generic scan above fails to name it.
     *
     * Text is replaced with a marker and attribute values are truncated: the goal is the
     * SHAPE (tag names, class names, which element holds one turn), and shipping the
     * user's actual conversation out of the page is not part of that. Dumped to its own
     * file rather than the log, because a single reply's markup is tens of kilobytes.
     */
    messageHtml: (() => {
      /*
       * Priority order, most specific first.
       *
       * The sidebar must never win: it is full of short rows and passes any "has text"
       * test, which is exactly how the first version of this probe captured the
       * conversation list instead of the conversation.
       */
      const targets = [messageList, markdownBlocks[0]?.parentElement, markdownBlocks[0]].filter(Boolean)
      for (const target of targets) {
        const html = target.outerHTML
        if (html.length < 500) continue
        return html
          .replace(/>[^<]{40,}</g, '>«text»<')
          .replace(/="[^"]{80,}"/g, '="«long»"')
          .slice(0, 60000)
      }
      return ''
    })()
  }
})()`

/**
 * Write the captured markup next to the log.
 *
 * Separate file on purpose: it is the one artefact that lets the adapter be written
 * without another run, and a reply's markup would bury the readable log lines.
 */
function dumpMarkup(label, html) {
  if (!html) {
    log(`${label} markup: (empty — no thread container found yet)`)
    return
  }
  const file = LOG_FILE.replace(/\.log$/, '.markup.html')
  try {
    fs.appendFileSync(
      file,
      `\n<!-- ===== ${label} @ ${new Date().toISOString()} ===== -->\n${html}\n`
    )
    log(`${label} markup appended to`, file, `(${html.length} chars)`)
  } catch (error) {
    log(`${label} markup write failed:`, error.message)
  }
}

async function inspect(wc, label) {
  try {
    const info = await wc.executeJavaScript(INSPECT)
    log(`--- ${label} ---`)
    log(`${label} url=`, shorten(info.url))
    log(`${label} title=`, JSON.stringify(info.title))
    log(`${label} composer=`, JSON.stringify(info.composer))
    log(`${label} composerIsTextarea=`, String(info.composerIsTextarea))
    log(`${label} sendButton=`, JSON.stringify(info.sendButton))
    log(`${label} stopButton=`, JSON.stringify(info.stopButton))
    log(`${label} sidebar links=`, String(info.sidebarLinkCount), JSON.stringify(info.sidebarLinks))
    log(`${label} data-* histogram=`, JSON.stringify(info.dataAttrHistogram))
    log(`${label} idLike=`, JSON.stringify(info.idLike))
    // The message list: the one thing the adapter cannot be written without.
    log(`${label} keyedItems=`, String(info.keyedItemCount), JSON.stringify(info.keyedItemKeys))
    log(`${label} messageList=`, JSON.stringify(info.messageList))
    log(`${label} firstItem=`, JSON.stringify(info.firstItem))
    log(`${label} markdown=`, String(info.markdownCount), JSON.stringify(info.markdownFirst))
    log(`${label} composerText=`, JSON.stringify(info.composerText))
    log(`${label} reply ancestors (innermost → body):`)
    for (const [i, step] of (info.replyAncestors || []).entries()) {
      log(`    ${String(i).padStart(2)} <${step.tag} class="${step.class}"> children=${step.childCount} markdownInside=${step.markersInside} ${step.dataAttrs.join(' ')}`)
    }
    log(`${label} item ancestors:`)
    for (const [i, step] of (info.itemAncestors || []).entries()) {
      log(`    ${String(i).padStart(2)} <${step.tag} class="${step.class}"> children=${step.childCount} keysInside=${step.markersInside} ${step.dataAttrs.join(' ')}`)
    }
    log(`${label} buttons (${(info.allButtons || []).length}):`)
    for (const [i, b] of (info.allButtons || []).entries()) {
      log(`    ${String(i).padStart(2)} <${b.tag}> class="${b.class}" aria="${b.ariaLabel}" title="${b.title}" disabled=${b.disabled} svgPaths=${b.svgPaths} text=${JSON.stringify(b.text)}`)
    }
    log(`${label} message containers:`)
    for (const row of info.messageish) log(`    ${JSON.stringify(row)}`)
    dumpMarkup(label, info.messageHtml)
    return info
  } catch (error) {
    log(`${label} inspect failed:`, error.message)
    return null
  }
}

app.whenReady().then(async () => {
  log('=== deepseek adapter probe ===')
  log('electron', process.versions.electron, 'chrome', process.versions.chrome)
  log('partition', PARTITION)
  log('startUrl', START_URL)
  log('logFile', LOG_FILE)

  const ses = session.fromPartition(PARTITION)
  ses.webRequest.onCompleted({ urls: ['*://*/*'] }, (details) => {
    if (details.statusCode < 400) return
    log(`NET ${details.statusCode} ${details.method} ${details.resourceType} ${shorten(details.url, 200)}`)
  })

  const win = new BrowserWindow({
    width: 1180,
    height: 900,
    title: 'DeepSeek 适配探针 — 请发一条消息，然后关掉窗口',
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
  // `includes`, not a regex: this literal sits inside a nested-escape minefield and the
  // escaped form `/^\\/a\\/chat/` terminates the regex early ("Invalid regular
  // expression flags"). Substring matching has nothing to escape.
  const isConversationUrl = (url) => String(url).includes('/a/chat/s/')

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
  await new Promise((r) => setTimeout(r, 6000))
  await inspect(wc, 'INITIAL')

  // Periodic re-inspection: the interesting structure only appears AFTER a message is
  // sent, and the user is the one who sends it.
  const timer = setInterval(() => {
    if (!win.isDestroyed()) void inspect(wc, sawConversationUrl ? 'TICK(in-conversation)' : 'TICK')
  }, 20000)

  win.on('closed', async () => {
    clearInterval(timer)
    await inspect(wc, 'FINAL')
    log(`sawConversationUrl=${sawConversationUrl}`)
    log('=== window closed, log complete ===')
    app.quit()
  })
})
