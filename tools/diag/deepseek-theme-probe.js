/**
 * DeepSeek theme probe — what actually controls the page's light/dark appearance.
 *
 * WHY THIS RUNS BEFORE ANY CODE IS WRITTEN
 * ----------------------------------------
 * The app has one theme setting and the embedded page is a third-party site with a theme of
 * its own. Two things could carry the setting across, and they are not interchangeable:
 *
 *   1. `nativeTheme.themeSource` in the main process, which changes what
 *      `prefers-color-scheme` answers inside the page. Free, global, and enough IF the site
 *      follows the system preference.
 *   2. A hook in the page's own DOM (`html.dark`, `body[theme-mode=dark]`, …). Needed only
 *      if the site PINNED its appearance to an explicit value in its own settings.
 *
 * Which of the two is required for chat.deepseek.com is a fact about that site, and a hook
 * that matches nothing changes nothing SILENTLY — the page just stays as it was, which is
 * indistinguishable from the feature not existing. So it is measured, not guessed.
 *
 * ONE RUN ANSWERS ALL OF IT
 * -------------------------
 *   Question 1 — does the page react to the media query at all, LIVE? The probe drives
 *   `nativeTheme.themeSource` itself, dark then light, and measures the page after each.
 *   Nothing else in the app can test this without changing the user's setting.
 *
 *   Question 1b — and does it react when it BOOTS? The same pair again, but with a reload in
 *   between, because a site that resolves "system" once at startup cannot react to a flip on
 *   an already-open page. That is the difference between "the app needs nothing here" and
 *   "the app needs the DOM replay", and the first run of this probe could not tell them apart.
 *
 *   Question 2 — what does the site actually key its theme off? The probe snapshots the
 *   document every two seconds and prints a DIFF whenever anything changes. The user switches
 *   DeepSeek's own theme once, and the diff names exactly which attribute, class or storage
 *   entry moved together with the colours.
 *
 *   Question 3 — do the rules the app SHIPS work? The measured mutation set is replayed
 *   against the live page, both directions. A descriptor that reads correctly in a diff and
 *   does nothing on the real page is the exact failure this probe exists to catch.
 *
 * It also reads DeepSeek's own stylesheets and reports which selectors in them mention
 * dark/light/theme — for a same-origin sheet that is the site's own contract, read directly
 * instead of inferred.
 *
 * Run (from the repo root, PowerShell):
 *
 *   node_modules\electron\dist\electron.exe tools\diag\deepseek-theme-probe.js
 *
 * WHAT THE USER DOES
 *   1. Wait for the first ~45 seconds and touch nothing. The window changes theme, reloads,
 *      changes theme again, then has its DOM replayed — all automatic, and interrupting it
 *      wastes the run.
 *   2. Then open DeepSeek's own settings and SWITCH ITS THEME once (dark -> light, or the
 *      other way). The probe prints what changed.
 *   3. Leave it ~10 seconds, then close the window. The verdict is written at that moment.
 *
 * WHAT IT WRITES, AND WHAT IT DOES NOT
 *   - It NEVER clicks and NEVER types in the page, and it NEVER writes storage: the site's own
 *     theme preference is recorded in the log and left alone.
 *   - It DOES write the DOM during the replay phase — the three `<body>` changes below, dark
 *     then light, ending where the page already was. That is the point of the phase: the
 *     shipped rules get tested against the live page instead of being trusted.
 *   - It changes its own process's theme preference, on a timer, on purpose.
 *
 * It uses the app's real `persist:deepseek` partition, so it opens whatever session the app
 * already has.
 *
 * Log: %TEMP%\gpt-login-diag\deepseek-theme-<timestamp>.log
 */
const { app, BrowserWindow, nativeTheme, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const PARTITION = process.env.PROBE_PARTITION || 'persist:deepseek'
const LOG_DIR = process.env.PROBE_LOG_DIR || path.join(app.getPath('temp'), 'gpt-login-diag')

app.setPath(
  'userData',
  process.env.PROBE_USER_DATA || path.join(app.getPath('appData'), 'GPT Web to Codex Terminal')
)

const START_URL = process.env.PROBE_START_URL || 'https://chat.deepseek.com/'
const PROXY = process.env.PROBE_PROXY || ''

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
fs.mkdirSync(LOG_DIR, { recursive: true })
const LOG_FILE = path.join(LOG_DIR, `deepseek-theme-${stamp}.log`)

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

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  `Chrome/${process.versions.chrome} Safari/537.36`

/**
 * Runs in the page. Pure observation: no clicks, no typing, no writes.
 *
 * Everything it returns is compared against the previous snapshot on the Node side, so the
 * interesting output is a DIFF — "which of these changed when the theme changed" — rather
 * than a wall of state that has to be read twice.
 *
 * NOTE FOR EDITORS: this is one big template literal. A backtick inside it ends the string
 * and breaks the file, and a backslash escape is consumed by the literal before the page
 * ever sees it (so `\s` would arrive as `s`). Both are avoided below: string concatenation
 * instead of interpolation, `[ ]` instead of `\s`. Verified by line range, not by eye — see
 * the README section for this probe.
 */
const SNAPSHOT = `(() => {
  const cut = (value, max) => String(value === undefined || value === null ? '' : value).slice(0, max || 60)

  const attrsOf = (el) => {
    if (!el) return []
    const out = []
    for (const a of el.attributes || []) out.push(a.name + '=' + cut(a.value, 60))
    return out.sort()
  }

  const classesOf = (el) => {
    if (!el) return []
    return [...el.classList].sort()
  }

  const TRANSPARENT = ['', 'transparent', 'rgba(0, 0, 0, 0)']
  const toRgb = (value) => {
    const text = String(value || '').trim().toLowerCase()
    if (TRANSPARENT.indexOf(text) !== -1) return null
    const m = /^rgba?[(]([^)]+)[)]$/.exec(text)
    if (!m) return null
    const parts = m[1].split(/[,/ ]+/).filter((p) => p !== '').map(Number)
    if (parts.length < 3) return null
    if (parts.slice(0, 3).some((n) => isNaN(n))) return null
    if (parts.length > 3 && parts[3] === 0) return null
    return parts.slice(0, 3)
  }
  const lum = (rgb) => (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255

  /*
   * The raw colours of every layer that could carry the page background, plus the decided
   * scheme. Both are reported: the raw values are the evidence, the decision is a
   * convenience, and a reader who disagrees with the decision can see why.
   */
  const layers = {}
  for (const selector of ['html', 'body', '#root', '#app', 'main', '[role="main"]']) {
    const el = document.querySelector(selector)
    if (!el) continue
    const style = getComputedStyle(el)
    layers[selector] = {
      bg: String(style.backgroundColor),
      fg: String(style.color),
      colorScheme: String(style.colorScheme)
    }
  }

  let scheme = 'unknown'
  let evidence = 'no opaque background or text colour found'
  for (const selector of ['body', 'html', '#root', '#app', 'main', '[role="main"]']) {
    const layer = layers[selector]
    if (!layer) continue
    const rgb = toRgb(layer.bg)
    if (!rgb) continue
    scheme = lum(rgb) < 0.45 ? 'dark' : 'light'
    evidence = selector + ' background-color ' + layer.bg
    break
  }
  if (scheme === 'unknown') {
    for (const selector of ['body', 'html']) {
      const layer = layers[selector]
      if (!layer) continue
      const rgb = toRgb(layer.fg)
      if (!rgb) continue
      scheme = lum(rgb) > 0.55 ? 'dark' : 'light'
      evidence = selector + ' color ' + layer.fg
      break
    }
  }

  /*
   * Theme-shaped storage entries. REPORTED, never written — a key this probe has not been
   * seen to control must not be touched, or the site's real setting is what gets broken.
   */
  const themeish = (storeName) => {
    const out = []
    try {
      const area = window[storeName]
      if (!area) return out
      const limit = Math.min(area.length, 200)
      for (let i = 0; i < limit; i += 1) {
        const key = area.key(i) || ''
        const value = String(area.getItem(key) === null ? '' : area.getItem(key))
        if (!/theme|appearance|scheme|dark|light|color/i.test(key) && !/^(dark|light|system|auto|night|day|true|false|0|1)$/i.test(value.trim())) continue
        out.push(key + '=' + cut(value, 40))
      }
    } catch (e) {
      out.push('UNAVAILABLE: ' + cut(e && e.message, 40))
    }
    return out.sort()
  }

  return {
    url: location.href,
    readyState: document.readyState,
    schemeQuery: window.matchMedia ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : 'unknown',
    scheme,
    evidence,
    layers,
    htmlClasses: classesOf(document.documentElement),
    htmlAttrs: attrsOf(document.documentElement),
    bodyClasses: classesOf(document.body),
    bodyAttrs: attrsOf(document.body),
    localStorage: themeish('localStorage'),
    sessionStorage: themeish('sessionStorage'),
    /* How many elements anywhere carry a dark/light-ish class or attribute. */
    themeishElements: document.querySelectorAll('[class*=dark], [class*=light], [class*=theme], [data-theme], [theme-mode]').length,
    stylesheetCount: document.styleSheets.length
  }
})()`

/**
 * Runs in the page, ONCE. Reads the site's own CSS and reports the selector PREFIXES that
 * mention dark/light/theme, with a count each.
 *
 * This is the site's theme contract read directly rather than inferred from behaviour: a
 * bucket of `html.dark: 412` or `body[theme-mode=dark]: 88` names the hook outright. Sheets
 * from another origin throw on `.cssRules` and are skipped — reported, not silently dropped.
 */
const CSSMAP = `(() => {
  const buckets = {}
  const blocked = []
  let scanned = 0
  for (const sheet of [...document.styleSheets]) {
    let rules = null
    try {
      rules = sheet.cssRules
    } catch (e) {
      blocked.push(String(sheet.href || '(inline)').slice(0, 80))
      continue
    }
    if (!rules) continue
    for (const rule of [...rules]) {
      scanned += 1
      if (scanned > 60000) break
      const selector = rule.selectorText
      if (!selector) continue
      if (!/dark|light|theme|appearance/i.test(selector)) continue
      for (const part of selector.split(',')) {
        const first = part.trim().split(/[ >+~]/)[0]
        if (!/dark|light|theme|appearance/i.test(first)) continue
        buckets[first] = (buckets[first] || 0) + 1
      }
    }
  }
  const sorted = Object.keys(buckets).map((key) => [key, buckets[key]]).sort((a, b) => b[1] - a[1])
  return { scanned, blocked, buckets: sorted.slice(0, 25), bucketCount: sorted.length }
})()`

/*
 * THE SHIPPED DESCRIPTOR, duplicated here ON PURPOSE.
 *
 * These are the values that went into `DEEPSEEK_THEME` in `src/shared/platforms.ts`, copied
 * from the first run of this probe. The probe replays them against the live page so the
 * answer to "do these rules actually work" comes from a measurement rather than from the
 * fact that they look right in a diff.
 *
 * Duplicated rather than imported for the same reason the ChatGPT probe duplicates its
 * selector list: a probe that read the descriptor would pass whatever the descriptor says,
 * including a value that was mistyped into it. KEEP THIS IN SYNC when the descriptor changes.
 *
 * Measured 2026-09-29: one theme switch moved exactly these three things on `<body>`, and
 * `<html>` carried nothing theme-related at all (`class=notranslate lang=zh-CN translate=no`).
 */
const DESCRIPTOR = {
  dark: [
    { target: 'body', kind: 'class', name: 'light', present: false },
    { target: 'body', kind: 'class', name: 'dark', present: true },
    { target: 'body', kind: 'attr', name: 'data-ds-dark-theme', value: 'dark' }
  ],
  light: [
    { target: 'body', kind: 'class', name: 'light', present: true },
    { target: 'body', kind: 'class', name: 'dark', present: false },
    { target: 'body', kind: 'attr', name: 'data-ds-dark-theme', value: '' }
  ]
}

/**
 * Build the page script that replays one mutation set.
 *
 * This is the ONLY place the probe writes to the page: no clicks, no typing, no storage. The
 * set is restored to `light` at the end of the replay, which is where the page already was.
 */
function applyScript(mutations) {
  return (
    '(() => {\n' +
    '  const list = ' + JSON.stringify(mutations) + '\n' +
    '  for (const m of list) {\n' +
    '    const el = m.target === "body" ? document.body : document.documentElement\n' +
    '    if (!el) continue\n' +
    '    if (m.kind === "class") { el.classList.toggle(m.name, m.present === true); continue }\n' +
    '    const value = String(m.value || "")\n' +
    '    if (value === "") el.removeAttribute(m.name)\n' +
    '    else el.setAttribute(m.name, value)\n' +
    '  }\n' +
    '  return true\n' +
    '})()'
  )
}

/** Reload and resolve when the new document is up, or after a timeout. */
function reloadAndWait(wc, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      wc.removeListener('did-finish-load', finish)
      resolve()
    }
    const timer = setTimeout(finish, timeoutMs || 20000)
    wc.once('did-finish-load', finish)
    wc.reload()
  })
}

/**
 * Compare two snapshots and return the human-readable differences.
 *
 * This is the whole point of the probe: the user flips one switch, and this says which
 * attribute, class or storage entry moved — instead of a state dump that has to be diffed by
 * eye across twenty ticks.
 */
function diff(previous, next) {
  if (!previous) return ['(baseline)']

  const changes = []
  const scalar = ['scheme', 'schemeQuery', 'evidence', 'themeishElements', 'stylesheetCount', 'readyState']
  for (const key of scalar) {
    if (previous[key] === next[key]) continue
    changes.push(key + ': ' + JSON.stringify(previous[key]) + ' -> ' + JSON.stringify(next[key]))
  }

  const lists = ['htmlClasses', 'htmlAttrs', 'bodyClasses', 'bodyAttrs', 'localStorage', 'sessionStorage']
  for (const key of lists) {
    const before = (previous[key] || []).join(' | ')
    const after = (next[key] || []).join(' | ')
    if (before === after) continue
    changes.push(key + ':\n      before: ' + (before || '(empty)') + '\n      after:  ' + (after || '(empty)'))
  }

  for (const selector of Object.keys(next.layers || {})) {
    const before = (previous.layers || {})[selector]
    if (!before) {
      changes.push('layers[' + selector + ']: (new) ' + JSON.stringify(next.layers[selector]))
      continue
    }
    const after = next.layers[selector]
    for (const prop of ['bg', 'fg', 'colorScheme']) {
      if (before[prop] === after[prop]) continue
      changes.push('layers[' + selector + '].' + prop + ': ' + before[prop] + ' -> ' + after[prop])
    }
  }

  return changes
}

const snapshots = {}
let snapshotIndex = 0

async function inspect(wc, label, force) {
  try {
    const info = await wc.executeJavaScript(SNAPSHOT)
    const previous = snapshots.last
    const changes = diff(previous, info)
    snapshots.last = info
    snapshotIndex += 1
    snapshots[label] = info

    if (!force && changes.length === 0) return info

    log('--- ' + label + ' #' + snapshotIndex + ' ---')
    log(label + ' url=' + String(info.url).slice(0, 120))
    log(label + ' scheme=' + info.scheme + '  prefers-color-scheme=' + info.schemeQuery + '  (' + info.evidence + ')')
    for (const line of changes) log('  CHANGE ' + line)
    log(label + ' html classes=' + JSON.stringify(info.htmlClasses))
    log(label + ' html attrs=' + JSON.stringify(info.htmlAttrs))
    log(label + ' body classes=' + JSON.stringify(info.bodyClasses))
    log(label + ' body attrs=' + JSON.stringify(info.bodyAttrs))
    log(label + ' localStorage=' + JSON.stringify(info.localStorage))
    log(label + ' sessionStorage=' + JSON.stringify(info.sessionStorage))
    log(label + ' layers=' + JSON.stringify(info.layers))
    log(label + ' themeishElements=' + info.themeishElements + ' stylesheets=' + info.stylesheetCount)
    return info
  } catch (error) {
    log(label + ' inspect failed:', error.message)
    return null
  }
}

async function dumpCss(wc, label) {
  try {
    const map = await wc.executeJavaScript(CSSMAP)
    log('--- CSS MAP (' + label + ') ---')
    log('rules scanned=' + map.scanned + ' buckets=' + map.bucketCount)
    for (const [selector, count] of map.buckets) log('    ' + String(count).padStart(6) + '  ' + selector)
    if (map.blocked.length > 0) log('    cross-origin sheets skipped: ' + JSON.stringify(map.blocked))
    return map
  } catch (error) {
    log('CSS MAP failed:', error.message)
    return null
  }
}

function setSource(source, label) {
  nativeTheme.themeSource = source
  log('')
  log('=== PHASE ' + label + ': nativeTheme.themeSource=' + source + ' ===')
  log('(this is exactly what the app does when 应用主题 is set to ' + source + ';')
  log(' the page should follow it if DeepSeek uses the system preference)')
}

app.whenReady().then(async () => {
  log('=== deepseek THEME probe ===')
  log('electron', process.versions.electron, 'chrome', process.versions.chrome)
  log('partition', PARTITION)
  log('startUrl', START_URL)
  log('logFile', LOG_FILE)
  log('')
  log('This probe reads the page only. It never clicks and never types.')
  log('It DOES change its own process theme preference twice, on a timer, on purpose.')

  const ses = session.fromPartition(PARTITION)
  if (PROXY !== '') {
    await ses.setProxy({ proxyRules: PROXY })
    log('proxy', PROXY)
  }
  ses.webRequest.onCompleted({ urls: ['*://*/*'] }, (details) => {
    if (details.statusCode < 400) return
    log('NET ' + details.statusCode + ' ' + details.method + ' ' + String(details.url).slice(0, 160))
  })

  const win = new BrowserWindow({
    width: 1180,
    height: 900,
    title: 'DeepSeek 主题探针 — 先等 30 秒，再切换 DeepSeek 自己的主题',
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
  wc.on('did-finish-load', () => log('LOADED:', String(wc.getURL()).slice(0, 140), '|', wc.getTitle()))

  log('loading', START_URL)
  await wc.loadURL(START_URL).catch((e) => log('loadURL rejected:', e.message))
  await new Promise((r) => setTimeout(r, 7000))

  await inspect(wc, 'BASELINE', true)
  await dumpCss(wc, 'initial')

  // Question 1, driven by the probe: does the page follow the media query AT ALL, live?
  setSource('dark', '1-dark (live)')
  await new Promise((r) => setTimeout(r, 3500))
  const afterDark = await inspect(wc, 'AFTER-PHASE-1', true)

  setSource('light', '2-light (live)')
  await new Promise((r) => setTimeout(r, 3500))
  const afterLight = await inspect(wc, 'AFTER-PHASE-2', true)

  /*
   * Question 1b, and the reason the first run was incomplete: the live flip above changes
   * `prefers-color-scheme` on a page that has ALREADY booted. A site that resolves "system"
   * once at startup cannot possibly react to that, so the two phases above answer a narrower
   * question than they appear to. This pair sets the preference and then RELOADS, which is
   * what the app actually does: it sets `themeSource` before any page loads.
   */
  log('')
  log('=== PHASE 3: boot test — set the preference, then RELOAD (what the app does) ===')
  setSource('dark', '3-dark (boot)')
  await reloadAndWait(wc)
  await new Promise((r) => setTimeout(r, 4000))
  const bootDark = await inspect(wc, 'AFTER-BOOT-DARK', true)

  setSource('light', '4-light (boot)')
  await reloadAndWait(wc)
  await new Promise((r) => setTimeout(r, 4000))
  const bootLight = await inspect(wc, 'AFTER-BOOT-LIGHT', true)

  /*
   * Question 3: do the rules we are about to SHIP actually work?
   *
   * Replayed against the live page, in both directions, ending on `light` — which is where
   * the page already was. A descriptor that reads correctly in a diff and does nothing on
   * the real page is exactly the failure this whole probe exists to catch, and reading the
   * page back is the only way to catch it before the app ships it.
   */
  log('')
  log('=== PHASE 5: replay the shipped descriptor (dark, then back to light) ===')
  const replayResults = {}
  for (const step of ['dark', 'light']) {
    await wc.executeJavaScript(applyScript(DESCRIPTOR[step])).catch((e) => log('replay failed:', e.message))
    await new Promise((r) => setTimeout(r, 1500))
    const info = await inspect(wc, 'REPLAY-' + step, true)
    replayResults[step] = info ? info.scheme : '?'
    log('REPLAY ' + step + ' set -> scheme=' + (info ? info.scheme : '?') + ' body=' + JSON.stringify(info ? info.bodyAttrs : null))
  }
  const darkWorks = replayResults.dark === 'dark'
  const lightWorks = replayResults.light === 'light'
  log('REPLAY dark set works:  ' + darkWorks)
  log('REPLAY light set works: ' + lightWorks)

  log('')
  log('*** NOW: open DeepSeek settings and SWITCH ITS OWN THEME once. ***')
  log('*** The probe prints a CHANGE block for whatever moves. Leave it 10s. ***')
  log('')

  const timer = setInterval(() => {
    if (!win.isDestroyed()) void inspect(wc, 'TICK', false)
  }, 2000)

  // A heartbeat every 30s, so a run with no changes is still visibly alive.
  const beat = setInterval(() => {
    if (win.isDestroyed()) return
    const last = snapshots.last || {}
    log('HEARTBEAT scheme=' + last.scheme + ' query=' + last.schemeQuery + ' html=' + JSON.stringify(last.htmlClasses) + ' body=' + JSON.stringify(last.bodyClasses))
  }, 30000)

  /*
   * Capture on `close`, NOT on `closed`.
   *
   * `closed` fires after the window and its webContents are already gone, so every capture
   * inside it fails with "Object has been destroyed" — which is exactly what the first run of
   * this probe did, and why its FINAL snapshot and final CSS map are both missing from that
   * log. `close` can be deferred, so the window is held open until the capture finishes and
   * then destroyed. The verdict below never depended on that capture — every value in it was
   * kept on the Node side when it was measured — but the last state of the page did, and that
   * is where the user's own theme switch shows up.
   */
  let closing = false
  win.on('close', async (event) => {
    if (closing) return
    event.preventDefault()
    closing = true
    clearInterval(timer)
    clearInterval(beat)
    log('')
    log('=== window closing — capturing FINAL before the document goes away ===')
    const finalInfo = await inspect(wc, 'FINAL', true)
    const cssMap = await dumpCss(wc, 'final')

    const followsLive = Boolean(afterDark && afterLight && afterDark.scheme === 'dark' && afterLight.scheme === 'light')
    const followsBoot = Boolean(bootDark && bootLight && bootDark.scheme === 'dark' && bootLight.scheme === 'light')
    log('')
    log('=== VERDICT ===')
    log('LIVE  (preference flipped on a page that is already open)')
    log('  themeSource=dark  -> page=' + (afterDark ? afterDark.scheme : '?') + ' (query=' + (afterDark ? afterDark.schemeQuery : '?') + ')')
    log('  themeSource=light -> page=' + (afterLight ? afterLight.scheme : '?') + ' (query=' + (afterLight ? afterLight.schemeQuery : '?') + ')')
    log('  FOLLOWS LIVE: ' + followsLive + '   <- false is EXPECTED on DeepSeek: the query arrives, the page does not act on it')
    log('BOOT  (preference set, then the page reloaded — what the app does)')
    log('  themeSource=dark  -> page=' + (bootDark ? bootDark.scheme : '?') + ' (query=' + (bootDark ? bootDark.schemeQuery : '?') + ')')
    log('  themeSource=light -> page=' + (bootLight ? bootLight.scheme : '?') + ' (query=' + (bootLight ? bootLight.schemeQuery : '?') + ')')
    log('  FOLLOWS AT BOOT: ' + followsBoot)
    log('  ^ READ THE SITE PREFERENCE FIRST. This only says what the media query does while the')
    log('    site\'s own setting is PINNED to light/dark; with it set to 跟随系统 the answer can')
    log('    differ, and the local storage line says which case this run was.')
    log('DESCRIPTOR REPLAY (src/shared/platforms.ts DEEPSEEK_THEME)')
    log('  dark set  -> ' + replayResults.dark + '  (' + (darkWorks ? 'WORKS' : 'FAILED — the shipped rules do not move the page') + ')')
    log('  light set -> ' + replayResults.light + '  (' + (lightWorks ? 'WORKS' : 'FAILED') + ')')

    if (!darkWorks || !lightWorks) {
      log('=> THE SHIPPED DESCRIPTOR DOES NOT MATCH THE PAGE. Re-measure before trusting it:')
      log('   read the CHANGE blocks from the user-driven switch below and rewrite DEEPSEEK_THEME.')
    } else {
      log('=> The shipped descriptor moves the live page in both directions, so the app can')
      log('   carry its theme onto a page that is open AND onto one that is pinned.')
    }
    if (followsBoot) {
      log('   A fresh load also follows the app theme, so it needs no DOM work of its own.')
    } else {
      log('   A fresh load did NOT follow the app theme in this run — see the note above about')
      log('   the site preference. Either way the replay is what carries an open page, and the')
      log('   site storage key (hints= below) is the durable alternative — NOT written, because')
      log('   it is the site\'s own preference and would follow the user into a real browser.')
    }

    if (cssMap && cssMap.buckets.length > 0) {
      log('   The site stylesheet names these theme selectors outright:')
      for (const [selector, count] of cssMap.buckets.slice(0, 8)) log('     ' + count + '  ' + selector)
    } else {
      log('   No same-origin stylesheet rules mentioned dark/light/theme'
        + (cssMap && cssMap.blocked.length > 0 ? ' (sheets were cross-origin: ' + cssMap.blocked.length + ')' : ''))
    }

    const finalStorage = (finalInfo && finalInfo.localStorage) || []
    log('   Theme-shaped storage at exit: ' + JSON.stringify(finalStorage))
    log('   Theme-shaped sessionStorage at exit: ' + JSON.stringify((finalInfo && finalInfo.sessionStorage) || []))
    win.destroy()
  })

  win.on('closed', () => {
    log('=== log complete: ' + LOG_FILE + ' ===')
    app.quit()
  })
})
