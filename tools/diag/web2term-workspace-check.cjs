/** User-run offline integration checks. No Electron, network, credentials or shell process. */
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm')
const ts = require('typescript')
const root = path.resolve(__dirname, '../..')
const directory = path.join(os.tmpdir(), 'gpt-login-diag')
fs.mkdirSync(directory, { recursive: true })
const logFile = path.join(directory, `web2term-workspace-check-${Date.now()}-${process.pid}.log`)
const log = text => { fs.appendFileSync(logFile, text + '\n'); console.log(text) }
const cache = new Map()
let localStarts = 0
function load(file) {
  if (cache.has(file)) return cache.get(file)
  const module = { exports: {} }
  const source = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  vm.runInNewContext(source, {
    module, exports: module.exports, Buffer, Uint8Array, setTimeout, clearTimeout, queueMicrotask, AbortController,
    console: { info() {}, warn() {} },
    require(name) {
      if (['node:crypto', 'node:events', 'node:string_decoder'].includes(name)) return require(name)
      if (name === './shell') return { IDLE_TIMEOUT_MS: 60000, MAX_RUNTIME_MS: 600000, ConversationShell: class { constructor() { localStarts++; throw new Error('Local execution forbidden') } } }
      if (name === './environment') return { REMOTE_DETECT_COMMAND: 'fixture_environment_probe' }
      if (name === '../shared/file-requests') return { parseReadFilesRequest() { throw new Error('Unexpected file operation') } }
      if (name === './remote-shell') return load('src/main/remote-shell.ts')
      throw new Error(`Unexpected dependency: ${name}`)
    }
  }, { filename: file })
  cache.set(file, module.exports)
  return module.exports
}
const { Web2termTerminals } = load('src/main/web2term-terminals.ts')
const { Web2termShell, parseWeb2termBinding, disconnectUnusedWeb2term } = load('src/main/web2term-shell.ts')
const { CommandRunner } = load('src/main/commands.ts')
const binding = { agentId: '550e8400-e29b-41d4-a716-446655440000', deviceName: 'Fixture device', backendUrl: 'https://example.invalid', userId: 'fixture-user' }
const tick = () => new Promise(resolve => setImmediate(resolve))

function fixture() {
  const frames = [], logs = [], shells = [], timers = new Set()
  let sendsAllowed = true, disconnects = 0
  const state = { status: 'connected', agentId: binding.agentId, auth: { status: 'signed-in', backendUrl: binding.backendUrl, user: { publicId: binding.userId } }, logPath: null }
  const terminals = new Web2termTerminals({
    send: frame => { if (!sendsAllowed) return false; frames.push(frame); return true }, changed() {}, output() {}, log: record => logs.push(record),
    schedule(callback) { const handle = { callback, unref() {} }; timers.add(handle); return handle },
    unschedule(handle) { timers.delete(handle) }
  })
  terminals.reset(); terminals.attach()
  const connection = {
    terminals, getState: () => state,
    connect() { if (state.status !== 'connected') { terminals.reset(); state.status = 'connected'; terminals.attach() }; return state },
    disconnect() { disconnects++; state.status = 'disconnected'; terminals.disconnect(true); for (const shell of shells) shell.sync(); return state }
  }
  const receive = (type, id, payload) => terminals.receive(Buffer.from(JSON.stringify({ version: 1, type, session_id: id, payload })), false)
  const output = (id, bytes) => receive('terminal_output', id, { data: Buffer.from(bytes).toString('base64') })
  const input = id => Buffer.concat(frames.filter(frame => frame.type === 'terminal_input' && frame.session_id === id).map(frame => Buffer.from(frame.payload.data, 'base64'))).toString('utf8')
  async function create() {
    const shell = new Web2termShell(binding, connection); shells.push(shell)
    shell.onClosed = unconfirmed => disconnectUnusedWeb2term(connection, shells, binding, unconfirmed)
    shell.activate(); await tick()
    const id = frames.filter(frame => frame.type === 'terminal_open').at(-1).session_id
    return { shell, id }
  }
  async function ready(id) {
    receive('terminal_ready', id, { cols: 120, rows: 30, shell: '/bin/bash' }); await tick()
    const marker = input(id).match(/__W2T_READY_[a-f0-9]+__/)[0]
    output(id, `fixture echoed bootstrap\r\n${marker.slice(0, 15)}`)
    output(id, `${marker.slice(15)}\r\n`); await tick()
  }
  function complete(id, text, cwd = '/fixture', code = 0) {
    const markers = [...input(id).matchAll(/__CT_DONE_([a-f0-9]+)_%s__ %s %s\\n' '(\d+)'/g)]
    assert.ok(markers.length, 'Command must use the existing completion envelope')
    const marker = markers.at(-1)
    const bytes = Buffer.from(`${text}\r\n__CT_DONE_${marker[1]}_${marker[2]}__ ${code} ${cwd}\r\n`)
    // Force UTF-8, CRLF and marker boundaries across independently forwarded frames.
    for (const byte of bytes) output(id, Buffer.from([byte]))
  }
  return { frames, logs, shells, state, terminals, connection, receive, output, input, create, ready, complete,
    get disconnects() { return disconnects }, blockSends() { sendsAllowed = false },
    fireCloseTimeout() { const handle = timers.values().next().value; assert.ok(handle); timers.delete(handle); handle.callback() },
    cleanup() { for (const shell of shells) shell.dispose(); terminals.disconnect(false) }
  }
}

async function main() {
  log(`Log: ${logFile}`)
  const f = fixture()
  let runner
  try {
    assert.equal(f.terminals.getState().sessions.length, 0, 'A socket is not a separate terminal page')
    const { shell, id } = await f.create()
    assert.equal(shell.alive, false)
    assert.equal((await shell.run('pwd')).rejected, true)
    await f.ready(id); assert.equal(shell.alive, true)
    assert.ok(f.input(id).includes('stty -echo -icanon'))
    assert.ok(f.input(id).includes('exec /bin/sh +i -s'))
    const records = new Map(), sent = []
    const store = {
      getExecution: id => records.get(id), listExecutions: () => [...records.values()],
      setExecutionStatus: (id, status) => { records.get(id).status = status },
      finishExecution: (id, result) => Object.assign(records.get(id), result)
    }
    runner = new CommandRunner({
      store, currentConversationId: () => 'fixture-chat', sendRawToPage: async text => { sent.push(text); return 'ok' },
      fileContext() { throw new Error('No file transport') }, filePlatform: () => null,
      prepareFiles() { throw new Error('No file transport') }, sendFilesToPage() { throw new Error('No file transport') },
      terminalModeEnabled: () => true, remoteShell: () => shell, terminalTransport: () => shell.transport,
      onRemoteLine() {}, onRemoteOutput() {}, onExecutionChanged() {}, onTerminalChanged() {}, onTaskCompleted() {}
    })
    shell.onOutput = chunk => runner.pushRemoteOutput(chunk)
    shell.onChanged = message => runner.refreshTerminal(message)
    const manual = runner.sendTerminalInput('cd /fixture; printf fixture_manual')
    f.complete(id, 'fixture_manual 中文', '/fixture'); await manual
    assert.equal(runner.getTerminalState().cwd, '/fixture')
    assert.ok(runner.getTerminalState().lines.some(line => line.text.includes('fixture_manual 中文')))
    assert.equal(sent.length, 0, 'Manual commands do not auto-send to the model')
    records.set('model-1', { messageId: 'model-1', conversationId: 'fixture-chat', command: 'pwd', status: 'pending' })
    const model = runner.runExecution('model-1'); await tick()
    f.complete(id, '/fixture'); await model
    assert.equal(records.get('model-1').status, 'done'); assert.equal(records.get('model-1').exitCode, 0)
    assert.equal(sent.length, 1); assert.ok(sent[0].includes('/fixture'))
    assert.equal(runner.getTerminalState().transport.kind, 'web2term')
    assert.equal(localStarts, 0)
    log('PASS original manual/model execution pipeline, framed completion, split UTF-8 output, cwd, exit status and model result return')

    const second = await f.create(), third = await f.create()
    await f.ready(second.id); await f.ready(third.id)
    const fourth = new Web2termShell(binding, { terminals: f.terminals, getState: () => f.state })
    f.shells.push(fourth); fourth.activate(); await tick()
    assert.equal(fourth.transport.status, 'error'); assert.equal(f.terminals.getState().sessions.filter(item => item.status === 'ready').length, 3)
    const otherOutput = [], ownOutput = []
    second.shell.onOutput = text => otherOutput.push(text)
    third.shell.onOutput = text => ownOutput.push(text)
    const otherRun = second.shell.run('printf independent')
    f.complete(second.id, 'independent'); await otherRun
    assert.ok(otherOutput.join('').includes('independent')); assert.equal(ownOutput.length, 0)
    log('PASS one PTY per managed workspace, three concurrent slots and isolated output')

    const pending = runner.sendTerminalInput('sleep 300'); await tick()
    await runner.interruptTerminal(); await pending
    assert.ok(f.frames.some(frame => frame.type === 'terminal_close' && frame.session_id === id))
    assert.equal(f.terminals.getState().sessions.filter(item => ['opening', 'ready', 'closing'].includes(item.status)).length, 3)
    f.receive('terminal_exit', id, { exit_code: 0, reason: 'closed' }); await tick()
    const replacement = f.frames.filter(frame => frame.type === 'terminal_open').at(-1).session_id
    assert.notEqual(replacement, id); await f.ready(replacement)
    f.complete(replacement, '', '/fixture'); await tick()
    assert.equal(shell.alive, true)
    log('PASS interruption settles pending command and waits for tool exit before reusing the slot')

    const openings = f.frames.filter(frame => frame.type === 'terminal_open').length
    second.shell.close(); await tick()
    assert.equal(second.shell.transport.status, 'closing'); assert.equal(second.shell.alive, false)
    f.receive('terminal_exit', second.id, { exit_code: 0, reason: 'closed' }); await tick()
    assert.equal(second.shell.transport.status, 'disconnected'); assert.equal(second.shell.transport.canClose, false)
    assert.equal(third.shell.alive, true); assert.equal(f.disconnects, 0)
    records.set('close-running', { messageId: 'close-running', conversationId: 'fixture-chat', command: 'sleep 300', status: 'pending' })
    const sentBeforeClose = sent.length, closingRun = runner.runExecution('close-running'); await tick()
    shell.close(); await runner.endTask(); await closingRun; await tick()
    assert.equal(records.get('close-running').status, 'interrupted'); assert.equal(sent.length, sentBeforeClose)
    f.receive('terminal_exit', replacement, { exit_code: 0, reason: 'closed' }); await tick()
    assert.equal(shell.transport.status, 'disconnected'); assert.equal(third.shell.alive, true)
    assert.ok(runner.getTerminalState().lines.some(line => line.text.includes('fixture_manual 中文')), 'Close preserves transcript')
    third.shell.close(); await tick(); assert.equal(f.disconnects, 0, 'Wait for the last tool acknowledgement')
    f.receive('terminal_exit', third.id, { exit_code: 0, reason: 'closed' }); await tick()
    assert.equal(f.disconnects, 1); assert.equal(f.state.status, 'disconnected')
    assert.equal(f.frames.filter(frame => frame.type === 'terminal_open').length, openings, 'User close must never reopen a PTY')
    await runner.sendTerminalInput('must_not_run_after_close')
    assert.equal(localStarts, 0); assert.equal(f.frames.filter(frame => frame.type === 'terminal_open').length, openings)
    shell.reconnect(); await tick()
    const reopened = f.frames.filter(frame => frame.type === 'terminal_open').at(-1).session_id
    assert.notEqual(reopened, replacement); await f.ready(reopened); f.complete(reopened, '', '/fixture'); await tick()
    assert.equal(shell.alive, true); assert.equal(shell.cwd, '/fixture')
    assert.ok(runner.getTerminalState().lines.some(line => line.text.includes('fixture_manual 中文')))
    log('PASS scoped idle/running close, task cancellation, retained transcript, no resurrection, other PTYs survive, final socket release and explicit reconnect with cwd restoration')

    f.state.status = 'disconnected'; f.terminals.disconnect(false); await tick()
    await runner.sendTerminalInput('must_never_run_local')
    records.set('offline', { messageId: 'offline', conversationId: 'fixture-chat', command: 'must_never_run_local', status: 'pending' })
    await runner.runExecution('offline')
    assert.equal(records.get('offline').status, 'pending'); assert.equal(runner.getTerminalState().alive, false); assert.equal(localStarts, 0)
    f.state.auth.user.publicId = 'different-user'; shell.reconnect()
    assert.equal(shell.transport.status, 'error'); assert.equal(localStarts, 0)
    assert.equal(parseWeb2termBinding(JSON.stringify(binding)).agentId, binding.agentId)
    assert.equal(parseWeb2termBinding('invalid'), null)
    assert.ok(!JSON.stringify(f.logs).includes('fixture_manual'))
    log('PASS offline rejection/pending model command, no local fallback, account isolation, persistence metadata and safe logs')
  } finally { runner?.disposeAll(); f.cleanup() }

  const opening = fixture()
  try {
    const { shell, id } = await opening.create()
    shell.close(); await tick()
    opening.receive('terminal_ready', id, { cols: 120, rows: 30, shell: '/bin/bash' }); await tick()
    assert.equal(opening.frames.filter(frame => frame.type === 'terminal_input').length, 0, 'Cancelled creation must not initialize a Shell')
    assert.equal(opening.frames.at(-1).type, 'terminal_close')
    opening.receive('terminal_exit', id, { exit_code: 0, reason: 'closed' }); await tick()
    assert.equal(opening.disconnects, 1); assert.equal(shell.alive, false)
  } finally { opening.cleanup() }

  const timeout = fixture()
  try {
    const first = await timeout.create(), second = await timeout.create()
    await timeout.ready(first.id); await timeout.ready(second.id)
    first.shell.close(); timeout.fireCloseTimeout(); await tick()
    assert.equal(first.shell.transport.status, 'error'); assert.equal(first.shell.transport.canClose, true)
    assert.equal(second.shell.alive, true); assert.equal(timeout.disconnects, 0)
    second.shell.close(); timeout.receive('terminal_exit', second.id, { exit_code: 0, reason: 'closed' }); await tick()
    assert.equal(timeout.disconnects, 1, 'An earlier close timeout must not retain the last desktop route forever')
    assert.match(first.shell.transport.message, /未确认/)
  } finally { timeout.cleanup() }

  const retry = fixture()
  try {
    const first = await retry.create(), second = await retry.create()
    await retry.ready(first.id); await retry.ready(second.id)
    first.shell.close(); retry.fireCloseTimeout(); await tick()
    first.shell.close(); await tick(); assert.equal(first.shell.transport.status, 'closing')
    retry.receive('terminal_exit', first.id, { exit_code: 0, reason: 'closed' }); await tick()
    assert.equal(first.shell.transport.canClose, false); assert.equal(second.shell.alive, true); assert.equal(retry.disconnects, 0)
  } finally { retry.cleanup() }

  const failedSend = fixture()
  try {
    const { shell, id } = await failedSend.create(); await failedSend.ready(id)
    failedSend.blockSends(); shell.close(); await tick()
    assert.equal(failedSend.disconnects, 1); assert.equal(shell.transport.status, 'disconnected')
    assert.match(shell.transport.message, /未确认/)
    assert.ok(failedSend.logs.some(record => record.event === 'terminal_close_send_failed'))
  } finally { failedSend.cleanup() }

  const handshake = fixture()
  try {
    handshake.terminals.reset(); handshake.state.status = 'connecting'
    const shell = new Web2termShell(binding, handshake.connection); handshake.shells.push(shell)
    shell.onClosed = unconfirmed => disconnectUnusedWeb2term(handshake.connection, handshake.shells, binding, unconfirmed)
    shell.activate(); shell.close(); await tick()
    assert.equal(handshake.disconnects, 1); assert.equal(handshake.frames.length, 0)
    handshake.state.status = 'connected'; handshake.terminals.attach(); await tick()
    assert.equal(handshake.frames.length, 0, 'Late connection cannot reopen a cancelled workspace')
    handshake.state.agentId = '39d696f9-ecb9-48f9-bb86-69af399b8a3b'
    disconnectUnusedWeb2term(handshake.connection, [], binding, true); assert.equal(handshake.disconnects, 1)
    handshake.state.agentId = binding.agentId; handshake.state.auth.user.publicId = 'different-user'
    disconnectUnusedWeb2term(handshake.connection, [], binding, true); assert.equal(handshake.disconnects, 1)
  } finally { handshake.cleanup() }
  log('PASS creation/handshake cancellation, late ready rejection, close timeout/retry/send failure, unconfirmed feedback and device/account scoped socket release')
  log('ALL CHECKS PASSED — offline fixtures only; live workspace/tool acceptance still required')
}
main().catch(error => { log(`FAIL ${error.stack || error}`); process.exitCode = 1 })
