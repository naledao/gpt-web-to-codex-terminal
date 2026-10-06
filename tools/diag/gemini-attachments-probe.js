/** User-driven Gemini attachment discovery. The user selects/uploads/sends; this probe only observes. */
const { app, BrowserWindow, session } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const vm = require('node:vm')
const zlib = require('node:zlib')
const ts = require('typescript')
const capture = require('./attachment-capture.cjs')
const describeRequest = require('./gemini-attachment-network.cjs')
const focused = process.argv.includes('--focused')

// Read the shipped descriptor, without importing the app or installing its send interceptor.
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
const { GEMINI_PLATFORM: platform } = load('src/shared/platforms.ts')
app.setPath('userData', process.env.PROBE_USER_DATA || path.join(app.getPath('appData'), 'GPT Web to Codex Terminal'))
const partition = process.env.PROBE_PARTITION || platform.partition
const proxy = process.env.PROBE_PROXY || 'http://127.0.0.1:7897'
const startUrl = process.env.PROBE_START_URL || platform.homeUrl
if (new URL(startUrl).origin !== new URL(platform.homeUrl).origin) throw new Error('PROBE_START_URL 必须是 Gemini 页面')
const directory = path.join(app.getPath('temp'), 'gpt-login-diag')
fs.mkdirSync(directory, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid
const logFile = path.join(directory, `gemini-attachments-${stamp}.log`)
const sampleDirectory = path.join(directory, `gemini-attachment-samples-${stamp}`)
fs.mkdirSync(sampleDirectory)
const log = (event, details = {}) => fs.appendFileSync(logFile, `${new Date().toISOString()} ${event} ${JSON.stringify(details)}\n`)

// All samples are generated locally, never sourced from the user's files.
const pdfStream = 'BT /F1 12 Tf 40 100 Td (Harmless Gemini attachment diagnostic.) Tj ET\n'
const pdfObjects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 160] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  `<< /Length ${Buffer.byteLength(pdfStream)} >>\nstream\n${pdfStream}endstream`
]
let pdf = '%PDF-1.4\n'
const offsets = [0]
pdfObjects.forEach((body, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${body}\nendobj\n` })
const xref = Buffer.byteLength(pdf)
pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
const pngChunk = (type, bytes) => {
  const payload = Buffer.concat([Buffer.from(type, 'ascii'), bytes])
  let crc = 0xffffffff
  for (const byte of payload) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length)
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
  return Buffer.concat([length, payload, checksum])
}
const imageHeader = Buffer.alloc(13)
const imageSize = 64
imageHeader.writeUInt32BE(imageSize, 0); imageHeader.writeUInt32BE(imageSize, 4); imageHeader[8] = 8; imageHeader[9] = 6
const stride = 1 + imageSize * 4
const pixels = Buffer.alloc(imageSize * stride)
for (let row = 0; row < imageSize; row++) {
  for (let col = 0; col < imageSize; col++) {
    const offset = row * stride + 1 + col * 4
    pixels.set([60, 100, 180, 255], offset)
  }
}
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', imageHeader), pngChunk('IDAT', zlib.deflateSync(pixels)), pngChunk('IEND', Buffer.alloc(0))])
const samples = [
  ['sample.txt', 'Harmless Gemini attachment diagnostic.\nReply with OK only.\n'],
  ['sample.js', '// Harmless source attachment; do not execute.\nconst diagnostic = "OK"\n'],
  ['sample.png', png],
  ['sample.pdf', pdf],
  ['hosts', '# Harmless extensionless text attachment.\n127.0.0.1 localhost\n'],
  ['long-' + 'attachment-diagnostic-'.repeat(6) + '.txt', 'Harmless long-filename diagnostic.\n'],
  ['样本 空格.md', '# Harmless filename diagnostic\n\nChinese and spaced filename; reply with OK only.\n']
]
samples.forEach(([name, bytes]) => fs.writeFileSync(path.join(sampleDirectory, name), bytes, { flag: 'wx' }))
const script = `(${capture.toString()})(${JSON.stringify(platform.page)},${JSON.stringify(samples.map(([name]) => name))},{"platformId":"gemini"})`
new vm.Script(script) // Syntax inspection only; no page or capture is run here.
const steps = focused ? [
  '短采集：只补充附件卡片内部结构，不需要重复完整流程。',
  '1. 关闭正常应用后启动探针，打开已有诊断会话，等 5 秒。如出现 Google 拒绝登录或访问限制，保留界面 5 秒后关闭即可；不要反复登录。',
  '2. 打开“上传和工具”/附件菜单，等 3 秒；选择从本机上传，一次选择本次样本目录里的 sample.txt、sample.png、sample.pdf。上传完成后等 10 秒；把鼠标分别停在两个文档卡片上各 3 秒，以记录文件名提示。',
  '3. 输入框不写文字，发送这三个附件。等回复结束，再等 10 秒后关闭探针。把新 .log 路径发给智能体。若有文件被拒绝，保留错误界面 5 秒即可，不必反复上传。'
] : [
  '1. 关闭正常应用后启动探针。使用现有 Gemini 登录，进入一个用于诊断的会话，先等 5 秒。如出现 Google 拒绝登录或访问限制，保留界面 5 秒后关闭探针即可；不要反复尝试登录或复制 Cookie。',
  '2. 打开“上传和工具”/附件菜单，等 3 秒；选择从本机上传（不是 Google Drive），再选择 sample.txt。上传完成后等 5 秒。输入框不写文字，尝试只发送附件；如果网站不允许，保留空输入框和附件界面 5 秒，再输入“只回复 OK”、等 5 秒后发送。',
  '3. 等回复结束。一次选择 sample.js、sample.png、sample.pdf（三个文件）。若 sample.js 成功上传，先移除它，等 3 秒，再补回它。若有文件被拒绝，保留错误界面 5 秒再移除它；其余可接受文件正常发送。上传完成后等 5 秒再发送。',
  '4. 等回复结束。上传 hosts（无扩展名）、long- 开头的文本与“样本 空格.md”（最多三个）。输入“只回复 OK”，先等 5 秒再发送。如果某种文件被拒绝，保留错误界面 5 秒再移除它；其余可接受文件正常发送。不需要故意断网。',
  '5. 等回复结束，再上传并发送一次 sample.txt，观察同名旧卡片与新卡片。再打开另一条会话，等 5 秒后回到诊断会话，检查旧附件是否仍能显示。',
  '6. 最后等 5 秒再关闭探针窗口。把上面的 .log 文件发给智能体。'
]
const instructions = [
  'Gemini 附件诊断：所有上传、删除和发送都由你手动完成，探针只观察。',
  `日志：${logFile}`, `样本目录：${sampleDirectory}`, `sample.txt：${path.join(sampleDirectory, 'sample.txt')}`, '',
  ...steps, '',
  '每次最多选择三个文件。不使用私人文件，不需要复制 Cookie，不自动选择、上传或发送。'
].join('\n')
fs.writeFileSync(path.join(sampleDirectory, '操作说明.txt'), instructions, { flag: 'wx' })

let timer
let contents
let closing = false
let inspecting = false
let activeInspection = Promise.resolve()
let last = ''
let snapshots = 0
const seen = { composer: false, fileInput: false, fileSelection: false, filenameInDraft: false, filenameInUserMessage: false, uploadProgress: false, sendControl: false }
const safeLocation = url => {
  try { const parsed = new URL(url); return { origin: parsed.origin, conversation: /^\/app\/[^/]+\/?$/.test(parsed.pathname) } } catch { return { origin: 'invalid' } }
}
const errorShape = error => ({ name: error?.name || 'Error', code: typeof error?.code === 'string' ? error.code : undefined })
const inspect = async (reason, force = false) => {
  if (!contents || contents.isDestroyed() || !contents.getURL() || inspecting) return
  inspecting = true
  try {
    if (new URL(contents.getURL()).origin !== new URL(platform.homeUrl).origin) return
    const snapshot = await contents.executeJavaScript(script)
    seen.composer ||= !!snapshot.composer
    seen.fileInput ||= snapshot.fileInputs.length > 0
    seen.fileSelection ||= snapshot.events.some(event => event.kind === 'file-selection')
    seen.filenameInDraft ||= snapshot.filenameNodes.some(node => node.ancestors.some(parent => parent.containsComposer && parent.messageCount === 0))
    seen.filenameInUserMessage ||= snapshot.messages.some(node => !node.assistant && (node.textNameMatches.length || node.labelNameMatches.length))
    seen.uploadProgress ||= [...snapshot.statusNodes, ...snapshot.events.flatMap(event => event.kind === 'upload-markers' ? event.markers : [])].some(node => node.attributes.some(attr => attr.semantic === 'progressbar' || (attr.name === 'aria-busy' && attr.semantic === 'true')))
    seen.sendControl ||= snapshot.sendControls.length > 0
    const value = JSON.stringify({ ...snapshot, events: [] })
    if (force || value !== last || snapshot.events.length) { log('SNAPSHOT', { reason, ...snapshot }); last = value; snapshots++ }
  } catch (error) { log('INSPECT-FAIL', { reason, ...errorShape(error) }) }
  finally { inspecting = false }
}
const observe = (reason, force = false) => {
  if (!inspecting) activeInspection = inspect(reason, force)
  return activeInspection
}

app.whenReady().then(async () => {
  const pageSession = session.fromPartition(partition)
  await pageSession.setProxy({ proxyRules: proxy })
  const version = String(process.versions.chrome)
  const userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`
  let nextRequest = 1
  const requests = new Map()
  // One identity handler for the whole partition, matching the app. No bodies, tokens or URLs logged.
  pageSession.webRequest.onBeforeSendHeaders({ urls: ['*://*/*'] }, (details, callback) => {
    const headers = { ...details.requestHeaders }
    for (const name of Object.keys(headers)) {
      const lower = name.toLowerCase()
      if (lower === 'user-agent') headers[name] = userAgent
      else if (lower === 'sec-ch-ua') headers[name] = `"Google Chrome";v="${version.split('.')[0]}", "Chromium";v="${version.split('.')[0]}", "Not(A:Brand";v="24"`
      else if (lower === 'sec-ch-ua-full-version-list') headers[name] = `"Google Chrome";v="${version}", "Chromium";v="${version}", "Not(A:Brand";v="24.0.0.0"`
      else if (lower === 'sec-ch-ua-full-version') headers[name] = `"${version}"`
    }
    const { observe: shouldObserve, ...request } = describeRequest(details)
    if (shouldObserve) {
      const metadata = { requestAlias: nextRequest++, ...request }
      requests.set(details.id, metadata)
      log('REQUEST', metadata)
    }
    callback({ requestHeaders: headers })
  })
  pageSession.webRequest.onCompleted({ urls: ['*://*/*'] }, details => {
    const metadata = requests.get(details.id)
    if (metadata) { log('RESPONSE', { ...metadata, statusCode: details.statusCode }); requests.delete(details.id) }
  })
  pageSession.webRequest.onErrorOccurred({ urls: ['*://*/*'] }, details => {
    const metadata = requests.get(details.id)
    if (metadata) { log('REQUEST-FAILED', { ...metadata, error: /^net::ERR_[A-Z_]+$/.test(details.error) ? details.error : 'network-error' }); requests.delete(details.id) }
  })
  const window = new BrowserWindow({ width: 1300, height: 950, title: 'Gemini 附件诊断 — 请按终端说明手动操作', webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true, userAgent } })
  contents = window.webContents
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('did-fail-load', (_event, code) => log('LOAD-FAIL', { code }))
  contents.on('did-navigate', (_event, url) => log('NAVIGATE', safeLocation(url)))
  contents.on('did-navigate-in-page', (_event, url, isMain) => { if (isMain) log('IN-PAGE', safeLocation(url)) })
  contents.on('did-finish-load', () => { if (!closing) void observe('load', true) })
  window.on('close', event => {
    if (closing) return
    event.preventDefault()
    closing = true
    clearInterval(timer)
    // Capture before webContents is destroyed; a bounded close also handles stalled pages.
    const finalCapture = async () => { await activeInspection; await observe('final', true) }
    void Promise.race([finalCapture(), new Promise(resolve => setTimeout(resolve, 2000))]).finally(() => {
      log('COVERAGE', { snapshots, ...seen, note: 'Observation only; missing evidence is inconclusive, not a compatibility verdict.' })
      window.destroy()
    })
  })
  const cookies = await pageSession.cookies.get({ url: platform.homeUrl })
  log('START', { platformId: 'gemini', captureMode: focused ? 'focused' : 'full', productionReadFilesEnabled: !!load('src/shared/types.ts').fileReadingPlatform('gemini'), partition, proxyConfigured: !!proxy, electron: process.versions.electron, chrome: version, cookies: cookies.map(cookie => ({ name: cookie.name, length: cookie.value.length })), sampleTypes: samples.map(([name]) => path.extname(name) || 'extensionless') })
  console.log(instructions)
  timer = setInterval(() => { if (!closing) void observe('tick') }, 500)
  await contents.loadURL(startUrl).catch(error => log('LOAD-REJECTED', errorShape(error)))
}).catch(error => { log('FATAL', errorShape(error)); console.error(`探针未启动，请查看日志：${logFile}`); app.quit() })
app.on('window-all-closed', () => { clearInterval(timer); log('END'); app.quit() })
