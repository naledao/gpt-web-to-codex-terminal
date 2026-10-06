/** User-run offline checks. No Electron, real app database, shells or network. */
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os')
const path = require('node:path'), vm = require('node:vm'), ts = require('typescript')
const { DatabaseSync } = require('node:sqlite')
const root = path.resolve(__dirname, '../..'), logDir = path.join(os.tmpdir(), 'gpt-login-diag')
fs.mkdirSync(logDir, { recursive: true })
const logFile = path.join(logDir, `directory-notes-check-${Date.now()}.log`)
const log = message => { fs.appendFileSync(logFile, message + '\n'); console.log(message) }
const fixtureDir = fs.mkdtempSync(path.join(logDir, 'directory-notes-fixture-'))
function compile(source) { return ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText }
function load(relative) {
  const filename = path.join(root, relative), exports = {}
  vm.runInNewContext(compile(fs.readFileSync(filename, 'utf8')), { exports, require: request => {
    if (request === 'electron') return { nativeImage: {} }
    return request.startsWith('.') ? load(path.relative(root, path.resolve(path.dirname(filename), request + '.ts'))) : require(request)
  } })
  return exports
}
function find(node, predicate) { return predicate(node) ? node : ts.forEachChild(node, child => find(child, predicate)) }
const shared = load('src/shared/types.ts'), { normalizeTerminalNotesDirectory: normalize } = load('src/main/terminal-notes.ts')
function runtimeClass() {
  const filename = path.join(root, 'src/main/session-runtime.ts')
  const ast = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true)
  const klass = ast.statements.find(node => ts.isClassDeclaration(node) && node.name.text === 'SessionRuntime')
  const methods = ['notesTarget', 'currentNotes', 'refreshDirectoryNotes', 'refreshTerminalNotesForOwner', 'applyTerminalNotes'].map(name => {
    const member = klass.members.find(node => node.name?.getText(ast) === name)
    assert.ok(member, `Missing method: ${name}`); return member.getText(ast)
  })
  const constructor = klass.members.find(ts.isConstructorDeclaration)
  const runner = find(constructor, node => ts.isNewExpression(node) && node.expression.getText(ast) === 'CommandRunner')
  const callback = runner.arguments[0].properties.find(node => node.name?.getText(ast) === 'onTerminalChanged').initializer
  const ssh = find(constructor, node => ts.isNewExpression(node) && node.expression.getText(ast) === 'SshManager')
  methods.push(`fireTerminal(state) { (${callback.getText(ast)})(state) }`, `fireSsh(state) { (${ssh.arguments[0].getText(ast)})(state) }`)
  return vm.runInNewContext(compile('class RuntimeFixture {\n' + methods.join('\n') + '\n}') + '\nRuntimeFixture', {
    normalizeTerminalNotesDirectory: normalize, terminalNotesOwnerKey: shared.terminalNotesOwnerKey,
    buildTerminalPromptParts: shared.buildTerminalPromptParts, toolPromptForPlatform: shared.toolPromptForPlatform,
    IpcChannels: shared.IpcChannels, SETTING_LOCAL_NOTES: 'localTerminalNotes'
  })
}
let store
try {
  log(`Log: ${logFile}`)
  assert.equal(normalize('local', 'C:/Projects/Alpha/'), normalize('local', 'c:/projects/alpha'))
  assert.equal(normalize('local', 'C:/Projects/./Alpha/../Beta'), normalize('local', 'C:/Projects/Beta'))
  assert.equal(normalize('local', 'C:/'), 'c:' + String.fromCharCode(92))
  assert.equal(normalize('local', '//Server/Share/'), normalize('local', '//server/share'))
  assert.equal(normalize('local', 'C:relative'), ''); assert.equal(normalize('local', 'relative/folder'), '')
  assert.equal(normalize('ssh', '/srv/app/../other/'), '/srv/other'); assert.equal(normalize('ssh', '/'), '/')
  assert.notEqual(normalize('ssh', '/srv/App'), normalize('ssh', '/srv/app')); assert.equal(normalize('ssh', '~/app'), '')
  log('PASS absolute keys, Windows aliases/roots/UNC and case-sensitive remote paths')
  const databaseFile = path.join(fixtureDir, 'notes.sqlite'), legacy = new DatabaseSync(databaseFile)
  legacy.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO settings VALUES ('localTerminalNotes', 'LEGACY_LOCAL_FIXTURE');
    CREATE TABLE ssh_hosts (id TEXT PRIMARY KEY, name TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL,
      username TEXT NOT NULL, proxy TEXT NOT NULL DEFAULT '', secret TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    INSERT INTO ssh_hosts VALUES ('host-a', 'fixture', 'example.invalid', 22, 'fixture', '', '', 'LEGACY_SSH_FIXTURE', 1, 1);`)
  legacy.close()
  const { ConversationStore } = load('src/main/db.ts'), Runtime = runtimeClass(), runtimes = []
  store = new ConversationStore(databaseFile)
  const create = (cwd, machine = 'machine-a') => {
    const runtime = new Runtime(), control = { cwd, ssh: { attached: false }, remote: null }
    Object.assign(runtime, {
      control, disposed: false, lastDirectoryNotes: null, lastPersistedLocalCwd: cwd, sshCwd: '', remoteShell: null,
      environment: { ...shared.FALLBACK_ENVIRONMENT }, events: [], probeCount: 0,
      runner: { getTerminalState: () => ({ cwd: control.cwd }) }, ssh: { getState: () => control.ssh, execShell: () => control.remote },
      embeds: new Map(['chatgpt', 'deepseek'].map(id => [id, { platform: { id }, embed: { setPromptParts(parts) { this.parts = parts } } }])),
      options: { store, localMachineId: machine, onSummaryChanged() {}, onTerminalNotesSaved: owner => runtimes.forEach(other => other.refreshTerminalNotesForOwner(owner)) },
      send(channel, value) { this.events.push({ channel, value }) }, probeEnvironment() { this.probeCount++; return Promise.resolve(this.environment) }
    })
    runtimes.push(runtime); runtime.refreshDirectoryNotes(); return runtime
  }
  const a = create('C:/Projects/Alpha'), b = create('c:/projects/alpha/'), c = create('C:/Projects/Beta'), other = create('C:/Projects/Alpha', 'machine-b')
  assert.equal(a.currentNotes().text, ''); assert.equal(a.currentNotes().legacyText, 'LEGACY_LOCAL_FIXTURE')
  a.applyTerminalNotes('ALPHA_ONLY', a.currentNotes())
  assert.equal(b.environment.extraNotes, 'ALPHA_ONLY'); assert.equal(c.environment.extraNotes, ''); assert.equal(other.environment.extraNotes, '')
  assert.equal(a.currentNotes().legacyText, '')
  for (const entry of b.embeds.values()) assert.ok(entry.embed.parts.basePrompt.includes('ALPHA_ONLY'))
  const previousOwner = a.currentNotes()
  a.control.cwd = 'C:/Projects/Beta'; a.fireTerminal({ cwd: a.control.cwd })
  assert.equal(a.environment.extraNotes, '')
  for (const entry of a.embeds.values()) assert.ok(!entry.embed.parts.basePrompt.includes('ALPHA_ONLY'))
  assert.throws(() => a.applyTerminalNotes('WRONG_TARGET', previousOwner), /工作目录已变化/)
  assert.equal(store.getDirectoryNote('local', 'machine-a', 'C:/Projects/Beta'), null)
  a.applyTerminalNotes('BETA_ONLY', a.currentNotes()); assert.equal(c.environment.extraNotes, 'BETA_ONLY')
  a.control.cwd = 'C:/Projects/Alpha'; a.fireTerminal({ cwd: a.control.cwd }); assert.equal(a.currentNotes().text, 'ALPHA_ONLY')
  a.control.cwd = 'C:/Projects/Alpha/child'; a.fireTerminal({ cwd: a.control.cwd }); assert.equal(a.currentNotes().text, '')
  a.applyTerminalNotes('', a.currentNotes()); assert.equal(a.currentNotes().legacyText, '')
  assert.equal(store.getSetting('localTerminalNotes'), 'LEGACY_LOCAL_FIXTURE')
  log('PASS legacy retention, directory isolation/sharing, no parent inheritance, cached prompts and stale-save rejection')
  const remote = create('C:/Projects/Alpha')
  remote.control.ssh = { attached: true, hostId: 'host-a', name: 'fixture', target: 'example.invalid', modelCwd: '/srv/app', status: 'connected' }
  remote.control.remote = { alive: true, cwd: '/srv/app' }; remote.fireSsh(remote.control.ssh)
  assert.equal(remote.currentNotes().text, ''); assert.equal(remote.currentNotes().legacyText, 'LEGACY_SSH_FIXTURE')
  remote.applyTerminalNotes('REMOTE_APP', remote.currentNotes())
  remote.control.remote.cwd = '/srv/other'; remote.control.ssh.modelCwd = '/srv/other'; remote.fireSsh(remote.control.ssh)
  assert.equal(remote.environment.extraNotes, ''); remote.applyTerminalNotes('REMOTE_OTHER', remote.currentNotes())
  remote.control.remote.cwd = '/srv/app'; remote.control.ssh.modelCwd = '/srv/app'; remote.fireTerminal({ cwd: remote.control.cwd })
  assert.equal(remote.environment.extraNotes, 'REMOTE_APP')
  store.setDirectoryNote('ssh', 'host-b', '/srv/app', 'OTHER_HOST')
  assert.equal(store.getDirectoryNote('ssh', 'host-a', '/srv/app'), 'REMOTE_APP'); assert.equal(store.getDirectoryNote('ssh', 'host-a', '/srv/App'), null)
  remote.control.remote = null; remote.control.ssh.status = 'connecting'; remote.fireSsh(remote.control.ssh)
  assert.equal(remote.currentNotes().directoryKey, ''); assert.equal(remote.environment.extraNotes, '')
  assert.throws(() => remote.applyTerminalNotes('UNKNOWN_DIRECTORY', remote.currentNotes()), /尚未确定/)
  log('PASS SSH host/directory isolation, terminal/SSH cwd callbacks and unknown-directory protection')
  const app = path.join(root, 'src/renderer/src/App.tsx'), ast = ts.createSourceFile(app, fs.readFileSync(app, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const declaration = find(ast, node => ts.isVariableDeclaration(node) && node.name.getText(ast) === 'applyNotes')
  let draft = '', shown; const snapshot = { current: null }
  const apply = vm.runInNewContext('(' + compile(declaration.initializer.arguments[0].getText(ast)).replace(/;\s*$/, '') + ')', {
    terminalNotesOwnerKey: shared.terminalNotesOwnerKey, notesSnapshotRef: snapshot,
    setNotesDraft: callback => { draft = callback(draft) }, setNotes: value => { shown = value }, setNotesError() {}
  })
  const alpha = b.currentNotes(); apply(alpha); assert.equal(draft, 'ALPHA_ONLY')
  apply({ ...alpha, text: 'SHARED_UPDATE' }); assert.equal(draft, 'SHARED_UPDATE')
  draft = 'UNSAVED_DRAFT'; apply({ ...alpha, text: 'SECOND_SHARED_UPDATE' }); assert.equal(draft, 'UNSAVED_DRAFT')
  apply(c.currentNotes()); assert.equal(draft, 'BETA_ONLY'); assert.equal(shown.directoryKey, c.currentNotes().directoryKey)
  log('PASS actual editor callback switches directories, syncs clean editors and preserves unsaved typing during shared updates')
  store.close(); store = new ConversationStore(databaseFile)
  assert.equal(store.getDirectoryNote('local', 'machine-a', 'C:/Projects/Alpha'), 'ALPHA_ONLY')
  assert.equal(store.getDirectoryNote('local', 'machine-a', 'C:/Projects/Beta'), 'BETA_ONLY')
  assert.equal(store.getDirectoryNote('local', 'machine-a', 'C:/Projects/Alpha/child'), '')
  assert.equal(store.getDirectoryNote('ssh', 'host-a', '/srv/other'), 'REMOTE_OTHER'); assert.equal(store.getSshNote('host-a'), 'LEGACY_SSH_FIXTURE')
  store.removeSshHost('host-a'); assert.equal(store.getDirectoryNote('ssh', 'host-a', '/srv/app'), null)
  assert.equal(store.getDirectoryNote('ssh', 'host-b', '/srv/app'), 'OTHER_HOST')
  log('PASS SQLite reopen persistence and deleting only the removed host\'s directory notes')
  log('PASS all offline directory-note checks; live UI and shell behavior still require user testing')
} catch (error) { log(`FAIL ${error.stack || error}`); process.exitCode = 1 }
finally { store?.close() }
