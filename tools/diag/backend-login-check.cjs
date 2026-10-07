/** User-run offline checks. No Electron, real app storage, mail or network. */
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm')
const ts = require('typescript')
const root = path.resolve(__dirname, '../..')
const directory = path.join(os.tmpdir(), 'gpt-login-diag')
fs.mkdirSync(directory, { recursive: true })
const logFile = path.join(directory, `backend-login-check-${Date.now()}-${process.pid}.log`)
const log = text => { fs.appendFileSync(logFile, text + '\n'); console.log(text) }
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
function load(relative) {
  const module = { exports: {} }
  const source = fs.readFileSync(path.join(root, relative), 'utf8')
  vm.runInNewContext(compile(source), {
    module, exports: module.exports, Buffer, URL, Date, AbortSignal,
    fetch: () => { throw new Error('Real network forbidden by this diagnostic') },
    require(name) {
      if (name === '../shared/backend-url') return load('src/shared/backend-url.ts')
      if (['node:fs', 'node:os', 'node:path', 'node:crypto'].includes(name)) return require(name)
      throw new Error(`Unexpected dependency: ${name}`)
    }
  }, { filename: relative })
  return module.exports
}
const ast = relative => ts.createSourceFile(relative, fs.readFileSync(path.join(root, relative), 'utf8'), ts.ScriptTarget.Latest, true)
const find = (node, predicate) => predicate(node) ? node : ts.forEachChild(node, child => find(child, predicate))
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }

async function main() {
  log(`Log: ${logFile}`)
  assert.equal(typeof Response, 'function', 'Use a Node version with the built-in fetch/Response APIs')
  const { BackendAuthService } = load('src/main/backend-auth.ts')
  const values = new Map([['backendUrl', 'https://old.example.invalid']])
  const calls = [], records = [], savedUrls = []
  let time = Date.parse('2026-10-07T12:00:00Z'), storageFailure = false, encryptionFailure = false
  const fixtureToken = 'FIXTURE_TOKEN_NOT_A_REAL_CREDENTIAL'
  const draft = { backendUrl: 'https://example.invalid/backend/', email: 'fixture@example.invalid', code: '001234' }
  const goodBody = () => ({ accessToken: fixtureToken, tokenType: 'Bearer', expiresInSeconds: 3600, user: { publicId: 'usr_fixture', email: draft.email, nickname: 'Fixture', avatarUrl: null, role: 'USER' } })
  let response = () => new Response(JSON.stringify(goodBody()), { status: 200 })
  const store = {
    getSetting: key => values.get(key) ?? null,
    setSettings(next) {
      if (storageFailure) throw new Error('FIXTURE_STORAGE_FAILURE')
      for (const [key, value] of Object.entries(next)) values.set(key, value)
    }
  }
  const dependencies = {
    request: async (url, options) => { calls.push({ url, options }); return response() },
    now: () => time,
    encrypt(text) { if (encryptionFailure) throw new Error('FIXTURE_ENCRYPTION_FAILURE'); return Buffer.from(text).toString('base64') },
    decrypt: text => Buffer.from(text, 'base64').toString('utf8'),
    onBackendUrlSaved: url => savedUrls.push(url),
    log: { path: 'FIXTURE_LOG_PATH', write: record => records.push(record) }
  }
  const service = new BackendAuthService(store, dependencies)
  assert.equal(service.getState().status, 'signed-out')
  response = () => new Response(null, { status: 204 })
  let result = await service.sendCode(draft)
  assert.equal(result.ok, true)
  assert.equal(calls[0].url, 'https://example.invalid/backend/api/user/login/code')
  assert.equal(calls[0].options.method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].options.body), { email: draft.email })
  assert.equal(calls[0].options.redirect, 'manual')
  assert.ok(calls[0].options.signal)
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json')
  assert.equal(calls[0].options.headers.Cookie, undefined)
  assert.equal(values.get('backendUrl'), 'https://old.example.invalid')
  log('PASS send-code endpoint/context path/JSON, 204 body, no cookies, no redirect following, timeout signal, no premature save')

  response = () => new Response(JSON.stringify(goodBody()), { status: 200 })
  result = await service.login(draft)
  assert.equal(result.ok, true)
  assert.equal(calls.at(-1).url, 'https://example.invalid/backend/api/user/login')
  assert.equal(JSON.parse(calls.at(-1).options.body).code, '001234')
  assert.equal(values.get('backendUrl'), draft.backendUrl)
  assert.ok(!values.get('backendAuth').includes(fixtureToken))
  assert.equal(JSON.parse(dependencies.decrypt(values.get('backendAuth'))).accessToken, fixtureToken)
  assert.equal(result.value.status, 'signed-in')
  assert.ok(!JSON.stringify(result).includes(fixtureToken))
  assert.equal(savedUrls.at(-1), draft.backendUrl)
  const restored = new BackendAuthService(store, dependencies)
  assert.equal(restored.getState().status, 'signed-in')
  assert.equal(restored.getState().user.publicId, 'usr_fixture')
  time += 3600 * 1000
  assert.equal(restored.getState().status, 'expired')
  time -= 3600 * 1000
  const previousSecret = values.get('backendAuth')
  log('PASS leading-zero login code, encrypted credential persistence, public account state without token, reload and expiry')

  for (const [status, code, expected] of [
    [401, 'LOGIN_CODE_INCORRECT', '验证码错误或已过期'],
    [403, 'USER_DISABLED', '账号已被禁用'],
    [401, 'USER_NOT_AVAILABLE', '用户不存在'],
    [400, 'INVALID_EMAIL', '邮箱格式不正确'],
    [400, 'INVALID_LOGIN_CODE', '验证码必须是'],
    [429, 'LOGIN_CODE_TOO_FREQUENT', '发送过于频繁'],
    [500, 'LOGIN_CODE_SEND_FAILED', '邮件发送失败'],
    [404, 'UNTRUSTED_CODE', '登录接口不存在']
  ]) {
    response = () => new Response(JSON.stringify({ code, message: fixtureToken + draft.code + draft.email }), { status, headers: { 'Retry-After': '90' } })
    result = await service.login(draft)
    assert.equal(result.ok, false)
    assert.ok(result.message.includes(expected))
    assert.ok(!JSON.stringify(result).includes(fixtureToken))
    assert.equal(values.get('backendAuth'), previousSecret)
    if (status === 429) assert.equal(result.retryAfterSeconds, 90)
  }
  let count = calls.length
  for (const invalid of [{ ...draft, code: '12345' }, { ...draft, email: 'invalid' }, { ...draft, backendUrl: 'file:///fixture' }]) {
    assert.equal((await service.login(invalid)).ok, false)
  }
  assert.equal(calls.length, count)
  log('PASS documented error feedback and Retry-After, no raw backend message leakage, old login preserved, local validation before requests')

  for (const bad of [{ ...goodBody(), expiresInSeconds: 0 }, { ...goodBody(), tokenType: 'Other' }, { ...goodBody(), user: null }, { ...goodBody(), user: { ...goodBody().user, email: 'other@example.invalid' } }]) {
    response = () => new Response(JSON.stringify(bad), { status: 200 })
    assert.equal((await service.login(draft)).ok, false)
    assert.equal(values.get('backendAuth'), previousSecret)
  }
  for (const payload of ['not-json', 'x'.repeat(64 * 1024 + 1)]) {
    response = () => new Response(payload, { status: 200 })
    assert.equal((await service.login(draft)).ok, false)
  }
  response = () => new Response(null, { status: 302, headers: { Location: 'https://other.example.invalid' } })
  count = calls.length
  assert.equal((await service.login(draft)).ok, false)
  assert.equal(calls.length, count + 1)
  for (const [error, expected] of [
    [Object.assign(new Error('PRIVATE_FIXTURE_ERROR'), { name: 'TimeoutError' }), '请求超时'],
    [Object.assign(new Error('PRIVATE_FIXTURE_ERROR'), { cause: { code: 'ECONNREFUSED' } }), '拒绝连接'],
    [Object.assign(new Error('PRIVATE_FIXTURE_ERROR'), { cause: { code: 'ENOTFOUND' } }), '无法解析'],
    [Object.assign(new Error('PRIVATE_FIXTURE_ERROR'), { cause: { code: 'CERT_HAS_EXPIRED' } }), '证书校验失败']
  ]) {
    response = () => { throw error }
    result = await service.login(draft)
    assert.equal(result.ok, false)
    assert.ok(result.message.includes(expected))
    assert.ok(!result.message.includes('PRIVATE_FIXTURE_ERROR'))
  }
  response = () => new Response(JSON.stringify(goodBody()), { status: 200 })
  storageFailure = true
  assert.equal((await service.login(draft)).ok, false)
  storageFailure = false
  encryptionFailure = true
  assert.equal((await service.login(draft)).ok, false)
  encryptionFailure = false
  assert.equal(values.get('backendAuth'), previousSecret)
  log('PASS invalid/mismatched/oversized responses, redirects, classified network failures, encryption/storage failures preserve old login')

  const pending = deferred()
  response = () => pending.promise
  const inFlight = service.login(draft)
  count = calls.length
  assert.equal((await service.sendCode(draft)).ok, false)
  assert.equal(calls.length, count)
  service.setBackendUrl('https://new.example.invalid')
  assert.equal(values.get('backendAuth'), '')
  pending.resolve(new Response(JSON.stringify(goodBody()), { status: 200 }))
  result = await inFlight
  assert.equal(result.ok, false)
  assert.equal(values.get('backendUrl'), 'https://new.example.invalid')
  assert.equal(values.get('backendAuth'), '')
  log('PASS duplicate request guard, server-change invalidation and stale response rejection')

  const dbAst = ast('src/main/db.ts')
  const method = find(dbAst, node => ts.isMethodDeclaration(node) && node.name.getText(dbAst) === 'setSettings')
  assert.ok(method)
  const StoreFixture = vm.runInNewContext(compile(`class Fixture { ${method.getText(dbAst)} }`) + '\nFixture')
  const fixture = new StoreFixture(), transaction = new Map([['backendUrl', 'old'], ['backendAuth', 'old-secret']])
  let backup
  fixture.db = { exec(sql) { if (sql === 'BEGIN IMMEDIATE') backup = new Map(transaction); if (sql === 'ROLLBACK') { transaction.clear(); for (const item of backup) transaction.set(...item) } } }
  fixture.setSetting = (key, value) => { if (key === 'backendAuth') throw new Error('FIXTURE_SECOND_WRITE_FAILURE'); transaction.set(key, value) }
  assert.throws(() => fixture.setSettings({ backendUrl: 'new', backendAuth: 'new-secret' }))
  assert.equal(transaction.get('backendUrl'), 'old')
  assert.equal(transaction.get('backendAuth'), 'old-secret')
  log('PASS actual store transaction rolls back an address write when the credential write fails')

  const mainAst = ast('src/main/index.ts')
  const guard = find(mainAst, node => ts.isVariableDeclaration(node) && node.name.getText(mainAst) === 'canUseBackendAuth')
  const handler = channel => find(mainAst, node => ts.isCallExpression(node) && node.expression.getText(mainAst) === 'ipcMain.handle' && node.arguments[0]?.getText(mainAst) === `IpcChannels.${channel}`).arguments[1].getText(mainAst)
  const managerGuard = find(mainAst, node => ts.isFunctionDeclaration(node) && node.name?.text === 'isManagerEvent')
  const webContents = { mainFrame: {} }
  const bridge = vm.runInNewContext(compile(`${managerGuard.getText(mainAst)}\nconst canUseBackendAuth = ${guard.initializer.getText(mainAst)}; const handlers = { get: ${handler('backendAuthGet')}, send: ${handler('backendLoginCode')}, login: ${handler('backendLogin')} };`) + '\nhandlers', { managerWindow: { isDestroyed: () => false, webContents }, backendAuth: service })
  count = calls.length
  for (const event of [{ sender: {}, senderFrame: webContents.mainFrame }, { sender: webContents, senderFrame: {} }]) {
    assert.equal((await bridge.login(event, draft)).ok, false)
    assert.equal((await bridge.send(event, draft)).ok, false)
    assert.equal(bridge.get(event).user, null)
  }
  assert.equal(calls.length, count)
  assert.equal(bridge.get({ sender: webContents, senderFrame: webContents.mainFrame }).backendUrl, 'https://new.example.invalid')
  log('PASS actual IPC handlers reject other webContents/subframes before requests or account reads')

  const metadata = JSON.stringify(records)
  for (const secret of [fixtureToken, draft.email, draft.code, 'PRIVATE_FIXTURE_ERROR']) assert.ok(!metadata.includes(secret))
  log('PASS diagnostic records contain no email, verification code, token, response body or raw transport error')
  log('ALL OFFLINE CHECKS PASSED. User-driven app/login acceptance is still required.')
}

main().catch(error => { log('FAIL ' + (error.stack || String(error))); process.exitCode = 1 })
