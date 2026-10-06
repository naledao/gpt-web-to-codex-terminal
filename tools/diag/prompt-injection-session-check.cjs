/** User-run SQLite/session checks. No Electron, real application database or network. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const { DatabaseSync } = require('node:sqlite')
const root = path.resolve(__dirname, '../..')
const logDir = path.join(os.tmpdir(), 'gpt-login-diag')
fs.mkdirSync(logDir, { recursive: true })
const logFile = path.join(logDir, `prompt-injection-session-check-${Date.now()}.log`)
const log = message => { fs.appendFileSync(logFile, message + '\n'); console.log(message) }
const fixtureDir = fs.mkdtempSync(path.join(logDir, 'prompt-injection-fixture-'))

function load(relative) {
  const filename = path.join(root, relative)
  const exports = {}
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  vm.runInNewContext(code, { exports, require: request => {
    if (request === 'electron') return { nativeImage: {} }
    if (request.startsWith('.')) return load(path.relative(root, path.resolve(path.dirname(filename), request + '.ts')))
    return require(request)
  } })
  return exports
}

class FakeEmbed {
  constructor(platform) { this.platform = platform; this.enabled = true; this.promptInjectionEnabled = true }
  setPromptInjectionEnabled(value) { this.promptInjectionEnabled = value; return this.getInterceptorStatus() }
  getInterceptorStatus() { return { enabled: this.enabled, promptInjectionEnabled: this.promptInjectionEnabled } }
  setBaselinePolicy() {}
  setPromptParts() {}
  setTheme() {}
}

function runtimeMethods() {
  const filename = path.join(root, 'src/main/session-runtime.ts')
  const parsed = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true)
  const klass = parsed.statements.find(node => ts.isClassDeclaration(node) && node.name.text === 'SessionRuntime')
  const method = name => {
    const member = klass.members.find(node => node.name?.getText(parsed) === name)
    assert.ok(member, `Missing actual runtime method: ${name}`)
    return member.getText(parsed)
  }
  const code = ts.transpileModule('class RuntimeFixture {\n' +
    ['ensureEmbed', 'activeEmbed', 'embed', 'persistentState', 'setPromptInjectionEnabled'].map(method).join('\n') +
    '\n}', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  return vm.runInNewContext(code + '\nRuntimeFixture', {
    ChatGptEmbed: FakeEmbed,
    buildTerminalPromptParts: () => ({ basePrompt: 'base', toolPrompt: 'tools', prefix: 'prefix' }),
    toolPromptForPlatform: () => 'tools'
  })
}

let store
try {
  log(`Log: ${logFile}`)
  const databaseFile = path.join(fixtureDir, 'sessions.sqlite')
  // Pre-feature table: the real store must migrate it and default old sessions to ON.
  const legacy = new DatabaseSync(databaseFile)
  legacy.exec(`CREATE TABLE managed_sessions (
    id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '',
    conversation_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  ); INSERT INTO managed_sessions (id, created_at, updated_at) VALUES ('legacy', 1, 1);`)
  legacy.close()
  const { ConversationStore } = load('src/main/db.ts')
  store = new ConversationStore(databaseFile)
  assert.equal(store.listManagedSessions().find(row => row.id === 'legacy').promptInjectionEnabled, true)
  log('PASS real SQLite migration defaults pre-existing sessions to enabled')
  const RuntimeFixture = runtimeMethods()
  const createRuntime = (id, promptInjectionEnabled = true) => {
    const runtime = new RuntimeFixture()
    Object.assign(runtime, {
      id, createdAt: 2, customTitle: '', activePlatformId: 'chatgpt', preferredSendDelaySeconds: 3,
      promptInjectionEnabled, environment: {}, sshCwd: '', window: null, lastBounds: null,
      embeds: new Map(['chatgpt', 'deepseek'].map(platformId => [platformId, {
        platform: { id: platformId, homeUrl: 'https://example.invalid/' }, embed: null, url: '', conversationId: null
      }])),
      runner: { getAutomation: () => ({ mode: 'manual', paused: false }), getTerminalState: () => ({ cwd: '' }) },
      ssh: { getState: () => ({ hostId: '', attached: false, status: 'disconnected' }) },
      embedHandlers: () => ({}),
      options: { settings: () => ({ theme: 'light' }), onSummaryChanged: () => store.upsertManagedSession(runtime.persistentState()) }
    })
    runtime.ensureEmbed('chatgpt')
    store.upsertManagedSession(runtime.persistentState())
    return runtime
  }
  const a = createRuntime('a'), b = createRuntime('b')
  a.setPromptInjectionEnabled(false)
  assert.equal(a.embed.getInterceptorStatus().promptInjectionEnabled, false)
  assert.equal(a.embed.getInterceptorStatus().enabled, true)
  assert.equal(b.embed.getInterceptorStatus().promptInjectionEnabled, true)
  assert.equal(store.listManagedSessions().find(row => row.id === 'a').promptInjectionEnabled, false)
  assert.equal(store.listManagedSessions().find(row => row.id === 'b').promptInjectionEnabled, true)
  a.ensureEmbed('deepseek')
  assert.equal(a.embeds.get('deepseek').embed.getInterceptorStatus().promptInjectionEnabled, false)
  a.setPromptInjectionEnabled(true)
  assert.equal(a.embeds.get('deepseek').embed.getInterceptorStatus().promptInjectionEnabled, true)
  a.setPromptInjectionEnabled(false)
  log('PASS actual runtime setter/snapshot isolate sessions, update cached views and initialize later platform views')
  const indexFile = path.join(root, 'src/main/index.ts')
  const indexAst = ts.createSourceFile(indexFile, fs.readFileSync(indexFile, 'utf8'), ts.ScriptTarget.Latest, true)
  const register = indexAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === 'registerIpcHandlers')
  const declaration = register.body.statements.find(node => ts.isExpressionStatement(node) &&
    ts.isCallExpression(node.expression) && node.expression.arguments[0]?.getText(indexAst) === 'IpcChannels.interceptorSetPromptInjectionEnabled')
  assert.ok(declaration, 'Missing prompt-injection IPC handler')
  let currentRuntime = a, handler
  const ipcCode = ts.transpileModule(declaration.getText(indexAst), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  vm.runInNewContext(ipcCode, {
    ipcMain: { handle: (_channel, callback) => { handler = callback } },
    IpcChannels: { interceptorSetPromptInjectionEnabled: 'interceptor:set-prompt-injection-enabled' },
    runtimeForEvent: () => currentRuntime
  })
  handler({}, true)
  assert.equal(a.embed.promptInjectionEnabled, true)
  currentRuntime = b; handler({}, false)
  assert.equal(a.embed.promptInjectionEnabled, true)
  assert.equal(b.embed.promptInjectionEnabled, false)
  handler({}, true)
  assert.throws(() => handler({}, 'false'), /当前会话不可用/)
  currentRuntime = null
  assert.throws(() => handler({}, false), /当前会话不可用/)
  a.setPromptInjectionEnabled(false)
  log('PASS actual IPC targets only the currently selected session and rejects missing sessions/non-boolean input')
  store.close(); store = new ConversationStore(databaseFile)
  const saved = store.listManagedSessions()
  const restored = createRuntime('a', saved.find(row => row.id === 'a').promptInjectionEnabled)
  assert.equal(restored.embed.getInterceptorStatus().promptInjectionEnabled, false)
  assert.equal(saved.find(row => row.id === 'b').promptInjectionEnabled, true)
  assert.equal(saved.find(row => row.id === 'legacy').promptInjectionEnabled, true)
  log('PASS real SQLite reopen retains independent ON/OFF states and legacy defaults')
  log('PASS all session prompt-injection checks; live UI and website behavior still require user testing')
} catch (error) {
  log(`FAIL ${error.stack || error}`)
  process.exitCode = 1
} finally {
  store?.close()
}
