/** User-run offline checks. No Electron, real SSH connection, shell or network. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

const root = path.resolve(__dirname, '../..')
const logDir = path.join(os.tmpdir(), 'gpt-login-diag')
fs.mkdirSync(logDir, { recursive: true })
const logFile = path.join(logDir, `ssh-files-directory-check-${Date.now()}.log`)
const log = text => { fs.appendFileSync(logFile, text + '\n'); console.log(text) }
const plain = value => JSON.parse(JSON.stringify(value))
const flush = () => new Promise(resolve => setImmediate(resolve))
const source = ts.createSourceFile('App.tsx', fs.readFileSync(path.join(root, 'src/renderer/src/App.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function find(node, predicate) {
  if (predicate(node)) return node
  return ts.forEachChild(node, child => find(child, predicate))
}
function declaration(name) {
  const node = find(source, value => ts.isVariableDeclaration(value) && value.name.getText(source) === name)
  assert.ok(node, `Missing renderer declaration ${name}`)
  return node.initializer
}
function evaluate(text, context) {
  return vm.runInContext(ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }).outputText, context)
}
const reads = []
const context = vm.createContext({ Error, Date, Promise, Map,
  ssh: { hostId: 'fixture-host', status: 'connected', ptyCwd: '/srv/current', modelCwd: '/root/model' },
  sshFilesOpen: false, sshFilesLocation: { hostId: '', path: '/' }, sshFilePath: '/',
  sshFilesLoading: false, sshDirectoryLoading: false, sshFilesError: '', sshFileSearch: '',
  sshFileData: [], sshCurrentFiles: [], sshFilemanagerApiRef: { current: null },
  sshFilePathDraft: null, sshFileModeRef: { current: 'table' },
  window: { api: {
    listSshFiles(directory) {
      return new Promise((resolve, reject) => reads.push({ directory, resolve, reject }))
    },
    downloadSshFile() { throw new Error('Downloading is forbidden in this check') }
  } }
})
for (const name of ['SshFilesOpen', 'SshFilesLocation', 'SshFilePath', 'SshFilePathDraft', 'SshFilesLoading', 'SshDirectoryLoading', 'SshFilesError', 'SshFileSearch', 'SshFileData', 'SshCurrentFiles']) {
  const state = name[0].toLowerCase() + name.slice(1)
  context[`set${name}`] = value => { context[state] = value }
}
for (const name of ['toFilemanagerEntities', 'toSshFilemanagerData', 'normalizeSshDirectory', 'sshDirectoryBreadcrumbs']) {
  const node = find(source, value => ts.isFunctionDeclaration(value) && value.name?.text === name)
  assert.ok(node, `Missing data helper ${name}`)
  evaluate(node.getText(source), context)
}
const callback = name => evaluate(`(${declaration(name).arguments[0].getText(source)})`, context)
context.navigateSshFiles = callback('navigateSshFiles')
function jsxHandler(node, name) {
  const attribute = node.attributes.properties.find(value => ts.isJsxAttribute(value) && value.name.getText(source) === name)
  assert.ok(attribute?.initializer?.expression, `Missing JSX handler ${name}`)
  return evaluate(`(${attribute.initializer.expression.getText(source)})`, context)
}
const effectNode = find(source, value => ts.isCallExpression(value) && value.expression.getText(source) === 'useEffect' && value.arguments[0]?.getText(source).includes('listSshFiles('))
assert.ok(effectNode, 'Missing SSH file loading effect')
const loadFiles = evaluate(`(${effectNode.arguments[0].getText(source)})`, context)
function nextRead(directory) {
  const index = reads.findIndex(read => read.directory === directory)
  assert.notEqual(index, -1, `No pending read for ${directory}`)
  return reads.splice(index, 1)[0]
}
const entry = (id, type = 'file') => ({ id, name: id.split('/').pop(), type, size: 10, modifiedAt: 1000 })

async function main() {
  log(`Log: ${logFile}`)
  callback('toggleSshFiles')()
  assert.equal(context.sshFilePath, '/srv/current')
  assert.equal(context.sshFilesOpen, true)
  assert.equal(context.sshFilesLoading, true)
  assert.deepEqual(plain(context.sshFilesLocation), { hostId: 'fixture-host', path: '/srv/current' })
  callback('toggleSshFiles')()
  context.ssh.ptyCwd = '/srv/next/'
  callback('toggleSshFiles')()
  assert.equal(context.sshFilePath, '/srv/next')
  callback('toggleSshFiles')()
  context.ssh.ptyCwd = ''
  callback('toggleSshFiles')()
  assert.equal(context.sshFilePath, '/root/model')
  callback('toggleSshFiles')()
  context.ssh.status = 'disconnected'
  callback('toggleSshFiles')()
  assert.equal(context.sshFilesOpen, false)
  assert.equal(reads.length, 0)
  log('PASS terminal cwd priority, model cwd fallback, reopen and disconnected controls')

  context.ssh.status = 'connected'
  context.ssh.ptyCwd = '/srv/current'
  callback('toggleSshFiles')()
  context.sshFilesStartPath = evaluate(`(${declaration('sshFilesStartPath').getText(source)})`, context)
  let cleanup = loadFiles()
  const initial = [entry('/srv/current/README.md'), entry('/srv/current/src', 'folder'), entry('/srv/current/docs', 'folder')]
  nextRead('/srv/current').resolve(initial)
  await flush()
  assert.deepEqual(plain(context.sshCurrentFiles), initial)
  assert.equal(context.sshFilesLoading, false)

  const { DataStore } = await import('@svar-ui/filemanager-store')
  const store = new DataStore()
  const dataFor = (files, directory) => context.toSshFilemanagerData(files, directory)
  for (const directory of ['/', '/empty', '/srv/project with spaces/中文']) {
    store.init({ data: dataFor([], directory), panels: [{ path: directory }, { path: directory }], activePanel: 0, mode: 'table' })
    assert.equal(store.getState().panels[0].path, directory)
    assert.equal(store.getState().panels[0]._files.length, 0)
    assert.equal(store.getState().panels[0]._crumbs.at(-1).id, directory)
  }
  store.init({ data: dataFor(initial, '/srv/current'), panels: [{ path: '/srv/current' }, { path: '/srv/current' }], activePanel: 0, mode: 'table' })
  assert.deepEqual(Array.from(store.getState().panels[0]._crumbs, item => item.id), ['/', '/srv', '/srv/current'])
  assert.equal(store.getState().panels[0]._files.length, initial.length)
  log('PASS initial directory listing, absolute ancestor tree, empty/root/Unicode paths')

  const apiFor = target => ({ on: target.in.on.bind(target.in), exec: target.in.exec.bind(target.in), getState: target.getState.bind(target), getFile: target.getFile.bind(target) })
  const api = apiFor(store)
  callback('initSshFilemanager')(api)
  await api.exec('set-path', { id: '/srv/current/src' })
  await flush()
  assert.equal(reads.filter(read => read.directory === '/srv/current/src').length, 1)
  nextRead('/srv/current/src').resolve([entry('/srv/current/src/main.ts')])
  await flush()
  assert.equal(context.sshCurrentFiles[0].id, '/srv/current/src/main.ts')
  assert.equal(store.getState().panels[0]._files[0].id, '/srv/current/src/main.ts')
  assert.equal(context.sshDirectoryLoading, false)
  callback('refreshSshFiles')()
  assert.equal(context.sshFilesLocation.path, '/srv/current/src')
  log('PASS child navigation, shared lazy-load request, synchronized views and refresh target')

  const rootButton = find(source, value => ts.isJsxOpeningElement(value) && value.tagName.getText(source) === 'button' && value.attributes.properties.some(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(source) === 'aria-label' && attribute.initializer?.text === '返回根目录'))
  assert.ok(rootButton, 'Missing clickable root navigation button')
  jsxHandler(rootButton, 'onClick')()
  await flush()
  nextRead('/').resolve([entry('/srv', 'folder'), entry('/tmp', 'folder')])
  await flush()
  assert.equal(context.sshFilePath, '/')
  assert.equal(context.sshCurrentFiles[1].id, '/tmp')
  context.navigateSshFiles('/srv')
  await flush()
  nextRead('/srv').resolve([entry('/srv/current', 'folder'), entry('/srv/other', 'folder')])
  await flush()
  assert.equal(context.sshFilePath, '/srv')
  context.navigateSshFiles('/srv/current')
  await flush()
  nextRead('/srv/current').resolve(initial)
  await flush()
  assert.equal(context.sshFilePath, '/srv/current')
  assert.deepEqual(plain(context.sshDirectoryBreadcrumbs('/home/fixture')), [
    { name: 'home', path: '/home' }, { name: 'fixture', path: '/home/fixture' }
  ])
  assert.deepEqual(plain(context.sshDirectoryBreadcrumbs('/')), [])
  log('PASS actual root button handler, ancestor navigation and complete directory breadcrumbs')

  await api.exec('set-path', { id: '/srv/current/src' })
  await api.exec('set-path', { id: '/srv/current/docs' })
  await flush()
  const older = nextRead('/srv/current/src')
  nextRead('/srv/current/docs').resolve([entry('/srv/current/docs/guide.md')])
  await flush()
  older.resolve([entry('/srv/current/src/late.ts')])
  await flush()
  assert.equal(context.sshFilePath, '/srv/current/docs')
  assert.equal(context.sshCurrentFiles[0].id, '/srv/current/docs/guide.md')
  assert.equal(context.sshDirectoryLoading, false)
  await api.exec('set-path', { id: '/srv/current/src' })
  await flush()
  context.sshFilemanagerApiRef.current = null
  nextRead('/srv/current/src').reject(new Error('STALE_FIXTURE_ERROR'))
  await flush()
  assert.equal(context.sshFilesError, '')
  log('PASS out-of-order navigation and responses from a closed filemanager')

  context.sshFilePathDraft = 'relative/path'
  let submitted = false
  callback('submitSshFilePath')({ preventDefault() { submitted = true } })
  assert.equal(submitted, true)
  assert.equal(context.sshFilePathDraft, 'relative/path')
  assert.match(context.sshFilesError, /绝对目录/)
  context.sshFilePathDraft = ' /opt//project with spaces/./child/../ '
  callback('submitSshFilePath')({ preventDefault() {} })
  assert.equal(context.sshFilesLocation.path, '/opt/project with spaces')
  assert.equal(context.sshFilePathDraft, null)
  assert.equal(context.sshFilesError, '')
  assert.equal(context.normalizeSshDirectory('/../../'), '/')
  context.sshFilemanagerApiRef.current = api
  context.sshFilePathDraft = '/srv/current/README.md'
  context.navigateSshFiles(context.sshFilePathDraft)
  assert.match(context.sshFilesError, /该地址是文件/)
  assert.equal(context.sshFilePathDraft, '/srv/current/README.md')
  const input = find(source, value => ts.isJsxSelfClosingElement(value) && value.tagName.getText(source) === 'input' && value.attributes.properties.some(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(source) === 'className' && attribute.initializer?.text === 'ssh-files__path-input'))
  assert.ok(input, 'Missing editable directory address input')
  let stopped = false, prevented = false
  jsxHandler(input, 'onKeyDown')({ key: 'Escape', preventDefault() { prevented = true }, stopPropagation() { stopped = true } })
  assert.equal(stopped && prevented, true)
  assert.equal(context.sshFilePathDraft, null)
  assert.equal(context.sshFilesOpen, true)
  prevented = false
  jsxHandler(input, 'onKeyDown')({ key: 'Enter', nativeEvent: { isComposing: true }, preventDefault() { prevented = true } })
  assert.equal(prevented, true)
  const nextStore = new DataStore()
  nextStore.init({ data: dataFor(initial, '/srv/current'), panels: [{ path: '/srv/current' }, { path: '/srv/current' }], activePanel: 0, mode: 'table' })
  context.sshFileModeRef.current = 'cards'
  callback('initSshFilemanager')(apiFor(nextStore))
  await flush()
  assert.equal(nextStore.getState().mode, 'cards')
  log('PASS typed directories, normalized paths, invalid targets, Escape/IME input and retained view mode')

  cleanup()
  context.sshFilesStartPath = '/srv/old'
  cleanup = loadFiles()
  const oldOpen = nextRead('/srv/old')
  cleanup()
  context.sshFilesStartPath = '/srv/new'
  cleanup = loadFiles()
  nextRead('/srv/new').resolve([entry('/srv/new/new.txt')])
  await flush()
  oldOpen.resolve([entry('/srv/old/old.txt')])
  await flush()
  assert.equal(context.sshFilePath, '/srv/new')
  assert.equal(context.sshCurrentFiles[0].id, '/srv/new/new.txt')
  cleanup()
  context.sshFilesStartPath = '/srv/unreadable'
  cleanup = loadFiles()
  assert.equal(context.sshCurrentFiles.length, 0)
  nextRead('/srv/unreadable').reject(new Error('FIXTURE_DIRECTORY_UNREADABLE'))
  await flush()
  assert.equal(context.sshFilesError, 'FIXTURE_DIRECTORY_UNREADABLE')
  assert.equal(context.sshFilesLoading, false)
  assert.equal(context.sshCurrentFiles.length, 0)
  cleanup()
  context.sshFilesOpen = false
  loadFiles()()
  assert.equal(context.sshFileData.length, 0)
  assert.equal(reads.length, 0)
  log('PASS cancelled opens, read errors and closed-window cleanup')
  log('PASS all offline SSH file directory checks; live UI and SSH remain unverified')
}
main().catch(error => { log(`FAIL ${error.stack || error}`); process.exitCode = 1 })
