/** User runs and operates this observer. It never selects, uploads, or sends a file. */
const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')
const captureAttachmentStructure = require('./attachment-structure.cjs')

// Read the app's actual adapter; do not maintain a second set of website selectors.
function load(relative) {
  const file = path.resolve(__dirname, '../..', relative)
  const target = new Module(file, module)
  target.filename = file
  target.paths = Module._nodeModulePaths(path.dirname(file))
  target.require = function (request) {
    const local = path.resolve(path.dirname(file), request) + '.ts'
    return request.startsWith('.') && fs.existsSync(local) ? load(local) : Module.prototype.require.call(this, request)
  }
  target._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file)
  return target.exports
}
const { CHATGPT_PLATFORM, DEEPSEEK_PLATFORM } = load('src/shared/platforms.ts')
const platformId = process.argv.includes('deepseek') ? 'deepseek' : 'chatgpt'
const platform = platformId === 'deepseek' ? DEEPSEEK_PLATFORM : CHATGPT_PLATFORM
const knownNames = []
for (let index = 2; index < process.argv.length; index++) {
  if (process.argv[index] !== '--file-name') continue
  const name = process.argv[++index]
  if (!name || name.length > 300 || /[\0\r\n]/.test(name)) throw new Error('--file-name 必须是非空文件名（最长 300 字符）')
  knownNames.push(name)
}
const inspectExisting = knownNames.length > 0

app.setPath('userData', process.env.PROBE_USER_DATA || path.join(app.getPath('appData'), 'GPT Web to Codex Terminal'))
const partition = process.env.PROBE_PARTITION || platform.partition
const logDir = path.join(app.getPath('temp'), 'gpt-login-diag')
fs.mkdirSync(logDir, { recursive: true })
const sampleName = `attach-probe-${Date.now()}-${process.pid}${platformId === 'deepseek' ? '.txt' : ''}`
const sampleFile = path.join(logDir, sampleName)
fs.writeFileSync(sampleFile, 'Attachment upload diagnostic sample.\nThis file contains no private data.\n', { encoding: 'utf8', flag: 'wx' })
knownNames.push(sampleName)
const logFile = path.join(logDir, `${platformId}-attachments-${new Date().toISOString().replace(/[:.]/g, '-')}.log`)
const log = (event, data = {}) => fs.appendFileSync(logFile, `${new Date().toISOString()} ${event} ${JSON.stringify(data)}\n`)
const source = fs.readFileSync(path.join(__dirname, '../../src/main/injected/send-interceptor.js'), 'utf8')
let timer
let last = ''
let inspecting = false

app.whenReady().then(async () => {
  const pageSession = session.fromPartition(partition)
  await pageSession.setProxy({ proxyRules: process.env.PROBE_PROXY || 'http://127.0.0.1:7897' })
  const version = String(process.versions.chrome)
  // One registration only; Electron has a single listener slot for this event.
  pageSession.webRequest.onBeforeSendHeaders((details, callback) => {
    if (platformId === 'chatgpt' && /^https:\/\/([a-z0-9-]+\.)*(chatgpt\.com|openai\.com)(\/|$)/i.test(details.url)) {
      details.requestHeaders['sec-ch-ua'] = `"Google Chrome";v="${version.split('.')[0]}", "Chromium";v="${version.split('.')[0]}", "Not(A:Brand";v="24"`
      if ('sec-ch-ua-full-version-list' in details.requestHeaders) details.requestHeaders['sec-ch-ua-full-version-list'] = `"Google Chrome";v="${version}", "Chromium";v="${version}"`
    }
    callback({ requestHeaders: details.requestHeaders })
  })
  const window = new BrowserWindow({ width: 1300, height: 950, title: `${platform.label} 附件诊断（请手动操作）`, webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true } })
  const contents = window.webContents
  contents.setUserAgent(`Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`)
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('did-fail-load', (_event, code, description) => log('LOAD-FAIL', { code, description }))
  contents.on('did-finish-load', async () => {
    try {
      if (new URL(contents.getURL()).origin !== new URL(platform.homeUrl).origin) return
      await contents.executeJavaScript(source + `\n;window.__cmdTerminalInterceptor.configure(${JSON.stringify({ enabled: false, armBaseline: true, page: platform.page })});true`)
    } catch (error) { log('INJECT-FAIL', { message: error.message }) }
  })
  const inspect = async () => {
    if (contents.isDestroyed() || inspecting || !contents.getURL()) return
    inspecting = true
    try {
      // Do not inspect login pages or other origins during a redirect.
      if (new URL(contents.getURL()).origin !== new URL(platform.homeUrl).origin) return
      const snapshot = await contents.executeJavaScript(`(() => {
        const api = window.__cmdTerminalInterceptor;
        const diagnostic = api?.attachmentDiagnostics?.() || {};
        const page = ${JSON.stringify(platform.page)};
        const composer = page.composerSelectors.map(selector => document.querySelector(selector)).find(Boolean);
        const fileInputs = [...document.querySelectorAll('input[type="file"]')];
        const selectedNames = window.__attachmentProbeNames || (window.__attachmentProbeNames = new Set());
        ${JSON.stringify(knownNames)}.forEach(name => selectedNames.add(name));
        if (!window.__attachmentProbeListening) {
          window.__attachmentProbeListening = true;
          // Observe once, before native handlers can clear the input's FileList.
          document.addEventListener('change', event => {
            if (event.target?.matches?.('input[type="file"]')) [...(event.target.files || [])].forEach(file => selectedNames.add(file.name));
          }, true);
        }
        fileInputs.forEach(input => [...(input.files || [])].forEach(file => selectedNames.add(file.name)));
        const ancestors = [];
        const ancestorNodes = [];
        for (let parent = composer?.parentElement, depth = 0; parent && parent !== document.body && depth < 8; parent = parent.parentElement, depth++) {
          ancestors.push({ tag: parent.tagName, classes: String(parent.className || '').slice(0, 200), controls: parent.querySelectorAll('button,[role="button"]').length, inputs: parent.querySelectorAll('input[type="file"]').length, images: parent.querySelectorAll('img').length });
          ancestorNodes.push(parent);
        }
        const root = ancestorNodes[diagnostic.attachmentAncestors?.find(node => node.selectedRoot)?.depth] || null;
        const turns = [...new Set(page.messageSelectors.flatMap(selector => [...document.querySelectorAll(selector)]))].slice(-4);
        return {
          page: location.origin + location.pathname,
          platformId: ${JSON.stringify(platformId)}, ancestors,
          state: { rootFound: diagnostic.rootFound, composerFound: diagnostic.composerFound, sendFound: diagnostic.sendFound, sendDisabled: diagnostic.sendDisabled, images: diagnostic.images, uploading: diagnostic.uploading, error: diagnostic.error, inputFiles: diagnostic.inputFiles, previewTextLength: String(diagnostic.text || '').length },
          inputs: [...document.querySelectorAll('input[type="file"]')].map(input => ({ accept: input.accept, multiple: input.multiple, disabled: input.disabled, ancestorTags: [input.parentElement?.tagName, input.parentElement?.parentElement?.tagName], files: [...(input.files || [])].map(file => ({ name: file.name, type: file.type, size: file.size })) })),
          controls: root ? [...root.querySelectorAll('button,[role="button"]')].map(button => ({ tag: button.tagName, classes: String(button.className || '').slice(0, 200), aria: button.getAttribute('aria-label'), testid: button.getAttribute('data-testid'), disabled: button.disabled === true || button.getAttribute('aria-disabled') === 'true' || (page.disabledControlSelectors || []).some(selector => button.matches(selector)) })) : [],
          progress: root ? [...root.querySelectorAll('[role="progressbar"],[aria-busy="true"]')].map(node => ({ tag: node.tagName, role: node.getAttribute('role'), busy: node.getAttribute('aria-busy') })) : [],
          messageStructure: (${captureAttachmentStructure.toString()})(page, [...selectedNames]),
          turns: turns.map(node => {
            const key = page.fileTurnPositionAttr ? String(node.getAttribute(page.fileTurnPositionAttr) || '').trim() : '';
            const numeric = /^[0-9]+$/.test(key) && Number.isSafeInteger(Number(key));
            return {
              assistant: page.assistantReplySelectors.some(selector => node.matches(selector) || node.querySelector(selector)),
              reasoning: (page.fileAssistantSelectors || []).some(selector => node.matches(selector) || node.querySelector(selector)),
              keyPresent: !!key, keyNumeric: numeric, keyLength: key.length, position: numeric ? Number(key) : null,
              images: node.querySelectorAll('img').length,
              filenameMatches: [...selectedNames].filter(name => String(node.textContent || '').includes(name)).length
            };
          })
        };
      })()`)
      const value = JSON.stringify(snapshot)
      if (value !== last) { log('SNAPSHOT', snapshot); last = value }
    } catch (error) { log('INSPECT-FAIL', { message: error.message }) }
    finally { inspecting = false }
  }
  timer = setInterval(inspect, 1000)
  const cookies = await pageSession.cookies.get({ url: platform.homeUrl })
  log('START', { platformId, partition, knownFilenameCount: knownNames.length, cookies: cookies.map(cookie => `${cookie.name}(len=${cookie.value.length})`), proxy: process.env.PROBE_PROXY || 'http://127.0.0.1:7897' })
  console.log(`附件探针日志：${logFile}`)
  console.log(`已生成无敏感内容的测试文件：${sampleFile}`)
  console.log(inspectExisting ? '先手动打开已有附件的那条会话，等 10 秒。然后可以手动上传上面的测试文件并发送，回复结束后再等 10 秒并关闭窗口。已有附件结构也会被采集。' : '请手动上传上面的测试文件并发送，回复结束后等 10 秒再关闭窗口；也可手动再试图片。探针只观察。')
  await contents.loadURL(platform.homeUrl)
}).catch(error => { log('FATAL', { message: error.message }); app.quit() })
app.on('window-all-closed', () => { clearInterval(timer); log('END'); app.quit() })
