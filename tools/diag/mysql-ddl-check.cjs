/** User-run offline checks. No Electron, database connection, app storage or network. */
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm')
const ts = require('typescript')
const root = path.resolve(__dirname, '../..')
const logDir = path.join(os.tmpdir(), 'gpt-login-diag')
fs.mkdirSync(logDir, { recursive: true })
const logFile = path.join(logDir, `mysql-ddl-check-${Date.now()}.log`)
const log = message => { fs.appendFileSync(logFile, message + '\n'); console.log(message) }
const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const find = (node, predicate) => predicate(node) ? node : ts.forEachChild(node, child => find(child, predicate))
function readAst(relative, kind = ts.ScriptKind.TS) {
  const filename = path.join(root, relative)
  return ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, kind)
}
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function main() {
  log(`Log: ${logFile}`)
  const runtimeAst = readAst('src/main/session-runtime.ts')
  const klass = runtimeAst.statements.find(node => ts.isClassDeclaration(node) && node.name.text === 'SessionRuntime')
  const methods = ['getMysqlTableDdl', 'queryMysqlTable', 'mysqlPasswordFor'].map(name => {
    const member = klass.members.find(node => node.name?.getText(runtimeAst) === name)
    assert.ok(member, `Missing runtime method: ${name}`)
    return member.getText(runtimeAst)
  })
  const errorFn = runtimeAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'mysqlErrorMessage')
  assert.ok(errorFn, 'Missing error formatter')
  const connections = [], scopeReads = []
  let response = { rows: [{ 'Create Table': 'CREATE TABLE `fixture` (\n  `id` int NOT NULL\n)' }] }
  const Runtime = vm.runInNewContext(compile(`${errorFn.getText(runtimeAst)}\nclass RuntimeFixture {\n${methods.join('\n')}\n}`) + '\nRuntimeFixture', {
    Date, Buffer,
    decryptSecret: value => value === 'FIXTURE_ENCRYPTED' ? 'FIXTURE_SAVED_PASSWORD' : '',
    createConnection: async options => {
      if (response.connectError) throw response.connectError
      const entry = { options, queries: [], ends: 0 }, selected = response
      connections.push(entry)
      return {
        query: async query => {
          entry.queries.push(query)
          if (query.sql.includes('INFORMATION_SCHEMA.COLUMNS')) {
            if (selected.commentsError) throw selected.commentsError
            return [selected.comments ?? [], []]
          }
          if (selected.queryError) throw selected.queryError
          return [selected.rows, selected.fields]
        },
        end: async () => { entry.ends++; if (selected.endError) throw selected.endError }
      }
    }
  })
  const runtime = new Runtime()
  runtime.environmentScope = { scope: 'local' }
  runtime.options = {
    localMachineId: 'fixture-machine',
    store: { listMysqlConnections(scope, machine) {
      scopeReads.push([scope, machine])
      return [{ id: 'fixture-connection', secret: 'FIXTURE_ENCRYPTED' }]
    } }
  }
  const draft = { id: 'fixture-connection', host: 'example.invalid', port: 3306, username: 'fixture', password: '' }
  const ddl = response.rows[0]['Create Table']
  let result = await runtime.getMysqlTableDdl(draft, 'fixture`db', 'fixture`; DROP TABLE other; --')
  assert.equal(result.ok, true); assert.equal(result.ddl, ddl)
  assert.equal(connections[0].queries[0].sql, 'SHOW CREATE TABLE `fixture``db`.`fixture``; DROP TABLE other; --`')
  assert.equal(connections[0].queries[0].timeout, 8000)
  assert.equal(connections[0].options.connectTimeout, 8000)
  assert.equal(connections[0].options.password, 'FIXTURE_SAVED_PASSWORD')
  assert.deepEqual(scopeReads[0], ['local', 'fixture-machine'])
  assert.equal(connections[0].ends, 1)
  log('PASS server DDL retained verbatim, identifiers escaped, query timeout and local saved password')

  runtime.environmentScope = { scope: 'ssh', hostId: 'fixture-host' }
  response = { rows: [{ 'Create View': 'CREATE VIEW `fixture_view` AS select 1 AS `id`' }] }
  result = await runtime.getMysqlTableDdl(draft, 'fixture_db', 'fixture_view')
  assert.equal(result.ok, true); assert.equal(result.ddl, response.rows[0]['Create View'])
  assert.deepEqual(scopeReads[1], ['ssh', 'fixture-host'])
  await runtime.getMysqlTableDdl({ ...draft, password: 'FIXTURE_TYPED_PASSWORD' }, 'fixture_db', 'fixture_view')
  assert.equal(connections.at(-1).options.password, 'FIXTURE_TYPED_PASSWORD')
  assert.equal(scopeReads.length, 2)
  log('PASS view definitions, SSH password scope and explicit password precedence')

  const count = connections.length
  for (const args of [[{ ...draft, host: '' }, 'fixture_db', 'fixture'], [draft, '', 'fixture'], [draft, 'fixture_db', ' ']]) {
    result = await runtime.getMysqlTableDdl(...args)
    assert.equal(result.ok, false); assert.equal(result.ddl, ''); assert.ok(result.message)
  }
  assert.equal(connections.length, count)
  for (const fixture of [
    { rows: [] }, { rows: [{ 'Create Table': '' }] },
    { queryError: { code: 'ER_TABLEACCESS_DENIED_ERROR', message: 'FIXTURE permission denied' } },
    { queryError: { code: 'PROTOCOL_SEQUENCE_TIMEOUT' } }
  ]) {
    response = fixture
    result = await runtime.getMysqlTableDdl(draft, 'fixture_db', 'fixture')
    assert.equal(result.ok, false); assert.equal(result.ddl, ''); assert.ok(result.message)
    assert.equal(connections.at(-1).ends, 1)
  }
  response = { connectError: { code: 'ECONNREFUSED' } }
  result = await runtime.getMysqlTableDdl(draft, 'fixture_db', 'fixture')
  assert.equal(result.ok, false); assert.ok(result.message.includes('拒绝连接'))
  response = { rows: [{ 'Create Table': ddl }], endError: new Error('FIXTURE end failed') }
  assert.equal((await runtime.getMysqlTableDdl(draft, 'fixture_db', 'fixture')).ok, true)
  log('PASS missing input, missing DDL, permission/connect/query failures and connection cleanup')

  const fields = ['device_name', 'id', 'note', '__proto__'].map(name => ({ name }))
  const comments = [
    { name: 'id', comment: 'ID comment' },
    { name: 'device_name', comment: 'Device comment\n<script>fixture</script>' },
    { name: '__proto__', comment: 'Ordinary column name' }
  ]
  response = {
    fields, comments,
    rows: Array.from({ length: 201 }, (_, id) => ({ id, device_name: 'fixture', note: null, ['__proto__']: 'field' }))
  }
  result = await runtime.queryMysqlTable(draft, 'fixture`db', ' fixture`; DROP TABLE other; --')
  const queryConnection = connections.at(-1)
  assert.equal(result.ok, true)
  assert.equal(result.sql, queryConnection.queries[0].sql)
  assert.equal(result.sql, 'SELECT * FROM `fixture``db`.` fixture``; DROP TABLE other; --` LIMIT 201')
  assert.equal(result.truncated, true); assert.equal(result.rows.length, 200)
  assert.deepEqual(JSON.parse(JSON.stringify(result.rows[0])), ['fixture', '0', null, 'field'])
  assert.deepEqual(JSON.parse(JSON.stringify(result.columnComments)), [comments[1].comment, comments[0].comment, '', comments[2].comment])
  assert.deepEqual(Array.from(queryConnection.queries[1].values), ['fixture`db', ' fixture`; DROP TABLE other; --'])
  assert.equal(queryConnection.queries[1].timeout, 8000)
  assert.equal(result.columnCommentsMessage, ''); assert.equal(queryConnection.ends, 1)
  const dateTimeRow = {
    last_connected_at: '2026-10-07 19:05:36.090',
    last_heartbeat_at: '2026-10-07 19:14:00.386123',
    timestamp_value: '2026-10-07 11:05:36.090',
    date_value: '2026-10-07',
    time_value: '-30:05:36.123456',
    zero_date: '0000-00-00 00:00:00.000',
    missing_time: null
  }
  response = { rows: [dateTimeRow], fields: Object.keys(dateTimeRow).map(name => ({ name })) }
  result = await runtime.queryMysqlTable(draft, 'fixture_db', 'fixture_dates')
  assert.equal(result.ok, true)
  assert.equal(connections.at(-1).options.dateStrings, true, 'The driver must return raw date/time strings instead of Date objects')
  assert.deepEqual(Array.from(result.rows[0]), Object.values(dateTimeRow), 'Dates, fractional seconds, zero dates and NULL must remain unchanged')
  assert.equal(connections.at(-1).ends, 1)
  log('PASS raw server date/time text retained without timezone conversion or precision loss')
  response = { rows: [], fields, comments }
  result = await runtime.queryMysqlTable(draft, 'fixture_db', 'fixture')
  assert.equal(result.ok, true); assert.equal(result.rows.length, 0); assert.equal(result.columns.length, 4)
  assert.equal(result.columnComments[0], comments[1].comment)
  response = { rows: [{ id: 1 }], fields: [{ name: 'id' }], commentsError: { code: 'ER_TABLEACCESS_DENIED_ERROR', message: 'FIXTURE metadata denied' } }
  result = await runtime.queryMysqlTable(draft, 'fixture_db', 'fixture')
  assert.equal(result.ok, true); assert.equal(result.rows[0][0], '1')
  assert.equal(result.columnComments[0], ''); assert.ok(result.columnCommentsMessage)
  assert.equal(connections.at(-1).ends, 1)
  response = { queryError: { code: 'ER_TABLEACCESS_DENIED_ERROR', message: 'FIXTURE rows denied' } }
  result = await runtime.queryMysqlTable(draft, 'fixture_db', 'fixture')
  assert.equal(result.ok, false); assert.ok(result.sql.startsWith('SELECT * FROM'))
  assert.equal(connections.at(-1).queries.length, 1); assert.equal(connections.at(-1).ends, 1)
  response = { connectError: { code: 'ECONNREFUSED' } }
  result = await runtime.queryMysqlTable(draft, 'fixture_db', 'fixture')
  assert.equal(result.ok, false); assert.equal(result.sql, '')
  log('PASS exact executed SQL, 200-row cap, comments matched by name, empty tables and non-fatal metadata failure')

  const uiAst = readAst('src/renderer/src/components/MysqlDialog.tsx', ts.ScriptKind.TSX)
  const pending = [], clipboard = []
  let tabs = [], activeKey = '', clipboardFails = false
  const context = vm.createContext({
    ddlRequestRef: { current: 0 },
    setTabs: update => { tabs = update(tabs) }, setActiveKey: key => { activeKey = key },
    window: { api: { getMysqlTableDdl: () => { const request = deferred(); pending.push(request); return request.promise } } },
    navigator: { clipboard: { writeText: async text => {
      if (clipboardFails) throw new Error('FIXTURE clipboard failed')
      clipboard.push(text)
    } } }
  })
  const draftFn = uiAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'draftFromForm')
  vm.runInContext(compile(draftFn.getText(uiAst)), context)
  for (const name of ['loadDdl', 'openDdlTab', 'copyDdl']) {
    const declaration = find(uiAst, node => ts.isVariableDeclaration(node) && node.name.getText(uiAst) === name)
    assert.ok(declaration, `Missing renderer callback: ${name}`)
    context[name] = vm.runInContext(compile(`(${declaration.initializer.arguments[0].getText(uiAst)})`), context)
  }
  const form = { ...draft, name: 'fixture', database: 'fixture_db', port: '3306' }
  const first = context.openDdlTab('fixture-connection', form, 'fixture')
  const newer = context.openDdlTab('fixture-connection', form, 'fixture')
  assert.equal(tabs.length, 1); assert.equal(activeKey, tabs[0].key); assert.equal(tabs[0].loading, true)
  pending[1].resolve({ ok: true, ddl: 'NEWER DDL', message: '' }); await newer
  pending[0].resolve({ ok: true, ddl: 'STALE DDL', message: '' }); await first
  assert.equal(tabs[0].data.ddl, 'NEWER DDL'); assert.equal(tabs[0].loading, false)
  const closing = context.openDdlTab('fixture-connection', form, 'fixture')
  tabs = []
  const reopened = context.openDdlTab('fixture-connection', form, 'fixture')
  pending[2].resolve({ ok: true, ddl: 'CLOSED TAB DDL', message: '' }); await closing
  assert.equal(tabs[0].data, null); assert.equal(tabs[0].loading, true)
  pending[3].resolve({ ok: true, ddl, message: '' }); await reopened
  await context.copyDdl(tabs[0]); assert.equal(clipboard[0], ddl); assert.equal(tabs[0].copied, true)
  clipboardFails = true
  await context.copyDdl(tabs[0]); assert.equal(tabs[0].copied, false); assert.ok(tabs[0].copyError)
  assert.equal(tabs[0].data.ddl, ddl)
  const failed = context.openDdlTab('fixture-connection', form, 'fixture')
  pending[4].reject(new Error('FIXTURE IPC failed')); await failed
  assert.equal(tabs[0].loading, false); assert.equal(tabs[0].data.ok, false); assert.ok(tabs[0].error)
  await context.copyDdl(tabs[0]); assert.equal(clipboard.length, 1)
  log('PASS tab reuse, stale refresh/closed-tab responses, exact copy, clipboard failure and IPC failure')
  log('PASS all offline MySQL table/DDL checks; live MySQL and UI behavior still require user testing')
}
main().catch(error => { log(`FAIL ${error.stack || error}`); process.exitCode = 1 })
