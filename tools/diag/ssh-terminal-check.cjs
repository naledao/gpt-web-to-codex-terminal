/** User-run offline regressions. Never starts Electron, a shell or an SSH connection. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')
const vm = require('node:vm')
const ts = require('typescript')

const root = path.resolve(__dirname, '../..')
const logDir = path.join(os.tmpdir(), 'gpt-login-diag')
fs.mkdirSync(logDir, { recursive: true })
const logFile = path.join(logDir, `ssh-terminal-check-${Date.now()}.log`)
const log = text => { fs.appendFileSync(logFile, text + '\n'); console.log(text) }
const cache = new Map()

function load(relative) {
  const file = path.resolve(root, relative)
  if (cache.has(file)) return cache.get(file).exports
  const target = new Module(file, module)
  cache.set(file, target)
  target.filename = file
  target.paths = Module._nodeModulePaths(path.dirname(file))
  target.require = function (request) {
    if (request === 'ssh2') return { Client: class { constructor() { throw new Error('Real SSH is forbidden in this check') } } }
    if (request === 'node:child_process') return {
      spawn: () => { throw new Error('Starting a shell is forbidden in this check') },
      spawnSync: () => { throw new Error('Starting a shell is forbidden in this check') }
    }
    const local = path.resolve(path.dirname(file), request) + '.ts'
    return request.startsWith('.') && fs.existsSync(local) ? load(local) : Module.prototype.require.call(this, request)
  }
  target._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText, file)
  return target.exports
}

function terminal() {
  const { SshManager } = load('src/main/ssh.ts')
  const writes = []
  const manager = new SshManager(() => {}, () => {}, () => {})
  manager.state = { ...manager.state, attached: true, status: 'connected' }
  manager.stream = { write: text => writes.push(text), close() {} }
  return { manager, writes }
}

async function main() {
  const { manager, writes } = terminal()
  const draft = "cat <<'EOF'\r\n[Unit]\r\n\r\nDescription=sample\r\nEOF\r\nprintf done"
  await manager.write(draft)
  assert.equal(writes.pop(), "cat <<'EOF'\r[Unit]\r\rDescription=sample\rEOF\rprintf done\r")
  await manager.write('ls\n')
  assert.equal(writes.pop(), 'ls\r', 'Do not append a second Enter to an already terminated line')
  await manager.write('')
  assert.equal(writes.pop(), '\r', 'An empty submit is still Enter for an interactive prompt')
  log('PASS CRLF, here-document delimiters, blank lines and empty interactive input')

  manager.consume('\x1b[?20')
  manager.consume('04huser@host:~$ ')
  await manager.write(draft)
  assert.equal(writes.pop(), `\x1b[200~${draft.replace(/\r\n/g, '\n')}\x1b[201~\r`)
  await manager.write('synthetic-password')
  assert.equal(writes.pop(), 'synthetic-password\r')
  assert.ok(manager.getState().lines.every(line => !line.text.includes('synthetic-password')))
  manager.consume('\x1b[?2004l')
  await manager.write('first\n\nlast')
  assert.equal(writes.pop(), 'first\r\rlast\r')
  log('PASS advertised bracketed paste, split SSH packets, mode reset and password non-disclosure')

  manager.consume('\n> ')
  manager.interrupt()
  assert.deepEqual(writes.splice(0), ['\x03'], 'Ctrl+C must be a raw control byte without Enter')
  assert.ok(manager.getState().lines.some(line => line.kind === 'notice' && line.text.includes('Ctrl+C')))
  manager.stream = { write() { throw new Error('synthetic closed channel') }, close() {} }
  manager.interrupt()
  assert.ok(manager.getState().lines.some(line => line.kind === 'error' && line.text.includes('发送 Ctrl+C 失败')))
  manager.state.status = 'disconnected'
  await manager.write('ls')
  manager.interrupt()
  assert.ok(manager.getState().lines.some(line => line.kind === 'error' && line.text.includes('尚未连接')))
  manager.dispose()
  assert.equal(manager.bracketedPaste, false)
  log('PASS raw PTY Ctrl+C, incomplete input, closed/disconnected channels and teardown')

  const { CommandRunner } = load('src/main/commands.ts')
  const runner = new CommandRunner({ onTerminalChanged() {} })
  assert.equal(await runner.interruptTerminal(true), false)
  assert.equal(runner.getTerminalState().lines.length, 0, 'PTY fallback must not produce the misleading idle notice')
  let modelInterrupts = 0
  runner.activeShell = { kind: 'posix', running: true, interrupt: async () => { modelInterrupts++; return true } }
  assert.equal(await runner.interruptTerminal(true), true)
  assert.equal(modelInterrupts, 1)
  runner.activeShell = null
  let fileAborts = 0
  runner.fileAbort = { abort() { fileAborts++ } }
  assert.equal(await runner.interruptTerminal(true), true)
  assert.equal(fileAborts, 1)
  runner.fileAbort = null
  assert.equal(await runner.interruptTerminal(), false)
  assert.ok(runner.getTerminalState().lines.some(line => line.text === '当前没有正在执行的命令'))
  runner.disposeAll()
  log('PASS model/file interruption and quiet manual-SSH fallback')

  // Run the actual IPC handler with fake backends, without importing Electron.
  const indexSource = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8')
  const start = indexSource.indexOf('  ipcMain.handle(IpcChannels.terminalInterrupt,')
  const end = indexSource.indexOf('  ipcMain.handle(IpcChannels.terminalReset,', start)
  assert.ok(start >= 0 && end > start)
  let handler
  let currentRuntime
  const context = {
    ipcMain: { handle(channel, callback) { handler = callback } },
    IpcChannels: { terminalInterrupt: 'terminal:interrupt' },
    runtimeForEvent: () => currentRuntime,
    FALLBACK_TERMINAL_STATE: { lines: [] },
    console: { info() {} }
  }
  vm.runInNewContext(ts.transpileModule(indexSource.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText, context)
  const calls = []
  currentRuntime = {
    ssh: {
      getState: () => ({ attached: true, status: 'connected' }),
      interrupt: () => calls.push('pty')
    },
    runner: {
      interruptTerminal: async quiet => { calls.push(quiet); return false },
      getTerminalState: () => ({ lines: [] })
    }
  }
  await handler({})
  assert.deepEqual(calls.splice(0), [true, 'pty'])
  currentRuntime.runner.interruptTerminal = async quiet => { calls.push(quiet); return true }
  await handler({})
  assert.deepEqual(calls.splice(0), [true], 'A tracked command must retain its own interruption path')
  currentRuntime.ssh.getState = () => ({ attached: false, status: 'disconnected' })
  await handler({})
  assert.deepEqual(calls.splice(0), [undefined])
  log('PASS actual IPC routing for manual SSH, model execution and local terminal')

  // Locate and execute the real editor callbacks, including IME and selection handling.
  const appFile = path.join(root, 'src/renderer/src/App.tsx')
  const app = ts.createSourceFile(appFile, fs.readFileSync(appFile, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let editor
  function visit(node) {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(app) === 'textarea'
      && node.attributes.properties.some(attr => ts.isJsxAttribute(attr) && attr.name.getText(app) === 'className'
        && attr.initializer?.getText(app).includes('terminal-pane__command-input'))) editor = node
    ts.forEachChild(node, visit)
  }
  visit(app)
  assert.ok(editor, 'The command editor must be a multiline textarea')
  let interrupts = 0
  let submissions = 0
  let changedDraft = ''
  const frames = []
  const editorContext = {
    interruptTerminal: () => { interrupts++ },
    setCommandDraft: value => { changedDraft = value },
    requestAnimationFrame: run => { frames.push(run) }
  }
  function callback(name) {
    const attr = editor.attributes.properties.find(attr => ts.isJsxAttribute(attr) && attr.name.getText(app) === name)
    assert.ok(attr?.initializer && ts.isJsxExpression(attr.initializer))
    const js = ts.transpileModule(`(${attr.initializer.expression.getText(app)})`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 }
    }).outputText
    return vm.runInNewContext(js, editorContext)
  }
  callback('onChange')({ target: { value: draft } })
  assert.equal(changedDraft, draft)
  const onPaste = callback('onPaste')
  function paste(copied, value = '', start = value.length, end = value.length) {
    changedDraft = null
    let caret = null
    const event = {
      clipboardData: { getData(type) { assert.equal(type, 'text/plain'); return copied } },
      currentTarget: { value, selectionStart: start, selectionEnd: end,
        setSelectionRange(left, right) { caret = [left, right] } },
      prevented: false,
      preventDefault() { this.prevented = true }
    }
    onPaste(event)
    for (const frame of frames.splice(0)) frame()
    return { prevented: event.prevented, text: changedDraft, caret }
  }
  for (const ending of ['\n', '\r\n', '\r']) {
    const result = paste('usts-login set info' + ending)
    assert.equal(result.prevented, true)
    assert.equal(result.text, 'usts-login set info')
    assert.deepEqual(result.caret, [19, 19])
  }
  const multiline = paste(draft + '\r\n')
  assert.equal(multiline.text, draft.replace(/\r\n/g, '\n'),
    'Remove only the copied terminal newline; keep here-document lines and blanks')
  assert.equal(paste('  echo indented  \n').text, '  echo indented  ')
  assert.equal(paste('ok\n', 'echo ').text, 'echo ok')
  assert.equal(paste('ls\n', 'replace me', 0, 10).text, 'ls')
  for (const text of ['ls', 'ls\n\n', '\n', ' \n']) {
    assert.equal(paste(text).prevented, false, 'Ordinary pastes and intentional blank lines use native paste')
    assert.equal(changedDraft, null)
  }
  assert.equal(paste('first\n', 'prefix suffix', 7, 7).prevented, false,
    'A newline pasted before existing text must remain a separator')
  assert.equal(submissions, 0, 'Pasting must never submit a command')
  log('PASS copied LF/CRLF/CR endings, multiline/blank/indented text, selection replacement and middle-draft paste')
  const keydown = callback('onKeyDown')
  function key(key, overrides = {}) {
    const event = {
      key, ctrlKey: false, metaKey: false, shiftKey: false, nativeEvent: { isComposing: false },
      currentTarget: { selectionStart: 0, selectionEnd: 0, form: { requestSubmit() { submissions++ } } },
      prevented: false, preventDefault() { this.prevented = true }, ...overrides
    }
    keydown(event)
    return event
  }
  assert.equal(key('Enter', { shiftKey: true }).prevented, false)
  assert.equal(key('Enter', { nativeEvent: { isComposing: true } }).prevented, false)
  assert.equal(submissions, 0)
  assert.equal(key('Enter').prevented, true)
  assert.equal(submissions, 1)
  assert.equal(key('c', { ctrlKey: true }).prevented, true)
  assert.equal(interrupts, 1)
  assert.equal(key('c', { ctrlKey: true, currentTarget: { selectionStart: 0, selectionEnd: 3 } }).prevented, false)
  assert.equal(key('c', { ctrlKey: true, shiftKey: true }).prevented, false)
  assert.equal(interrupts, 1, 'Copying selected text must not interrupt a command')
  log('PASS multiline editor, Enter, Shift+Enter, IME input, Ctrl+C and selected-text copying')
  log('ALL CHECKS PASSED (offline fakes only; live SSH remains user-tested)')
}

log(`LOG ${logFile}`)
main().catch(error => { log(`FAIL ${error.stack || error}`); process.exitCode = 1 })
