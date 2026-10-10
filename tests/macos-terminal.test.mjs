// User-run macOS regressions. No Electron, user database or third-party service.
// This starts local login shells just like the app. Run: npm run test:mac
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import { buildSync } from 'esbuild'

// Bundle TypeScript into TEMP so Node need not resolve extensionless imports or
// parameter properties. Importing the bundle does not start an application.
const directory = realpathSync(mkdtempSync(join(tmpdir(), 'ct-macos-test-')))
after(() => rmSync(directory, { recursive: true, force: true }))
const bundle = join(directory, 'terminal.cjs')
const built = buildSync({
  stdin: {
    contents: `export { ConversationShell } from './src/main/shell';
      export { CommandRunner } from './src/main/commands';
      export { nodeFallback, parseLocalPosixEnvironment } from './src/main/environment';
      export { buildTerminalPrompt, FALLBACK_ENVIRONMENT } from './src/shared/types';`,
    resolveDir: dirname(dirname(fileURLToPath(import.meta.url))), loader: 'ts'
  },
  bundle: true, platform: 'node', format: 'cjs', write: false
})
writeFileSync(bundle, built.outputFiles[0].contents)
const { ConversationShell, CommandRunner, nodeFallback, parseLocalPosixEnvironment,
  buildTerminalPrompt, FALLBACK_ENVIRONMENT } = createRequire(import.meta.url)(bundle)
const mac = { skip: process.platform !== 'darwin', timeout: 15000 }
const quote = (value) => `'${value.replace(/'/g, "'\\''")}'`

function session(t, onOutput) {
  const instance = new ConversationShell({ initialCwd: directory, onOutput })
  t.after(() => instance.dispose())
  return instance
}

async function until(predicate) {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'expected shell event within five seconds')
    await delay(20)
  }
}

test('Mac startup and environment reports describe a local zsh, including before detection', mac, async (t) => {
  const fallback = nodeFallback()
  assert.equal(fallback.kind, 'posix')
  assert.equal(fallback.osCaption, 'macOS')
  assert.equal(fallback.shellPath, '/bin/zsh')
  assert.equal(fallback.powerShellExe, '')
  assert.equal(fallback.detected, false)
  const shell = session(t)
  const result = await shell.run(shell.probeCommand)
  assert.equal(result.exitCode, 0, result.output)
  const info = parseLocalPosixEnvironment(result.output)
  assert.equal(info.detected, true)
  assert.match(info.osCaption, /macOS|Mac OS X/)
  assert.match(info.osVersion, /^\d+\./)
  assert.equal(info.shellPath, '/bin/zsh')
  assert.ok(info.shellVersion)
  assert.equal(info.workingDirectory, directory)
  assert.equal(info.remoteTarget, '')
  const prompt = buildTerminalPrompt(info)
  assert.match(prompt, /你是 macOS 终端助手/)
  assert.match(prompt, /BSD/)
  assert.match(prompt, /Homebrew/)
  assert.doesNotMatch(prompt, /你是 Linux|你是 PowerShell|包管理按发行版/)
})

test('commands retain variables, functions and quoted Unicode directories across runs', mac, async (t) => {
  const target = join(directory, "中文 'quoted' | folder\nsecond line")
  mkdirSync(target)
  const shell = session(t)
  const first = await shell.run(`cd ${quote(target)}\nct_value='你好 world'\nct_greet() { printf '%s' "$ct_value"; }`)
  assert.equal(first.exitCode, 0, first.output)
  assert.equal(first.cwd, target)
  const second = await shell.run('ct_greet')
  assert.equal(second.output, '你好 world')
  assert.equal(second.cwd, target)
  const report = await shell.run(shell.probeCommand)
  assert.equal(parseLocalPosixEnvironment(report.output).workingDirectory, target)
  const multiline = await shell.run("cat <<'END'\nline 1\n第二行\nEND")
  assert.equal(multiline.output, 'line 1\n第二行')
})

test('stderr, missing final newlines, failures and stdin readers do not break framing', mac, async (t) => {
  const shell = session(t)
  assert.equal((await shell.run("printf 'out'; printf 'err' >&2")).output, 'outerr')
  assert.equal((await shell.run('/bin/sh -c \'exit 7\'')).exitCode, 7)
  assert.equal((await shell.run('ct_nonexistent_test_executable')).exitCode, 127)
  assert.equal((await shell.run('cat')).exitCode, 0)
  const malformed = await shell.run('if then')
  assert.notEqual(malformed.exitCode, 0)
  const next = await shell.run("printf 'still ready'")
  assert.equal(next.exitCode, 0, next.output)
  assert.equal(next.output, 'still ready')
})

test('interrupt stops the process group and allows a new command in the same directory', mac, async (t) => {
  let output = ''
  const shell = session(t, (chunk) => { output += chunk })
  const running = shell.run("sleep 30 & printf 'CT_CHILD=%s\\n' \"$!\"; wait")
  await until(() => /CT_CHILD=\d+/.test(output))
  const pid = Number(/CT_CHILD=(\d+)/.exec(output)[1])
  assert.ok(pid > 1)
  assert.equal(await shell.interrupt(), true)
  const result = await running
  assert.equal(result.interrupted, true)
  assert.equal(result.sessionLost, false)
  await until(() => {
    try { process.kill(pid, 0); return false } catch (error) { return error.code === 'ESRCH' }
  })
  const next = await shell.run("printf 'restarted'")
  assert.equal(next.exitCode, 0)
  assert.equal(next.output, 'restarted')
  assert.equal(next.cwd, directory)
})

test('timeouts and explicit shell exits settle their results and reopen the session', mac, async (t) => {
  const shell = session(t)
  const timed = await shell.run('sleep 30', 1000)
  assert.equal(timed.timedOut, 'ceiling')
  assert.equal(timed.sessionLost, false)
  assert.equal((await shell.run('printf ok')).output, 'ok')
  const exited = await shell.run("printf 'partial'; exit 3")
  assert.equal(exited.sessionLost, true)
  assert.equal(exited.output, 'partial')
  assert.equal((await shell.run('printf recovered')).output, 'recovered')
})

test('a new model command replaces a busy LOCAL zsh without waiting for an SSH replacement', mac, async (t) => {
  const record = { messageId: 'next', conversationId: 'fixture', status: 'pending', kind: 'command', command: 'printf replacement' }
  const runner = new CommandRunner({
    store: {
      getExecution: () => record, listExecutions: () => [record],
      setExecutionStatus: (_id, status) => { record.status = status },
      finishExecution: (_id, result) => Object.assign(record, result),
      interruptRunningCommands: () => {}
    },
    currentConversationId: () => 'fixture', remoteShell: () => null,
    terminalModeEnabled: () => false, onTerminalChanged: () => {}, onExecutionChanged: () => {},
    onRemoteLine: () => assert.fail('local output must not be mirrored to SSH'),
    onRemoteOutput: () => assert.fail('local output must not be mirrored to SSH'),
    sendRawToPage: () => assert.fail('this test must not access a web page')
  }, directory)
  t.after(() => runner.disposeAll())
  await runner.runEnvironmentProbe()
  assert.ok(runner.getTerminalState().lines.some((line) => line.text === '探测本机环境'))
  const running = runner.sendTerminalInput("printf 'CT_RUNNING\\n'; sleep 30")
  await until(() => runner.getTerminalState().lines.some((line) => line.kind === 'output' && line.text.includes('CT_RUNNING')))
  await runner.runExecution('next')
  await running
  assert.equal(record.status, 'done')
  assert.equal(record.output, 'replacement')
  assert.equal(runner.getTerminalState().shellLabel, 'zsh')
  runner.resetTerminal()
  await runner.sendTerminalInput('printf reset-ok')
  assert.ok(runner.getTerminalState().lines.some((line) => line.kind === 'output' && line.text.includes('reset-ok')))
})

test('Windows and remote Linux prompt dialects remain available', () => {
  assert.match(buildTerminalPrompt(FALLBACK_ENVIRONMENT), /你是 PowerShell 终端助手/)
  const linux = buildTerminalPrompt({ ...FALLBACK_ENVIRONMENT, kind: 'posix', osCaption: 'Ubuntu', shellPath: '/bin/bash' })
  assert.match(linux, /包管理按发行版/)
  assert.doesNotMatch(linux, /Homebrew|你是 macOS/)
})
