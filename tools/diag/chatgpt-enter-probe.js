/**
 * User-run, read-only capture of Enter and the current ChatGPT composer.
 * Run: node_modules\electron\dist\electron.exe tools\diag\chatgpt-enter-probe.js
 * Logs contain DOM metadata and text lengths, never drafts or cookie values.
 */
const { app, BrowserWindow, session } = require('electron')
const { appendFileSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')

app.setPath('userData', join(app.getPath('appData'), 'GPT Web to Codex Terminal'))
const directory = join(app.getPath('temp'), 'gpt-login-diag')
mkdirSync(directory, { recursive: true })
const logPath = join(directory, 'chatgpt-enter-' + new Date().toISOString().replace(/[:.]/g, '-') + '.log')
const tag = '[chatgpt-enter-probe] '
const log = (event, details = {}) => {
  const line = new Date().toISOString() + ' ' + JSON.stringify({ event, ...details })
  appendFileSync(logPath, line + '\n', 'utf8')
  console.log(line)
}

// Independent copies of the shipped selectors. Do not import application code.
const observerSource = `(() => {
  if (window.__chatgptEnterProbe) return;
  window.__chatgptEnterProbe = true;
  const composers = [
    'div[contenteditable="true"][data-composer-markdown]',
    'div[contenteditable="true"][role="textbox"]',
    'textarea#pending-home-input',
    '#prompt-textarea',
    'div[contenteditable="true"]'
  ];
  const sends = [
    '[data-composer-footer-responsive] button[aria-label="发送"]',
    'button[aria-label="发送"]',
    '[data-testid="send-button"]',
    'button[aria-label="Send message"]',
    'button[aria-label="发送消息"]'
  ];
  const visible = (node) => {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const describe = (node) => node instanceof Element ? {
    tag: node.tagName.toLowerCase(),
    id: node.id.slice(0, 100),
    role: node.getAttribute('role'),
    contenteditable: node.getAttribute('contenteditable'),
    className: String(node.getAttribute('class') || '').slice(0, 300),
    ariaLabel: String(node.getAttribute('aria-label') || '').slice(0, 100),
    dataAttributeNames: [...node.attributes].map((item) => item.name).filter((name) => name.startsWith('data-')).slice(0, 20),
    visible: visible(node),
    textLength: String(typeof node.value === 'string' ? node.value : node.innerText || '').length
  } : null;
  const report = (payload) => console.log('${tag}' + JSON.stringify(payload));
  const snapshot = (target) => {
    const selected = composers.map((selector) => document.querySelector(selector)).find(Boolean) || null;
    return {
      target: describe(target),
      activeElement: describe(document.activeElement),
      selectedComposer: describe(selected),
      selectedContainsTarget: !!selected && target instanceof Node && selected.contains(target),
      composerMatches: composers.map((selector) => ({ selector, count: document.querySelectorAll(selector).length })),
      candidates: [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')].slice(0, 12).map(describe),
      sendMatches: sends.map((selector) => ({ selector, count: document.querySelectorAll(selector).length }))
    };
  };
  const observeEnter = (phase, event) => {
    if (!event.isTrusted || event.key !== 'Enter' || event.repeat) return;
    report({ event: 'enter', phase, defaultPrevented: event.defaultPrevented,
      isComposing: event.isComposing, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey,
      altKey: event.altKey, metaKey: event.metaKey, ...snapshot(event.target) });
  };
  window.addEventListener('keydown', (event) => observeEnter('window-capture', event), true);
  document.addEventListener('keydown', (event) => observeEnter('document-capture', event), true);
  report({ event: 'observer-installed', ...snapshot(document.activeElement) });
  return true;
})()`

app.whenReady().then(async () => {
  log('start', { logPath, electron: process.versions.electron, purpose: 'read-only Enter and composer metadata; user sends once' })
  console.log('等待页面加载，输入“当前cpu状态”，停留 3 秒，再按 Enter；回复结束后关闭探针窗口。')
  const probeSession = session.fromPartition('persist:chatgpt')
  const proxy = process.env.PROBE_PROXY || 'http://127.0.0.1:7897'
  await probeSession.setProxy({ mode: 'fixed_servers', proxyRules: proxy })
  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + process.versions.chrome + ' Safari/537.36'
  const window = new BrowserWindow({
    width: 1280, height: 940,
    title: 'ChatGPT Enter 只读探针 — 输入文字 → 等 3 秒 → 回车 → 回复结束后关闭',
    webPreferences: { partition: 'persist:chatgpt', nodeIntegration: false, contextIsolation: true, sandbox: true, userAgent }
  })
  const contents = window.webContents
  contents.on('console-message', (details) => {
    if (!details.message.startsWith(tag)) return
    try {
      const payload = JSON.parse(details.message.slice(tag.length))
      if (payload.event === 'enter' || payload.event === 'observer-installed') log('page', payload)
    } catch {
      log('invalid-page-report')
    }
  })
  contents.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown' || input.key !== 'Enter' || input.isAutoRepeat) return
    log('native-enter', { shift: input.shift, control: input.control, alt: input.alt, meta: input.meta })
  })
  // Match the app's interception installation phase so page-listener ordering
  // is observed after the same load event, rather than earlier at dom-ready.
  contents.on('did-finish-load', () => {
    void contents.executeJavaScript(observerSource).catch((error) => log('observer-install-failed', { reason: error.message }))
  })
  contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (code !== -3 && isMainFrame) log('load-failed', { code, description })
  })
  window.on('close', () => log('close'))
  await contents.loadURL('https://chatgpt.com/').catch((error) => log('load-failed', { reason: error.message }))
}).catch((error) => { log('probe-failed', { reason: error.message }); app.quit() })

app.on('window-all-closed', () => app.quit())
