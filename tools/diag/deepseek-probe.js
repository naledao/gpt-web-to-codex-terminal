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
    // Sidebar conversation links, for the "sync conversations" feature.
    sidebarLinks: [...document.querySelectorAll('a[href^="/a/chat/s/"]')]
      .slice(0, 5)
      .map((a) => ({ href: a.getAttribute('href'), text: (a.innerText || '').trim().slice(0, 40) })),
    sidebarLinkCount: document.querySelectorAll('a[href^="/a/chat/s/"]').length
  }
})()`

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
    log(`${label} message containers:`)
    for (const row of info.messageish) log(`    ${JSON.stringify(row)}`)
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
