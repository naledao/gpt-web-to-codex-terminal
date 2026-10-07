/** User-run offline protocol checks. No Electron, network, credentials, PTY or shell. */
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm')
const ts = require('typescript')
const root = path.resolve(__dirname, '../..')
const directory = path.join(os.tmpdir(), 'gpt-login-diag')
fs.mkdirSync(directory, { recursive: true })
const logFile = path.join(directory, `web2term-terminal-check-${Date.now()}-${process.pid}.log`)
const log = text => { fs.appendFileSync(logFile, text + '\n'); console.log(text) }
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const moduleObject = { exports: {} }
vm.runInNewContext(compile(fs.readFileSync(path.join(root, 'src/main/web2term-terminals.ts'), 'utf8')), {
  module: moduleObject, exports: moduleObject.exports, Buffer, Uint8Array, setTimeout, clearTimeout,
  require(name) { if (name === 'node:crypto') return require(name); throw new Error(`Unexpected dependency: ${name}`) }
})
const { Web2termTerminals } = moduleObject.exports
function fixture() {
  const frames = [], changes = [], output = [], logs = [], timers = new Set()
  let allow = true
  const manager = new Web2termTerminals({
    send: message => { if (!allow) return false; frames.push(message); return true },
    changed: state => changes.push(state), output: chunk => output.push(chunk), log: event => logs.push(event),
    schedule(callback, delay) { assert.equal(delay, 10000); const handle = { callback, unref() {} }; timers.add(handle); return handle },
    unschedule(handle) { timers.delete(handle) }
  })
  const receive = (type, session_id, payload, version = 1) => manager.receive(Buffer.from(JSON.stringify({ type, session_id, payload, version })), false)
  const state = id => manager.getState().sessions.find(session => session.id === id)
  const start = () => { manager.reset(); manager.attach(); return manager.open({ cols: 120, rows: 30 }).sessionId }
  const ready = id => receive('terminal_ready', id, { cols: 120, rows: 30, shell: '/bin/sh' })
  const exit = id => receive('terminal_exit', id, { exit_code: 0, reason: 'closed' })
  const fire = () => { const handle = timers.values().next().value; assert.ok(handle); timers.delete(handle); handle.callback() }
  return { manager, frames, changes, output, logs, timers, receive, state, start, ready, exit, fire, block() { allow = false } }
}

function main() {
  log(`Log: ${logFile}`)
  const f = fixture()
  assert.equal(f.manager.open({ cols: 120, rows: 30 }).ok, false)
  const first = f.start()
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(f.frames[0].type, 'terminal_open'); assert.equal(f.frames[0].version, 1)
  assert.equal(f.state(first).status, 'opening')
  assert.equal(f.manager.input(first, Buffer.from('fixture')).ok, false)
  f.ready(first); assert.equal(f.state(first).status, 'ready'); assert.equal(f.timers.size, 0)
  const second = f.manager.open({ cols: 80, rows: 24 }).sessionId
  const third = f.manager.open({ cols: 80, rows: 24 }).sessionId
  const beforeLimit = f.frames.length
  assert.equal(f.manager.open({ cols: 80, rows: 24 }).ok, false); assert.equal(f.frames.length, beforeLimit)
  assert.equal(f.manager.close(first).ok, true); assert.equal(f.state(first).status, 'closing')
  assert.equal(f.manager.open({ cols: 80, rows: 24 }).ok, false, 'Closing terminals occupy a slot until tool exit')
  f.exit(first)
  const fourth = f.manager.open({ cols: 80, rows: 24 }).sessionId
  assert.notEqual(fourth, first); assert.equal(f.manager.getState().sessions.length, 3)
  assert.equal(f.state(first), undefined); assert.equal(f.manager.getBuffer(first), null)
  assert.ok(f.state(second)); assert.ok(f.state(third))
  f.ready(first); assert.equal(f.frames.at(-1).type, 'terminal_close', 'Removed terminal cannot be resurrected by late ready')
  assert.equal(f.state(first), undefined)
  log('PASS workspace-owned creation, UUID sessions, three-slot limit including opening/closing, exit slot reuse, tab pruning and retired-ID cleanup')

  const io = fixture(), id = io.start(); io.ready(id)
  const bytes = Buffer.concat([Buffer.from('FIXTURE_INPUT\r\n中'), Buffer.from([3, 27, 91, 65]), Buffer.alloc(11000, 97)])
  assert.equal(io.manager.input(id, bytes).ok, true)
  const inputs = io.frames.filter(frame => frame.type === 'terminal_input')
  assert.ok(inputs.length > 1)
  assert.ok(inputs.every(frame => Buffer.from(frame.payload.data, 'base64').length <= 4096 && Buffer.byteLength(JSON.stringify(frame)) < 8192))
  assert.deepEqual(Buffer.concat(inputs.map(frame => Buffer.from(frame.payload.data, 'base64'))), bytes)
  const beforeInput = io.frames.length
  assert.equal(io.manager.input(id, Buffer.alloc(16385)).ok, false)
  assert.equal(io.manager.input(id, 'invalid').ok, false); assert.equal(io.frames.length, beforeInput)
  assert.equal(io.manager.resize(id, { cols: 132, rows: 43 }).ok, true)
  assert.equal(io.frames.at(-1).type, 'terminal_resize'); assert.equal(io.state(id).cols, 132)
  const beforeResize = io.frames.length
  assert.equal(io.manager.resize(id, { cols: 132, rows: 43 }).ok, true); assert.equal(io.frames.length, beforeResize)
  assert.equal(io.manager.resize(id, { cols: 0, rows: 43 }).ok, false)
  assert.equal(io.manager.resize(id, { cols: 1.5, rows: 43 }).ok, false)
  const chunks = [Buffer.from([0xe4, 0xb8]), Buffer.from([0xad]), Buffer.from('\x1b[31mFIXTURE_OUTPUT\x1b[0m')]
  for (const chunk of chunks) io.receive('terminal_output', id, { data: chunk.toString('base64') })
  assert.deepEqual(io.output.map(chunk => chunk.sequence), [1, 2, 3])
  assert.deepEqual(Buffer.concat(io.manager.getBuffer(id).chunks.map(chunk => Buffer.from(chunk.data, 'base64'))), Buffer.concat(chunks))
  const snapshot = io.manager.getBuffer(id); snapshot.chunks[0].data = 'MUTATED'
  assert.notEqual(io.manager.getBuffer(id).chunks[0].data, 'MUTATED')
  io.receive('terminal_error', id, { code: 'INVALID_SIZE', message: 'Fixture invalid size' })
  assert.equal(io.state(id).status, 'ready', 'A rejected operation does not mean the PTY exited')
  io.receive('terminal_error', id, { code: 'INPUT_BACKPRESSURE', message: 'Fixture backpressure' })
  assert.equal(io.state(id).status, 'closing'); io.exit(id); assert.equal(io.state(id).status, 'closed')
  assert.ok(!JSON.stringify(io.logs).includes('FIXTURE_INPUT'))
  assert.ok(!JSON.stringify(io.logs).includes('FIXTURE_OUTPUT'))
  log('PASS raw input ordering, Ctrl+C/ANSI/UTF-8 bytes, input chunking/limits, dimension validation/deduplication, split UTF-8 output, ordered history, snapshot isolation and nonfatal/fatal error handling')

  const timeout = fixture(), late = timeout.start()
  timeout.fire(); assert.equal(timeout.state(late).status, 'error'); assert.equal(timeout.state(late).errorCode, 'OPEN_TIMEOUT')
  assert.equal(timeout.frames.at(-1).type, 'terminal_close')
  timeout.ready(late); assert.equal(timeout.state(late).status, 'error'); assert.equal(timeout.frames.at(-1).type, 'terminal_close')
  timeout.manager.close(late); timeout.ready(late); assert.equal(timeout.state(late), undefined)
  const next = timeout.manager.open({ cols: 120, rows: 30 }).sessionId; timeout.ready(next)
  timeout.manager.close(next); timeout.fire(); assert.equal(timeout.state(next).status, 'closing')
  assert.ok(timeout.state(next).message.includes('再次关闭'))
  timeout.manager.close(next); assert.equal(timeout.timers.size, 1)
  timeout.exit(next); assert.equal(timeout.timers.size, 0)
  log('PASS tool-open timeout, best-effort cancellation, late ready cleanup, close timeout retains slot, close retry and timer cleanup')

  const history = fixture(), historyId = history.start(); history.ready(historyId)
  for (let index = 0; index < 70; index++) history.receive('terminal_output', historyId, { data: Buffer.alloc(16384, 97).toString('base64') })
  const buffered = history.manager.getBuffer(historyId)
  assert.equal(buffered.truncated, true)
  assert.ok(buffered.chunks.reduce((sum, chunk) => sum + Buffer.from(chunk.data, 'base64').length, 0) <= 1024 * 1024)
  assert.equal(buffered.chunks.at(-1).sequence, 70)
  const oldConnection = history.manager.getState().connectionId
  history.manager.disconnect(true)
  assert.equal(history.frames.at(-1).type, 'terminal_close'); assert.equal(history.state(historyId).status, 'disconnected')
  assert.ok(history.manager.getBuffer(historyId).chunks.length > 0)
  history.ready(historyId); assert.equal(history.state(historyId).status, 'disconnected')
  history.manager.reset(); assert.notEqual(history.manager.getState().connectionId, oldConnection)
  assert.equal(history.manager.getBuffer(historyId), null); assert.equal(history.timers.size, 0)
  history.manager.attach(); history.ready(historyId); assert.equal(history.state(historyId), undefined)
  log('PASS bounded history, ordered recent output, graceful close notification, disconnect state, history preservation and reconnect/account reset isolation')

  const invalid = fixture(), validId = invalid.start(); invalid.ready(validId)
  invalid.manager.receive(Buffer.from('FIXTURE_PRIVATE_INVALID_JSON'), false)
  invalid.manager.receive(Buffer.from('{}'), true)
  invalid.receive('terminal_ready', validId, { cols: 80, rows: 24, shell: '/bin/sh' }, 2)
  invalid.receive('terminal_output', validId, { data: 'AB==' })
  invalid.receive('terminal_output', validId, { data: Buffer.alloc(16385).toString('base64') })
  invalid.receive('terminal_output', 'invalid-id', { data: '' })
  invalid.receive('terminal_exit', validId, { exit_code: '0', reason: 'closed' })
  invalid.receive('agent_hello', undefined, { max_terminals: 3 })
  assert.equal(invalid.state(validId).status, 'ready'); assert.equal(invalid.output.length, 0)
  assert.ok(!JSON.stringify(invalid.logs).includes('FIXTURE_PRIVATE'))
  const blocked = fixture(); blocked.manager.reset(); blocked.block(); blocked.manager.attach(); blocked.manager.open({ cols: 120, rows: 30 })
  assert.equal(blocked.manager.getState().sessions[0].status, 'error'); assert.equal(blocked.timers.size, 0)
  const blockedClose = fixture(), blockedCloseId = blockedClose.start(); blockedClose.ready(blockedCloseId); blockedClose.block()
  assert.equal(blockedClose.manager.close(blockedCloseId).ok, false)
  assert.equal(blockedClose.state(blockedCloseId).status, 'closing'); assert.equal(blockedClose.state(blockedCloseId).errorCode, 'CLOSE_SEND_FAILED')
  assert.equal(blockedClose.timers.size, 0); assert.ok(blockedClose.state(blockedCloseId).message.includes('再次关闭'))
  blockedClose.manager.disconnect(false)
  log('PASS malformed/binary/version/UUID/Base64/oversized output rejection, capability compatibility, safe diagnostic categories and send failure')

  const subscriptions = fixture()
  let notifications = 0, dataNotifications = 0
  const unsubscribe = subscriptions.manager.subscribe(() => notifications++, () => dataNotifications++)
  const subscribed = subscriptions.start(); subscriptions.ready(subscribed)
  subscriptions.receive('terminal_output', subscribed, { data: Buffer.from('fixture').toString('base64') })
  assert.ok(notifications > 0); assert.equal(dataNotifications, 1)
  unsubscribe(); const previous = notifications
  subscriptions.exit(subscribed)
  assert.equal(notifications, previous)
  log('PASS managed-runtime state/output subscriptions and disposal isolation')
  log('ALL CHECKS PASSED — offline fixtures only; real backend/tool/UI acceptance still required')
}
try { main() } catch (error) { log(`FAIL ${error.stack || error}`); process.exitCode = 1 }
