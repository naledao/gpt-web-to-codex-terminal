/** User-run offline checks: actual desktop connection/auth code, fake sockets and settings. */
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm')
const { EventEmitter } = require('node:events')
const ts = require('typescript')
const root = path.resolve(__dirname, '../..')
const directory = path.join(os.tmpdir(), 'gpt-login-diag')
fs.mkdirSync(directory, { recursive: true })
const logFile = path.join(directory, `web2term-desktop-connect-check-${Date.now()}-${process.pid}.log`)
const log = text => { fs.appendFileSync(logFile, text + '\n'); console.log(text) }
const compile = text => ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
class FakeSocket extends EventEmitter {
  static OPEN = 1; static CLOSED = 3
  readyState = 0; bufferedAmount = 0; closeCalls = []; terminateCalls = 0; sends = 0; frames = []
  open() { this.readyState = 1; this.emit('open') }
  close(code, reason) { this.closeCalls.push({ code, reason }); this.readyState = 2 }
  terminate() { this.terminateCalls++; this.readyState = 3; this.emit('error', new Error('FIXTURE_PRIVATE_LATE_ERROR')); this.emit('close', 1006, Buffer.from('FIXTURE_PRIVATE_REASON')) }
  serverClose(code) { this.readyState = 3; this.emit('close', code, Buffer.from('FIXTURE_PRIVATE_REASON')) }
  send(data, callback) { this.sends++; this.frames.push(JSON.parse(data)); callback?.() }
}
function load(relative) {
  const module = { exports: {} }
  vm.runInNewContext(compile(fs.readFileSync(path.join(root, relative), 'utf8')), {
    module, exports: module.exports, Buffer, Uint8Array, URL, Date, AbortSignal, setTimeout, clearTimeout,
    fetch: () => { throw new Error('Real network forbidden') },
    require(name) {
      if (name === '../shared/backend-url') return load('src/shared/backend-url.ts')
      if (name === './web2term-terminals') return load('src/main/web2term-terminals.ts')
      if (name === 'ws') return { default: FakeSocket }
      if (['node:fs', 'node:os', 'node:path', 'node:crypto'].includes(name)) return require(name)
      throw new Error(`Unexpected dependency: ${name}`)
    }
  }, { filename: relative })
  return module.exports
}
const ast = relative => ts.createSourceFile(relative, fs.readFileSync(path.join(root, relative), 'utf8'), ts.ScriptTarget.Latest, true)
const find = (node, predicate) => predicate(node) ? node : ts.forEachChild(node, child => find(child, predicate))
const execute = (text, context) => vm.runInNewContext(compile(text), context)

async function main() {
  log(`Log: ${logFile}`)
  const { BackendAuthService } = load('src/main/backend-auth.ts')
  const { Web2termConnection, desktopWebSocketUrl } = load('src/main/web2term-connection.ts')
  for (const [base, expected] of [
    ['https://example.invalid/backend/', 'wss://example.invalid/backend/ws/desktop'],
    ['http://127.0.0.1:8080', 'ws://127.0.0.1:8080/ws/desktop'],
    ['http://[::1]:8080/app/', 'ws://[::1]:8080/app/ws/desktop']
  ]) assert.equal(desktopWebSocketUrl(base), expected)
  for (const bad of ['', 'file:///fixture', 'http://user:password@example.invalid', 'https://example.invalid/?token=fixture']) assert.throws(() => desktopWebSocketUrl(bad))
  log('PASS HTTP/HTTPS conversion, deployment paths, IPv6, and rejection of credentials/query/invalid URLs')

  const values = new Map([['backendUrl', 'https://example.invalid/backend/']])
  const store = { getSetting: key => values.get(key) ?? null, setSettings: fields => { for (const [key, value] of Object.entries(fields)) values.set(key, value) } }
  let time = Date.parse('2026-10-07T12:00:00Z'), service, token = 'FIXTURE_PRIVATE_TOKEN', expirySeconds = 3600, publicId = 'usr_fixture'
  const requests = []
  let deviceReply = () => new Response('[]', { status: 200 })
  const records = [], pushes = [], sockets = [], timers = new Map()
  let timerId = 0
  const auth = new BackendAuthService(store, {
    now: () => time,
    encrypt: value => Buffer.from(value).toString('base64'), decrypt: value => Buffer.from(value, 'base64').toString('utf8'),
    onBackendUrlSaved() {}, onLoginChanged: () => service?.credentialsChanged(),
    log: { path: null, write: record => records.push(record) },
    request: async (url, options) => {
      requests.push({ url, options })
      if (options.method === 'GET') return deviceReply()
      return new Response(JSON.stringify({ accessToken: token, tokenType: 'Bearer', expiresInSeconds: expirySeconds, user: { publicId, email: 'fixture@example.invalid', nickname: 'Fixture', avatarUrl: null, role: 'USER' } }), { status: 200 })
    }
  })
  const options = {
    now: () => time, changed: state => pushes.push(state), log: { path: 'FIXTURE_LOG_PATH', write: record => records.push(record) },
    createSocket(url, options) { const socket = new FakeSocket(); sockets.push({ socket, url, options }); return socket },
    schedule(callback, delay) { const handle = { id: ++timerId, callback, delay, unref() {} }; timers.set(handle.id, handle); return handle },
    unschedule(handle) { timers.delete(handle.id) }
  }
  service = new Web2termConnection(store, auth, options)
  const targetId = 'f2a5ddcc-43a8-4d91-b956-75d00e4e3112'
  const connect = () => service.connect({ agentId: targetId, deviceName: 'Fixture host' })
  const login = () => auth.login({ backendUrl: 'https://example.invalid/backend/', email: 'fixture@example.invalid', code: '001234' })
  const fireTimer = handle => { assert.ok(handle); timers.delete(handle.id); handle.callback() }
  assert.equal(connect().status, 'error')
  assert.equal(sockets.length, 0)
  assert.equal(auth.getConnectionCredentials(), null)
  assert.equal((await auth.listDevices()).ok, false); assert.equal(requests.length, 0)
  assert.equal((await login()).ok, true)
  assert.equal(auth.getConnectionCredentials().accessToken, token)
  assert.ok(!JSON.stringify(auth.getState()).includes(token))
  const otherId = '39d696f9-ecb9-48f9-bb86-69af399b8a3b'
  const deviceRows = [
    { deviceId: targetId.toUpperCase(), deviceName: 'Fixture host', enabled: 1, onlineStatus: 1, terminalError: 'FIXTURE_PRIVATE_DEVICE_DETAILS' },
    { deviceId: otherId, deviceName: '禁用设备', enabled: 0, onlineStatus: 0 }
  ]
  const reply = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
  deviceReply = () => reply(deviceRows)
  const listed = await auth.listDevices()
  assert.equal(listed.ok, true); assert.equal(listed.value.length, 2)
  assert.equal(listed.value[0].deviceId, targetId); assert.equal(listed.value[1].enabled, 0)
  assert.ok(!JSON.stringify(listed).includes('FIXTURE_PRIVATE'))
  assert.equal(requests.at(-1).url, 'https://example.invalid/backend/api/user/devices')
  assert.equal(requests.at(-1).options.method, 'GET')
  assert.equal(requests.at(-1).options.headers.Authorization, `Bearer ${token}`)
  assert.equal(requests.at(-1).options.redirect, 'manual')
  assert.equal(requests.at(-1).options.body, undefined)
  deviceReply = () => reply([]); assert.equal((await auth.listDevices()).value.length, 0)
  for (const bad of [{ devices: deviceRows }, [deviceRows[0], deviceRows[0]], [{ ...deviceRows[0], deviceId: 'broken' }], [{ ...deviceRows[0], enabled: '1' }], [{ ...deviceRows[0], deviceName: '' }], [{ ...deviceRows[0], onlineStatus: 3 }], 'FIXTURE_PRIVATE_INVALID_JSON', ' '.repeat(9 * 1024 * 1024)]) {
    deviceReply = () => reply(bad); assert.equal((await auth.listDevices()).ok, false)
  }
  for (const [status, text] of [[401, '重新登录'], [403, '权限'], [404, '接口'], [307, '重定向'], [429, '频繁'], [503, '暂时异常']]) {
    deviceReply = () => reply('FIXTURE_PRIVATE_RESPONSE', status)
    const result = await auth.listDevices(); assert.equal(result.ok, false); assert.ok(result.message.includes(text))
  }
  deviceReply = () => { throw Object.assign(new Error('FIXTURE_PRIVATE_REQUEST_ERROR'), { cause: { code: 'ECONNREFUSED' } }) }
  assert.ok((await auth.listDevices()).message.includes('拒绝连接'))
  let resolveDevices
  deviceReply = () => new Promise(resolve => { resolveDevices = resolve })
  const oldServerList = auth.listDevices()
  auth.setBackendUrl('https://other.example.invalid'); resolveDevices(reply(deviceRows))
  assert.equal((await oldServerList).ok, false); await login()
  const oldAccountList = auth.listDevices()
  publicId = 'usr_other_fixture'; await login(); resolveDevices(reply(deviceRows))
  assert.equal((await oldAccountList).ok, false)
  publicId = 'usr_fixture'; await login(); deviceReply = () => reply(deviceRows)
  log('PASS device GET/auth/context path, all online/offline/disabled rows, empty arrays, safe display fields, invalid/oversized responses, classified errors, and stale server/account result rejection')
  for (const draft of [undefined, null, {}, { agentId: 'broken' }, { agentId: `${targetId}\r\nX-Fixture: private` }, { agentId: 123 }]) {
    assert.equal(service.connect(draft).status, 'error'); assert.equal(sockets.length, 0)
  }
  assert.equal(service.connect({ agentId: `  ${targetId.toUpperCase()}  ` }).status, 'connecting')
  connect()
  const first = sockets.at(-1)
  assert.equal(first.url, 'wss://example.invalid/backend/ws/desktop')
  assert.equal(first.options.headers.Authorization, `Bearer ${token}`)
  assert.equal(first.options.headers['X-Agent-Id'], targetId)
  assert.equal(service.getState().agentId, targetId)
  assert.equal(service.getState().deviceName, targetId, 'An older caller without a display name falls back to its UUID')
  assert.match(first.options.headers['X-Desktop-Client-Id'], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(first.options.headers['X-Desktop-Client-Id'], values.get('web2termDesktopClientId'))
  assert.equal(first.options.followRedirects, false)
  assert.equal(first.options.handshakeTimeout, 10000)
  assert.equal(first.options.maxPayload, 64 * 1024)
  assert.equal(first.options.perMessageDeflate, false)
  assert.equal(service.getState().status, 'connecting')
  connect(); assert.equal(sockets.length, 1)
  first.socket.open()
  assert.equal(service.getState().status, 'connected')
  assert.equal(service.getState().connectedAt, new Date(time).toISOString())
  assert.ok(!JSON.stringify(service.getState()).includes(token))
  first.socket.emit('message', Buffer.from('FIXTURE_PRIVATE_PAYLOAD'))
  assert.equal(first.socket.sends, 0, 'Handshake alone does not allocate a PTY')
  service.terminals.open({ cols: 120, rows: 30 })
  assert.equal(first.socket.sends, 1)
  assert.equal(first.socket.frames[0].type, 'terminal_open')
  assert.equal(first.socket.frames[0].version, 1)
  assert.equal(service.terminals.getState().sessions.length, 1)
  log('PASS main-only token access, three authenticated headers, validated/canonical target ID, UUID v4 persistence, connecting/open states, one socket, workspace-owned terminal creation and malformed-message redaction')

  const id = service.getState().desktopClientId
  service.disconnect(); assert.equal(first.socket.closeCalls[0].code, 1000); assert.equal(timers.size, 0)
  connect(); const second = sockets.at(-1)
  assert.equal(second.options.headers['X-Desktop-Client-Id'], id)
  second.socket.open()
  first.socket.emit('open'); first.socket.emit('error', new Error(token)); first.socket.emit('close', 1006)
  assert.equal(service.getState().status, 'connected')
  assert.equal(service.getState().desktopClientId, id)
  second.socket.serverClose(1000)
  assert.equal(service.getState().status, 'disconnected')
  assert.equal(sockets.length, 2, 'No automatic reconnect after replacement/normal close')
  connect(); const cancelled = sockets.at(-1).socket
  service.disconnect(); assert.equal(cancelled.terminateCalls, 1)
  cancelled.emit('open'); assert.equal(service.getState().status, 'disconnected')
  log('PASS graceful disconnect, manual reconnect with same ID, cancellation, ignored late callbacks, and no replacement reconnect loop')

  for (const [status, expected] of [[401, '重新登录'], [403, '权限'], [400, '握手参数'], [404, '/ws/desktop'], [307, '重定向'], [503, '服务暂时异常']]) {
    connect(); const socket = sockets.at(-1).socket
    let destroyed = 0
    socket.emit('unexpected-response', { destroy() { destroyed++ } }, { statusCode: status, destroy() { destroyed++ } })
    assert.equal(destroyed, 2)
    assert.equal(service.getState().status, 'error')
    assert.ok(service.getState().message.includes(expected))
    assert.equal(socket.terminateCalls, 1)
    assert.equal(timers.size, 0)
  }
  for (const [code, expected] of [['ECONNREFUSED', '拒绝连接'], ['ENOTFOUND', '域名'], ['ETIMEDOUT', '超时'], ['CERT_HAS_EXPIRED', '证书'], ['WS_ERR_INVALID_OPCODE', '协议'], [undefined, '网络']]) {
    connect(); sockets.at(-1).socket.emit('error', Object.assign(new Error(token), { code }))
    assert.equal(service.getState().status, 'error'); assert.ok(service.getState().message.includes(expected))
    assert.ok(!JSON.stringify(service.getState()).includes(token))
  }
  connect(); fireTimer([...timers.values()].find(item => item.delay === 10000))
  assert.equal(service.getState().status, 'error'); assert.ok(service.getState().message.includes('超时'))
  log('PASS classified HTTP/DNS/TLS/refusal/protocol/network errors, handshake deadline, rejected response cleanup, and timer cleanup')

  connect(); sockets.at(-1).socket.open()
  const active = sockets.at(-1).socket
  token = 'FIXTURE_PRIVATE_NEW_TOKEN'
  await login()
  assert.equal(active.closeCalls.length, 1)
  assert.equal(service.getState().status, 'disconnected')
  connect(); assert.equal(sockets.at(-1).options.headers.Authorization, `Bearer ${token}`)
  sockets.at(-1).socket.open()
  time += expirySeconds * 1000
  fireTimer([...timers.values()][0])
  assert.equal(service.getState().status, 'error'); assert.equal(service.getState().auth.status, 'expired')
  const count = sockets.length
  connect(); assert.equal(sockets.length, count)
  time -= expirySeconds * 1000
  await login(); connect(); sockets.at(-1).socket.open()
  auth.setBackendUrl('https://other.example.invalid')
  assert.equal(service.getState().status, 'disconnected'); assert.equal(service.getState().auth.status, 'signed-out')
  assert.equal(service.getState().agentId, '', 'Never reuse another backend/account target automatically')
  connect(); assert.equal(sockets.length, count + 1)
  log('PASS renewed credentials close the old socket, expiry closes/blocks reconnect, and changing servers invalidates the old login/connection')

  expirySeconds = 100 * 365 * 86400
  await login(); connect(); sockets.at(-1).socket.open()
  const longTimer = [...timers.values()][0]
  assert.equal(longTimer.delay, 2147483647)
  fireTimer(longTimer); assert.equal(service.getState().status, 'connected')
  service.dispose(); assert.equal(timers.size, 0)
  const restored = new Web2termConnection(store, auth, options)
  assert.equal(restored.getState().agentId, targetId, 'Restore last target for the same server/account')
  restored.connect({ agentId: targetId }); assert.equal(sockets.at(-1).options.headers['X-Desktop-Client-Id'], id)
  sockets.at(-1).socket.open()
  const previousTarget = sockets.at(-1).socket
  restored.connect({ agentId: otherId, deviceName: '另一台设备' })
  assert.equal(previousTarget.closeCalls.length, 1)
  assert.equal(sockets.at(-1).options.headers['X-Agent-Id'], otherId)
  assert.equal(restored.getState().deviceName, '另一台设备')
  assert.equal(sockets.at(-1).options.headers['X-Desktop-Client-Id'], id)
  previousTarget.emit('open'); assert.equal(restored.getState().status, 'connecting')
  restored.close(); assert.equal(restored.getState().status, 'idle'); assert.equal(timers.size, 0)
  restored.dispose()
  values.set('web2termDesktopClientId', 'broken-client-id')
  const broken = new Web2termConnection(store, auth, options), before = sockets.length
  assert.equal(broken.connect({ agentId: targetId }).status, 'error'); assert.equal(sockets.length, before); broken.dispose()
  assert.ok(!JSON.stringify(records).includes('FIXTURE_PRIVATE'))
  assert.ok(!JSON.stringify(records).includes('禁用设备'), 'Device names and list bodies must not appear in request logs')
  assert.ok(!JSON.stringify(pushes).includes('FIXTURE_PRIVATE'))
  log('PASS very long expiry timers, app disposal, persistent client and account-scoped target IDs, corrupt-ID rejection, and credential/payload/error redaction')

  const mainAst = ast('src/main/index.ts')
  const callback = key => {
    const call = find(mainAst, node => ts.isCallExpression(node) && node.expression.getText(mainAst) === 'ipcMain.handle' && node.arguments[0]?.getText(mainAst) === `IpcChannels.${key}`)
    assert.ok(call, `Missing IPC ${key}`); return call.arguments[1].getText(mainAst)
  }
  const guard = find(mainAst, node => ts.isVariableDeclaration(node) && node.name.getText(mainAst) === 'canUseBackendAuth')
  const sender = { mainFrame: {} }, unauthorized = { sender, senderFrame: {}, allowed: true }, authorized = { sender, senderFrame: sender.mainFrame, allowed: true }
  let ipcCalls = 0
  const terminalCall = () => { ipcCalls++; return {} }
  const context = { isManagerEvent: event => event.allowed && event.sender === sender, EMPTY_WEB2TERM_CONNECTION: {}, EMPTY_WEB2TERM_TERMINALS: {}, terminalDenied: {}, backendAuth: { listDevices() { ipcCalls++; return Promise.resolve({ ok: true, value: [] }) } }, web2termConnection: {
    terminals: { getState: terminalCall, getBuffer: terminalCall, open: terminalCall, close: terminalCall, input: terminalCall, resize: terminalCall },
    getState() { ipcCalls++; return { status: 'idle' } }, connect() { ipcCalls++; return { status: 'connecting' } }, disconnect() { ipcCalls++; return { status: 'disconnected' } }, close() { ipcCalls++; return { status: 'idle' } }
  } }
  execute(`globalThis.canUseBackendAuth = ${guard.initializer.getText(mainAst)}`, context)
  for (const key of ['web2termGetState', 'web2termConnect', 'web2termDisconnect', 'web2termListDevices', 'web2termTerminalsGet', 'web2termTerminalBuffer', 'web2termTerminalOpen', 'web2termTerminalClose', 'web2termTerminalInput', 'web2termTerminalResize']) {
    const fn = execute(`(${callback(key)})`, context)
    const old = ipcCalls; fn(unauthorized); assert.equal(ipcCalls, old); fn(authorized); assert.equal(ipcCalls, old + 1)
  }
  const runtime = { web2term: null }
  Object.assign(context, { currentSessionId: 'fixture-session', runtimes: new Map([['fixture-session', runtime]]), managerWindow: { webContents: sender, isDestroyed: () => false }, CHATGPT_PLATFORM: { id: 'chatgpt' } })
  const selected = { agentId: targetId, deviceName: 'Fixture device', status: 'connected', auth: { backendUrl: 'https://example.invalid', user: { publicId: 'fixture-user' } } }
  context.web2termConnection.getState = () => selected
  context.web2termConnection.terminals.getState = () => ({ sessions: [] })
  let created = 0
  context.createSession = (kind, active, saved, platform, binding) => {
    assert.equal(kind, 'web2term'); assert.equal(active, true); assert.equal(binding.agentId, targetId); created++
    return runtime
  }
  const show = execute(`(${callback('workspaceShowWeb2term')})`, context)
  assert.equal(show(unauthorized), false); assert.equal(created, 0)
  assert.equal(show(authorized), true); assert.equal(created, 1)
  context.web2termConnection.terminals.getState = () => ({ sessions: [{ status: 'ready' }, { status: 'opening' }, { status: 'closing' }] })
  assert.throws(() => show(authorized), /3/)
  const runtimeForEvent = find(mainAst, node => ts.isFunctionDeclaration(node) && node.name?.text === 'runtimeForEvent')
  const getRuntime = execute(`(${runtimeForEvent.getText(mainAst)})`, context)
  assert.equal(getRuntime(authorized), runtime, 'Normal workspace operations use the managed runtime')
  Object.assign(context, { runtimeForEvent: getRuntime, FALLBACK_TERMINAL_STATE: {} })
  let workspaceClosed = 0, tasksEnded = 0
  runtime.web2term = { close() { workspaceClosed++ } }
  runtime.runner = { getTerminalState: () => ({ alive: false, lines: ['retained fixture transcript'] }), async endTask() { tasksEnded++ } }
  const closeTerminal = execute(`(${callback('terminalCloseWeb2term')})`, context)
  await closeTerminal(unauthorized)
  await closeTerminal({ ...authorized, allowed: false })
  await closeTerminal({ ...authorized, sender: { mainFrame: authorized.senderFrame } })
  assert.equal(workspaceClosed, 0); assert.equal(tasksEnded, 0)
  const retainedTerminal = await closeTerminal(authorized)
  assert.equal(workspaceClosed, 1); assert.equal(tasksEnded, 1); assert.equal(retainedTerminal.lines[0], 'retained fixture transcript')
  assert.equal(context.runtimes.get('fixture-session'), runtime, 'Closing a terminal retains the workspace')
  let reconnects = 0, resets = 0, historiesCleared = 0
  runtime.runner.resetTerminal = () => { historiesCleared++ }
  runtime.web2term = { alive: false, reconnect() { reconnects++ }, reset() { resets++ } }
  const resetTerminal = execute(`(${callback('terminalReset')})`, context)
  resetTerminal(authorized); assert.equal(reconnects, 1); assert.equal(historiesCleared, 0, 'Explicit reconnect preserves terminal history')
  runtime.web2term.alive = true
  resetTerminal(authorized); assert.equal(resets, 1); assert.equal(historiesCleared, 1, 'Reset of a ready PTY still clears history')
  runtime.web2term = null
  await closeTerminal(authorized); assert.equal(workspaceClosed, 1); assert.equal(tasksEnded, 1, 'A local workspace must not be closed through this IPC')
  const close = execute(`(${callback('web2termClose')})`, context), oldCalls = ipcCalls
  close(unauthorized); assert.equal(ipcCalls, oldCalls)
  close(authorized); assert.equal(ipcCalls, oldCalls + 1)
  log('PASS main-frame authorization, normal managed workspace activation, three-terminal limit, scoped terminal close/task cancellation, transcript-preserving reconnect, ready-terminal reset and transport close')

  const uiAst = ast('src/renderer/src/components/Web2termDeviceDialog.tsx')
  const acceptNode = find(uiAst, node => ts.isVariableDeclaration(node) && node.name.getText(uiAst) === 'accept')
  let currentState = { revision: 5, status: 'connected' }
  const uiContext = { alive: { current: true }, setState: update => { currentState = update(currentState) }, setLoading() {} }
  const accept = execute(`(${acceptNode.initializer.arguments[0].getText(uiAst)})`, uiContext)
  accept({ revision: 3, status: 'connecting' }); assert.equal(currentState.status, 'connected')
  accept({ revision: 6, status: 'disconnected' }); assert.equal(currentState.status, 'disconnected')
  uiContext.alive.current = false; accept({ revision: 7, status: 'error' }); assert.equal(currentState.revision, 6)
  log('PASS late IPC snapshots cannot overwrite newer pushed connection state or update an unmounted view')
  const dialogAst = ast('src/renderer/src/components/Web2termDeviceDialog.tsx')
  const refreshNode = find(dialogAst, node => ts.isVariableDeclaration(node) && node.name.getText(dialogAst) === 'refreshDevices')
  const pendingLists = [], catalogUpdates = []
  const catalogContext = { signedIn: true, identity: 'account-A', request: { current: 0 }, alive: { current: true }, setCatalog: value => catalogUpdates.push(value), window: { api: { listWeb2termDevices: () => new Promise(resolve => pendingLists.push(resolve)) } } }
  const refreshCatalog = execute(`(${refreshNode.initializer.arguments[0].getText(dialogAst)})`, catalogContext)
  const earlier = refreshCatalog(); catalogContext.identity = 'account-B'; const later = refreshCatalog()
  pendingLists[1]({ ok: true, value: [deviceRows[1]], logPath: null }); await later
  pendingLists[0]({ ok: true, value: [deviceRows[0]], logPath: null }); await earlier
  assert.equal(catalogUpdates.at(-1).identity, 'account-B'); assert.equal(catalogUpdates.at(-1).devices[0].deviceId, otherId)
  const unmounted = refreshCatalog(), updateCount = catalogUpdates.length
  catalogContext.alive.current = false; pendingLists[2]({ ok: true, value: [], logPath: null }); await unmounted
  assert.equal(catalogUpdates.length, updateCount)
  const currentCatalog = find(dialogAst, node => ts.isVariableDeclaration(node) && node.name.getText(dialogAst) === 'current')
  const selectionContext = { signedIn: true, identity: 'account-B', catalog: { identity: 'account-A', devices: deviceRows }, EMPTY_CATALOG: { devices: [] } }
  assert.equal(execute(`(${currentCatalog.initializer.getText(dialogAst)})`, selectionContext).devices.length, 0)
  log('PASS device refresh race/unmount isolation and immediate hiding of an earlier account catalogue')
  const chooseNode = find(dialogAst, node => ts.isVariableDeclaration(node) && node.name.getText(dialogAst) === 'connectDevice')
  let activations = 0, chosenDraft, nextConnection = { status: 'connecting' }
  const deviceErrors = []
  const chooseContext = { locked: false, alive: { current: true }, setPending() {}, setError: message => deviceErrors.push(message), accept() {}, onConnected: async () => { activations++ }, window: { api: { connectWeb2term: async draft => { chosenDraft = draft; return nextConnection } } } }
  const choose = execute(`(${chooseNode.initializer.getText(dialogAst)})`, chooseContext)
  await choose(deviceRows[1]); assert.equal(activations, 0); assert.equal(chosenDraft, undefined)
  await choose(deviceRows[0]); assert.equal(activations, 1); assert.equal(chosenDraft.agentId, deviceRows[0].deviceId)
  nextConnection = { status: 'error', message: 'FIXTURE_CONNECTION_FAILURE' }
  await choose(deviceRows[0]); assert.equal(activations, 1); assert.equal(deviceErrors.at(-1), 'FIXTURE_CONNECTION_FAILURE')
  nextConnection = { status: 'connected' }; chooseContext.alive.current = false
  await choose(deviceRows[0]); assert.equal(activations, 1, 'A retired dialog must not activate a workspace')
  const workspaceAst = ast('src/renderer/src/WorkspaceApp.tsx')
  const openPicker = find(workspaceAst, node => ts.isVariableDeclaration(node) && node.name.getText(workspaceAst) === 'openWeb2termDeviceDialog')
  let pickerOpened = false, embedHidden = false, changedWorkspace = false
  const pickerContext = { setNewSessionOpen() {}, setWeb2termDeviceDialogOpen: value => { pickerOpened = value }, window: { api: { setEmbedVisible: value => { embedHidden = value === false }, showWeb2termConnection: () => { changedWorkspace = true } } } }
  execute(`(${openPicker.initializer.getText(workspaceAst)})`, pickerContext)()
  assert.equal(pickerOpened, true); assert.equal(embedHidden, true); assert.equal(changedWorkspace, false)
  log('PASS device-dialog selection activates only accepted connections; opening the picker preserves the current workspace and hides the native embed')
  log('ALL CHECKS PASSED — offline fixtures only; live server/UI acceptance still required')
}
main().catch(error => { log(`FAIL ${error.stack || error}`); process.exitCode = 1 })
