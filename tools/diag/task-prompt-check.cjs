/** User-run offline regressions. No Electron, real browser, cookies or network access. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

const logDir = path.join(os.tmpdir(), 'gpt-login-diag')
fs.mkdirSync(logDir, { recursive: true })
const logFile = path.join(logDir, `task-prompt-check-${Date.now()}.log`)
const log = text => { fs.appendFileSync(logFile, text + '\n'); console.log(text) }
const root = path.resolve(__dirname, '../..')
const source = fs.readFileSync(path.join(root, 'src/main/injected/send-interceptor.js'), 'utf8')

function section(start, end) {
  const at = source.indexOf(start)
  const until = source.indexOf(end, at + start.length)
  assert.ok(at >= 0 && until > at, `Missing source section: ${start}`)
  return source.slice(at, until)
}

function page(kind = 'contenteditable', snapshot = {}) {
  let now = 1000
  let timerSerial = 0
  let imageSerial = 0
  let replySerial = 0
  const timers = []
  const events = []
  const submissions = []
  const buttonClicks = []
  const composer = {
    tagName: kind === 'textarea' ? 'TEXTAREA' : 'DIV', text: '',
    contains(node) { return node === this },
    closest(selector) { return selector.includes('textarea') || selector.includes('contenteditable') ? this : null }
  }
  const listeners = new Map()
  const button = { disabled: false }
  const controls = { accept: true, write: true, image: false, attachment: false, generating: false, writes: 0, selector: true, composerFound: true, replyId: 'old-reply', reply: '' }
  const context = {
    Date: class extends Date { static now() { return now } },
    setTimeout: (run, delay) => { const id = ++timerSerial; timers.push({ id, run, at: now + delay }); return id },
    clearTimeout: id => { const at = timers.findIndex(timer => timer.id === id); if (at >= 0) timers.splice(at, 1) },
    getComposer: () => controls.composerFound ? composer : null,
    document: { addEventListener: (type, listener) => listeners.set(type, listener) },
    readComposer: element => element ? element.text : '',
    collapse: text => String(text || '').replace(/\s+/g, ' ').trim(),
    insertText: (element, text) => { controls.writes++; if (!controls.write) return false; element.text = text; return true },
    hasDraftImageAttachment: () => controls.image,
    beginUserImageCapture: () => `capture-${++imageSerial}`,
    discardUserImageCapture: () => {},
    findSendButton: () => controls.selector ? button : null,
    findStopButton: () => controls.generating ? button : null,
    controlDisabled: node => node.disabled === true,
    lastAssistantId: () => controls.replyId,
    scheduleScrollToBottom: () => {},
    diagnoseSendFailure: () => ({}),
    RECOVERY_ACTIONS: [],
    report: event => events.push(event),
    fileSend: null,
    settleTimer: null,
    queryAllAssistant: () => controls.reply ? [{ tagName: 'DIV', className: '' }] : [],
    isAssistantTurn: () => true,
    turnKeyOf: () => controls.replyId,
    readReplyText: () => controls.reply,
    readReplyMarkdown: () => controls.reply,
    looksLikeReadFilesReply: () => false,
    looksLikeQuestionReply: text => text.includes('"type":"questions"'),
    extractQuestion: text => JSON.parse(text),
    extractCommand: text => { try { const parsed = JSON.parse(text); return parsed.command ? parsed : null } catch { return null } },
    looksLikeCommandReply: () => false,
    balancedObjects: () => [],
    noteScan: () => {},
    scheduleRenderedAssistantHistory: () => {},
    clickPrimaryWhileWaiting: () => null,
    toolbarSnapshot: () => ({}),
    describeControl: () => ({}),
    normalizeLineEndings: text => text.replace(/\r\n/g, '\n'),
    attachmentSnapshot: () => ({ rootFound: true, cards: controls.attachment ? 1 : 0, inputFiles: 0, images: 0, uploading: false }),
    draftAttachmentEvidence: () => controls.image || controls.attachment,
    composerMatches: (element, text) => element.text === text,
    window: {},
    STATE_KEY: '__cmdTerminalInterceptor'
  }
  const event = () => ({ preventDefault() {}, stopImmediatePropagation() {} })
  const submit = () => {
    // Exercise our synthetic-event guard, rather than bypassing the interception path.
    assert.equal(context.api.intercept(event()), false, 'Synthetic submit must not be intercepted again')
    submissions.push(composer.text)
    if (controls.accept) { composer.text = ''; controls.image = false; controls.replyId = `new-reply-${++replySerial}` }
  }
  context.pressButton = target => { buttonClicks.push(target); submit() }
  context.pressEnter = submit
  vm.createContext(context)
  const publicStart = source.indexOf('    configure(config) {')
  const rawStart = source.indexOf('    sendRaw(text, ownedDraft = null) {', publicStart)
  const rawComment = source.lastIndexOf('    /**', rawStart)
  const answerStart = source.indexOf('    async answerQuestion(', rawStart)
  const answerEnd = source.indexOf('    takeUserImageAttachments,', answerStart)
  assert.ok(publicStart > 0 && rawComment > publicStart && answerStart > rawStart && answerEnd > answerStart)
  vm.runInContext([
    section('  let PAGE =', '  // Re-injection'),
    section('  const state =', '  /** User-image batches'),
    section('  const hasPrefix =', '  const selectAllIn ='),
    section('  const submitWithRetry =', '  const pressButton ='),
    section('  const USER_TEXT_SENTINEL =', '  // Capture phase, on'),
    section('  const checkForCommand =', '  const lastAssistantId ='),
    section('  const armBaseline =', '  // Block ChatGPT sidebar'),
    `const lifecycle = { ${source.slice(publicStart, rawComment)} ${source.slice(rawStart, answerEnd)} };`,
    'window[STATE_KEY] = lifecycle;',
    'globalThis.api = { state, intercept, lifecycle, checkForCommand, armBaseline, USER_TEXT_SENTINEL };'
  ].join('\n'), context)
  vm.runInContext(section('  // Capture phase, on', '  /* ------------------------------------------------------------------ *'), context)
  context.api.lifecycle.configure({ enabled: true, prefix: '【角色】终端助手\n\n', taskPromptGeneration: 0, taskPromptInjected: false, ...snapshot })
  const flush = () => {
    let steps = 0
    while (timers.length) {
      assert.ok(++steps < 2000, 'Unexpected unbounded timer loop')
      timers.sort((a, b) => a.at - b.at || a.id - b.id)
      const timer = timers.shift()
      now = timer.at
      timer.run()
    }
  }
  const send = text => { composer.text = text; assert.equal(context.api.intercept(event()), true); flush() }
  const reply = text => { controls.reply = text; controls.replyId += '-reply'; context.api.checkForCommand(); flush() }
  return {
    ...context.api, composer, controls, events, submissions, buttonClicks, send, reply, flush, event,
    useControlLookup: lookup => {
      context.findSendButton = lookup.send
      context.findStopButton = lookup.stop
      context.controlDisabled = lookup.disabled
    },
    keyDown: (flags = {}) => {
      const input = {
        key: 'Enter', type: 'keydown', isTrusted: true, target: composer,
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true }, stopImmediatePropagation() {},
        ...flags
      }
      listeners.get('keydown')(input)
      return input
    },
    evaluate: script => vm.runInContext(script, context),
    onReport: listener => { context.report = event => { events.push(event); listener(event) } }
  }
}

function rawSendLogFixture(relativePath = 'src/main/raw-send-log.ts') {
  const exports = {}
  const writes = []
  const code = ts.transpileModule(fs.readFileSync(path.join(root, relativePath), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const fakeFs = {
    mkdirSync() {},
    appendFileSync(file, value) { writes.push({ file, value }) }
  }
  vm.runInNewContext(code, {
    exports, process: { pid: 12345 },
    require: name => {
      if (name === 'node:fs') return fakeFs // No real diagnostic files from this fixture.
      if (name === 'node:os') return { tmpdir: () => 'C:\\diag-fixture' }
      if (name === 'node:path') return path.win32
      throw new Error(`Unexpected diagnostic dependency: ${name}`)
    }
  })
  return { ...exports, writes, failWrites: () => { fakeFs.appendFileSync = () => { throw new Error('fixture disk failure') } } }
}

function embed(livePage = null, platformId = 'fixture') {
  const exports = {}
  const rawLog = rawSendLogFixture()
  const promptLog = rawSendLogFixture('src/main/prompt-log.ts')
  const code = ts.transpileModule(fs.readFileSync(path.join(root, 'src/main/embed.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  }).outputText
  vm.runInNewContext(code, {
    exports,
    console: { info() {}, warn() {} },
    require: name => {
      if (name === 'electron') return {} // Never load or launch Electron.
      if (name.endsWith('?raw')) return { __esModule: true, default: source }
      if (name === '../shared/types') return {
        FALLBACK_ENVIRONMENT: {},
        buildTerminalPromptParts: () => ({ basePrompt: 'base', toolPrompt: '', prefix: 'prefix' })
      }
      if (name === './page-files' || name === '../shared/file-requests') return {}
      if (name === './raw-send-log') return rawLog
      if (name === './prompt-log') return promptLog
      throw new Error(`Unexpected dependency: ${name}`)
    }
  })
  const instance = new exports.ChatGptEmbed({ id: platformId, homeUrl: 'https://example.invalid', page: {} }, {
    onInterceptor() {}, onAssistantMessage() {}, onUserMessage() {}
  })
  const configurations = []
  instance.view = { webContents: { isDestroyed: () => false, executeJavaScript: async script => {
    const marker = '.configure('
    const at = script.lastIndexOf(marker)
    if (at < 0) {
      assert.ok(livePage, 'Non-configuration calls require a page fixture')
      return livePage.evaluate(script)
    }
    const config = JSON.parse(script.slice(at + marker.length, -');true'.length))
    configurations.push(config)
    if (livePage) livePage.lifecycle.configure(config)
    return true
  } } }
  if (livePage) livePage.onReport(event => instance.handlePageReport('[cmd-terminal] ' + JSON.stringify(event)))
  return { instance, configurations, rawLog, promptLog }
}

function composerBoundaryChecks() {
  const adapters = {}
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root, 'src/shared/platforms.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText, { exports: adapters, require: () => ({ isConversationId: () => true }) })
  const rendered = { isConnected: true, visible: true, getClientRects() { return this.visible ? [{}] : [] } }
  const rich = { ...rendered, closest: selector => selector.startsWith('div[contenteditable="true"]') ? rich : null }
  const pending = { ...rendered, closest: selector => selector === 'textarea#pending-home-input' ? pending : null }
  const oldRich = { ...rich, visible: false, closest: selector => selector.startsWith('div[contenteditable="true"]') ? oldRich : null }
  const document = {
    activeElement: pending,
    querySelectorAll: selector => selector.startsWith('div[contenteditable="true"]') ? [oldRich, rich] : selector === 'textarea#pending-home-input' ? [pending] : []
  }
  const context = { PAGE: adapters.CHATGPT_PAGE, document, getComputedStyle: () => ({ visibility: 'visible' }) }
  vm.createContext(context)
  vm.runInContext(section('  const queryFirst =', '  const readComposer =') + '\nglobalThis.resolve = getComposer;', context)
  assert.equal(context.resolve(pending), pending, 'An active bootstrap textarea must win over a coexisting rich editor')
  assert.equal(context.resolve(), pending, 'Programmatic writes resolve the focused bootstrap control')
  document.activeElement = rich
  assert.equal(context.resolve({ closest: selector => rich.closest(selector) }), rich, 'Nested editor events resolve the full editor after hydration')
  document.activeElement = null
  assert.equal(context.resolve(), rich, 'A hidden old editor cannot win the document-order fallback')
  document.activeElement = oldRich
  assert.equal(context.resolve(), rich, 'A hidden focus owner cannot win over the visible editor')
  for (const kind of ['textarea', 'contenteditable']) {
    const p = page(kind)
    p.composer.text = '读取当前cpu状态'
    assert.equal(p.keyDown().defaultPrevented, true)
    p.flush()
    assert.equal(p.events.filter(event => event.event === 'injected').length, 1)
    assert.equal(p.events.find(event => event.event === 'send-observed').reason, 'accepted')
    assert.equal(p.events.find(event => event.event === 'sent').promptInjected, true)
    for (const flags of [{ shiftKey: true }, { isComposing: true }, { repeat: true }, { defaultPrevented: true }]) {
      const skipped = page(kind)
      skipped.composer.text = '保留草稿'
      skipped.keyDown(flags)
      assert.equal(skipped.controls.writes, 0)
      assert.equal(skipped.submissions.length, 0)
      assert.equal(skipped.composer.text, '保留草稿')
      assert.equal(skipped.events.at(-1).event, 'send-observed')
    }
  }
  const missing = page('textarea')
  missing.controls.composerFound = false
  missing.keyDown()
  assert.equal(missing.events.at(-1).reason, 'composer-missing')
  assert.equal(missing.controls.writes, 0)
  const synthetic = page('textarea')
  synthetic.state.programmatic = true
  synthetic.keyDown({ isTrusted: false })
  assert.equal(synthetic.events.length, 1, 'Only the initial configuration is reported; synthetic sends cannot create user-attempt records')
  log('PASS bootstrap/rich-editor ownership, real Enter interception, preserved IME/newline/repeat handling and metadata-only bypass reasons')
}

function composerControlFixture(composer) {
  const selectors = {
    composerSelectors: [], sendButtonSelectors: ['button[aria-label="发送"]'],
    stopButtonSelectors: ['button[aria-label="停止"]'], disabledControlSelectors: ['.fixture-disabled']
  }
  const control = (label, flags = {}) => ({
    isConnected: true, visible: true, disabled: false, ariaDisabled: false, cssDisabled: false,
    getClientRects() { return this.visible ? [{}] : [] },
    closest() { return this.hiddenAncestor ? {} : null },
    getAttribute(name) { return name === 'aria-disabled' ? String(this.ariaDisabled) : null },
    matches(selector) { return selector === `button[aria-label="${label}"]` || selector === '.fixture-disabled' && this.cssDisabled },
    ...flags
  })
  const stale = control('发送', { disabled: true })
  const hiddenLocal = control('发送', { visible: false, disabled: true })
  const send = control('发送')
  const stop = control('停止', { visible: false })
  const attach = control('添加')
  const model = control('模型')
  const outside = control('发送')
  let local = [hiddenLocal, attach, model, send, stop]
  const query = (nodes, selector) => selector === 'button, [role="button"]' ? nodes : nodes.filter(node => node.matches(selector))
  const scope = {
    querySelectorAll: selector => query(local, selector),
    contains: node => local.includes(node)
  }
  const document = {
    body: {},
    querySelectorAll: selector => query([stale, ...local, outside], selector)
  }
  composer.parentElement = scope
  composer.querySelectorAll = () => []
  const context = { PAGE: selectors, document, getComposer: () => composer, getComputedStyle: () => ({ visibility: 'visible' }) }
  vm.createContext(context)
  vm.runInContext([
    section('  const isVisibleElement =', '  const getComposer ='),
    section('  const controlDisabled =', '  const describeControl ='),
    section('  const findSendButton =', '  const pressEnter ='),
    section('  const findStopButton =', '  /* ------------------------------------------------------------------ *'),
    'globalThis.lookup = { send: findSendButton, stop: findStopButton, disabled: controlDisabled };'
  ].join('\n'), context)
  return { ...context.lookup, sendControl: send, stopControl: stop, stale, outside, hiddenLocal, attach, model,
    setLocal: nodes => { local = nodes }, scope, document }
}

function composerControlChecks() {
  const p = page()
  const lookup = composerControlFixture(p.composer)
  assert.equal(lookup.send(), lookup.sendControl, 'The current toolbar wins over the earlier disabled document match')
  assert.equal(lookup.stop(), null, 'Hidden stop buttons do not block an idle composer')
  p.useControlLookup(lookup)
  p.composer.text = '当前cpu状态'
  p.keyDown()
  p.flush()
  assert.equal(p.buttonClicks.length, 1)
  assert.equal(p.buttonClicks[0], lookup.sendControl)
  assert.equal(p.events.find(event => event.event === 'sent').promptInjected, true)
  assert.equal(p.events.filter(event => event.event === 'injected').length, 1)

  for (const flags of [{ disabled: true }, { ariaDisabled: true }, { cssDisabled: true }]) {
    const blocked = page()
    const controls = composerControlFixture(blocked.composer)
    Object.assign(controls.sendControl, flags)
    blocked.useControlLookup(controls)
    blocked.send('等待当前按钮可用')
    assert.equal(controls.send(), controls.sendControl, 'A disabled current control must not fall back to an enabled control elsewhere')
    assert.equal(blocked.submissions.length, 0)
    assert.equal(blocked.events.at(-1).event, 'send-failed')
    assert.equal(blocked.state.taskPromptInjected, false)
    assert.match(blocked.composer.text, /等待当前按钮可用/)
  }
  const generating = page()
  const controls = composerControlFixture(generating.composer)
  controls.stopControl.visible = true
  generating.useControlLookup(controls)
  generating.send('等待上一条回复结束')
  assert.equal(generating.buttonClicks.length, 0, 'A visible Stop blocks submission even when a Send also remains mounted')
  assert.equal(generating.events.at(-1).event, 'send-failed')
  controls.setLocal([controls.hiddenLocal, controls.attach, controls.model, controls.stopControl])
  assert.equal(controls.send(), null, 'A visible document-wide Send outside the active toolbar cannot replace a missing local Send')
  lookup.sendControl.hiddenAncestor = true
  assert.equal(lookup.send(), null, 'Hidden/inert ancestor controls are excluded')
  lookup.sendControl.hiddenAncestor = false
  lookup.sendControl.isConnected = false
  assert.equal(lookup.send(), null, 'Detached controls are excluded')
  log('PASS visible current-toolbar Send selection after returning home, one confirmed submission, disabled guards and no clicks during generation')
}

function promptDiagnosticChecks() {
  const fixture = embed(null, 'chatgpt')
  const report = payload => fixture.instance.handlePageReport('[cmd-terminal] ' + JSON.stringify(payload))
  report({ event: 'configured', enabled: true, prefixLength: 3000 })
  report({ event: 'send-observed', trigger: 'enter', reason: 'accepted', composerKind: 'textarea', composerTextLength: 7, composerFound: true })
  report({ event: 'injected', count: 1, prefixLength: 3000, prefixHead: 'private prompt', taskPromptGeneration: 0 })
  report({ event: 'sent', text: 'private user text', promptInjected: true, taskPromptGeneration: 0 })
  const records = fixture.promptLog.writes.map(write => JSON.parse(write.value.slice(write.value.indexOf('{'))))
  assert.deepEqual(records.map(record => record.event), ['configured', 'send-observed', 'injected', 'sent'])
  assert.equal(records.at(-1).mainTaskPromptInjected, true, 'The main bridge records its updated confirmation state')
  assert.ok(fixture.promptLog.writes.every(write => /chatgpt-prompt-/.test(write.file)))
  assert.doesNotMatch(fixture.promptLog.writes.map(write => write.value).join(''), /private prompt|private user text/)
  const logger = rawSendLogFixture('src/main/prompt-log.ts')
  logger.writePromptDiagnostic('chatgpt', {
    event: 'send-observed', reason: 'private reason', trigger: 'private trigger',
    composerKind: 'private type', composerTextLength: -1, prefixLength: 'private length',
    prefixHead: 'private prefix', text: 'private text', url: 'private url', cookie: 'private cookie',
    toolbar: ['private toolbar'], composerFound: true
  }, { taskPromptInjected: false, taskPromptGeneration: 0 })
  assert.doesNotMatch(logger.writes[0].value, /private/)
  assert.match(logger.writes[0].value, /"reason":"unknown"/)
  assert.equal(logger.writePromptDiagnostic('../../unsafe', { event: 'configured' }, {}), null)
  assert.equal(logger.writePromptDiagnostic('chatgpt', { event: 'assistant-message', text: 'private reply' }, {}), null)
  logger.writePromptDiagnostic('chatgpt', {
    event: 'send-failed', attempts: 91, composerTextLength: 3120, sendButtonFound: true,
    sendButtonDisabled: true, sendButtonVisible: true, sendButtonInComposer: true, stopButtonFound: false,
    recoveryTried: null, composerLeft: 'private draft', sendButton: { aria: 'private label' }, toolbar: ['private toolbar']
  }, {})
  const failure = JSON.parse(logger.writes.at(-1).value.slice(logger.writes.at(-1).value.indexOf('{')))
  assert.equal(failure.attempts, 91)
  assert.equal(failure.sendButtonDisabled, true)
  assert.equal(failure.sendButtonInComposer, true)
  assert.equal(failure.composerTextLength, 3120)
  assert.doesNotMatch(logger.writes.at(-1).value, /private/)
  logger.writePromptDiagnostic('chatgpt', { event: 'send-recovery', action: 'enter', attempt: 2, recoveryTried: 'enter' }, {})
  assert.match(logger.writes.at(-1).value, /"action":"enter"/)
  logger.writePromptDiagnostic('chatgpt', { event: 'send-failed', action: 'private action', recoveryTried: 'private recovery', attempts: 'private attempts' }, {})
  assert.doesNotMatch(logger.writes.at(-1).value, /private/)
  logger.failWrites()
  assert.equal(logger.writePromptDiagnostic('chatgpt', { event: 'configured' }, {}), null)
  log('PASS persisted prompt/send boundary, bridge confirmation state, allowlisted metadata and harmless diagnostic write failures')
}

function questionSession(kind = 'contenteditable') {
  const p = page(kind)
  p.send('启动需要确认的任务')
  p.reply('{"type":"questions","questions":[{"question":"请把手动执行结果发回。"}]}')
  assert.ok(p.state.pendingQuestion)
  const fixture = embed(p)
  fixture.instance.setBaselinePolicy(true)
  for (const event of p.events.filter(event => event.event === 'sent' || event.event === 'question')) {
    fixture.instance.handlePageReport('[cmd-terminal] ' + JSON.stringify(event))
  }
  return { p, ...fixture }
}

async function main() {
  new vm.Script(source)
  for (const kind of ['contenteditable', 'textarea']) {
    const p = page(kind)
    p.composer.text = '修复构建'
    assert.equal(p.intercept(p.event()), true)
    assert.equal(p.state.taskPromptInjected, false, 'Writing a prefix is not a successful send')
    p.flush()
    assert.equal(p.state.taskPromptInjected, true)
    assert.ok(p.state.awaitingReplySince > 0)
    assert.equal(p.state.lastCommandMessageId, 'old-reply', 'Baseline must precede the new assistant placeholder')
    assert.equal(p.submissions.length, 1)
    assert.ok(p.submissions[0].includes(p.USER_TEXT_SENTINEL))
    p.send('保持接口不变\n并保留注释')
    assert.equal(p.submissions.at(-1), '保持接口不变\n并保留注释')
    assert.equal(p.controls.writes, 1, 'Follow-ups should not rewrite the editor')
    assert.equal(p.events.filter(e => e.event === 'injected').length, 1)
    assert.equal(p.events.filter(e => e.event === 'user-message').length, 2)
    assert.equal(p.events.filter(e => e.event === 'sent').at(-1).promptInjected, false)
    p.reply('我会保留现有接口。')
    assert.equal(p.state.taskActive, true)
    p.send('继续修改')
    assert.equal(p.submissions.at(-1), '继续修改')
    p.reply('{"command":"echo ok","description":"检查"}')
    assert.equal(p.events.filter(e => e.event === 'command').at(-1).live, true)
    p.reply('【任务完成】构建问题已修复。')
    assert.equal(p.state.taskPromptInjected, false)
    assert.equal(p.state.taskActive, false)
    p.send('增加日志导出')
    assert.equal(p.events.filter(e => e.event === 'injected').length, 2)
    assert.equal(p.state.taskPromptInjected, true)
    p.lifecycle.endTask()
    p.send('开始另一个任务')
    assert.equal(p.events.filter(e => e.event === 'injected').length, 3)
    log(`PASS ${kind}: one prompt per task, clean multiline follow-ups, live commands, completion and manual end`)
  }

  const failed = page()
  failed.controls.accept = false
  failed.send('失败后重试')
  assert.equal(failed.state.taskPromptInjected, false)
  assert.equal(failed.events.filter(e => e.event === 'sent').length, 0)
  const prepared = failed.composer.text
  assert.ok(prepared.includes(failed.USER_TEXT_SENTINEL))
  failed.controls.accept = true
  assert.equal(failed.intercept(failed.event()), true)
  failed.flush()
  assert.equal(failed.submissions.at(-1), prepared)
  assert.equal(failed.controls.writes, 1)
  assert.equal(failed.state.taskPromptInjected, true)
  assert.equal(failed.events.filter(e => e.event === 'user-message').at(-1).text, '失败后重试')
  failed.send('后续消息')
  assert.equal(failed.submissions.at(-1), '后续消息')
  log('PASS failed submission preserves pending injection; prepared-draft retry avoids duplicate prefixes')

  const rejected = page()
  rejected.controls.write = false
  rejected.send('写入失败仍发送用户文字')
  assert.equal(rejected.state.taskPromptInjected, false)
  assert.equal(rejected.submissions.at(-1), '写入失败仍发送用户文字')
  rejected.controls.write = true
  rejected.send('新的草稿')
  assert.equal(rejected.state.taskPromptInjected, true)
  log('PASS failed prefix write does not consume injection or prevent the next draft from trying')

  const image = page()
  assert.equal(image.intercept(image.event()), false, 'Empty composer must never send a prompt-only turn')
  image.controls.image = true
  image.send('')
  assert.equal(image.state.taskPromptInjected, true)
  image.controls.image = true
  image.send('')
  assert.equal(image.submissions.at(-1), '')
  assert.equal(image.events.filter(e => e.event === 'user-message').length, 2)
  assert.ok(image.events.filter(e => e.event === 'user-message').every(e => e.attachmentToken))
  log('PASS image-only first send and follow-up retain attachment capture; empty drafts do not send')

  const config = page()
  config.send('开始')
  config.lifecycle.configure({ taskPromptGeneration: 0, taskPromptInjected: false, prefix: '更新后的提示词\n\n', armBaseline: true })
  config.armBaseline()
  assert.equal(config.state.taskPromptInjected, true)
  config.lifecycle.configure({ enabled: false })
  config.lifecycle.configure({ enabled: true })
  config.send('同一任务继续')
  assert.equal(config.submissions.at(-1), '同一任务继续')
  config.reply('{"type":"questions","questions":[{"question":"选择哪个方案？"}]}')
  assert.ok(config.state.pendingQuestion)
  assert.equal(config.state.taskPromptInjected, true)
  const answer = config.lifecycle.sendRaw('1. 选择第一个方案')
  config.flush()
  assert.equal(await answer, 'ok')
  assert.equal(config.state.taskPromptInjected, true)
  log('PASS configuration, command baseline and mode changes preserve task injection; clarification pauses retain it')
}

// Keep asynchronous raw-send checks outside an await-before-flush deadlock.
async function remaining() {
  const enter = page('textarea')
  enter.controls.selector = false
  enter.send('使用 Enter 开始')
  enter.send('通过 Enter 继续')
  assert.equal(enter.events.filter(e => e.event === 'injected').length, 1)
  assert.equal(enter.submissions.at(-1), '通过 Enter 继续')
  const raw = page('textarea')
  raw.send('开始任务')
  const pending = raw.lifecycle.sendRaw('命令输出')
  raw.flush()
  assert.equal(await pending, 'ok')
  assert.equal(raw.events.filter(e => e.event === 'injected').length, 1)
  raw.send('继续')
  assert.equal(raw.submissions.at(-1), '继续')

  const fresh = page('contenteditable', { taskPromptGeneration: 4, taskPromptInjected: true })
  fresh.send('刷新后继续')
  assert.equal(fresh.events.filter(e => e.event === 'injected').length, 0)
  fresh.lifecycle.configure({ taskPromptGeneration: 5, taskPromptInjected: false })
  fresh.lifecycle.configure({ taskPromptGeneration: 4, taskPromptInjected: true })
  fresh.send('切换会话后的新任务')
  assert.equal(fresh.events.filter(e => e.event === 'injected').length, 1)
  log('PASS raw feedback skips injection; reload restoration and new generations preserve/reset it appropriately')

  const delayed = page()
  delayed.composer.text = '尚未提交的任务'
  delayed.intercept(delayed.event())
  delayed.lifecycle.endTask()
  delayed.flush()
  assert.equal(delayed.submissions.length, 0)
  assert.equal(delayed.state.taskPromptInjected, false)
  assert.equal(delayed.state.taskActive, false)
  const confirming = page()
  confirming.send('先建立任务')
  confirming.composer.text = '正在确认的追问'
  confirming.intercept(confirming.event())
  confirming.lifecycle.endTask()
  confirming.flush()
  assert.equal(confirming.state.taskPromptInjected, false)
  assert.equal(confirming.state.taskActive, false)
  const navigated = page()
  navigated.composer.text = '尚未发送就切换会话'
  navigated.intercept(navigated.event())
  navigated.lifecycle.configure({ taskPromptGeneration: 1, taskPromptInjected: false })
  assert.equal(navigated.state.programmatic, false)
  navigated.flush()
  assert.equal(navigated.submissions.length, 0)
  navigated.send('切换后的新目标')
  assert.equal(navigated.state.taskPromptInjected, true)
  log('PASS late submit delays and confirmations cannot send or revive an ended task')

  const { instance, configurations } = embed()
  instance.handlePageReport('[cmd-terminal] ' + JSON.stringify({ event: 'sent', text: '开始', promptInjected: true, taskPromptGeneration: 0 }))
  instance.setBaselinePolicy(true)
  await instance.installInterceptor()
  assert.equal(configurations.at(-1).taskPromptInjected, true)
  assert.equal(configurations.at(-1).armBaseline, true)
  instance.completeTask()
  assert.equal(configurations.at(-1).taskPromptInjected, false)
  assert.equal(configurations.at(-1).taskPromptGeneration, 1)
  assert.equal(configurations.at(-1).armBaseline, false)
  instance.handlePageReport('[cmd-terminal] ' + JSON.stringify({ event: 'sent', text: '迟到的确认', promptInjected: true, taskPromptGeneration: 0 }))
  assert.notEqual(instance.getInterceptorStatus().taskFinishedAt, null)
  await instance.installInterceptor()
  assert.equal(configurations.at(-1).taskPromptInjected, false)
  log('PASS real main-process methods restore confirmed prompt state, reset tasks without baselining new replies and ignore stale confirmations')
}

async function promptInjectionToggleChecks() {
  for (const kind of ['contenteditable', 'textarea']) {
    const p = page(kind, { promptInjectionEnabled: false })
    p.send('保持原文\n  保留缩进')
    assert.equal(p.submissions[0], '保持原文\n  保留缩进')
    assert.equal(p.controls.writes, 0, 'Disabled injection cannot rewrite the user draft')
    assert.equal(p.state.enabled, true, 'Terminal mode remains enabled')
    assert.equal(p.state.taskPromptInjected, false)
    assert.equal(p.events.filter(event => event.event === 'injected').length, 0)
    assert.equal(p.events.filter(event => event.event === 'user-message').length, 1)
    assert.equal(p.events.filter(event => event.event === 'sent').at(-1).promptInjected, false)
    p.reply('{"command":"echo ok","description":"检查"}')
    assert.equal(p.events.filter(event => event.event === 'command').at(-1).live, true)
    p.lifecycle.configure({ promptInjectionEnabled: true })
    p.send('开启后首次注入')
    assert.equal(p.events.filter(event => event.event === 'injected').length, 1)
    p.lifecycle.configure({ promptInjectionEnabled: false })
    p.send('关闭后继续')
    assert.equal(p.submissions.at(-1), '关闭后继续')
    p.lifecycle.configure({ promptInjectionEnabled: true })
    p.send('同一任务再次开启')
    assert.equal(p.submissions.at(-1), '同一任务再次开启')
    assert.equal(p.events.filter(event => event.event === 'injected').length, 1, 'Toggling does not re-inject an already confirmed task')
    p.lifecycle.endTask()
    p.lifecycle.configure({ promptInjectionEnabled: false, prefix: '' })
    p.send('没有前缀也能发送')
    assert.equal(p.submissions.at(-1), '没有前缀也能发送')
    assert.equal(p.state.taskPromptInjected, false)
    p.controls.image = true
    p.send('')
    assert.equal(p.submissions.at(-1), '')
    assert.ok(p.events.filter(event => event.event === 'user-message').at(-1).attachmentToken)
    assert.equal(p.state.taskPromptInjected, false)
    const rejected = page(kind)
    rejected.controls.write = false; rejected.controls.accept = false
    rejected.send('未能注入或发送的草稿')
    rejected.lifecycle.configure({ promptInjectionEnabled: false })
    rejected.controls.accept = true
    rejected.send('关闭注入后重试')
    assert.equal(rejected.submissions.at(-1), '关闭注入后重试', 'Disabled injection bypasses a previous prefix-write rejection')
  }
  const activePage = page()
  activePage.send('已建立任务')
  const a = embed(activePage), b = embed()
  a.instance.handlePageReport('[cmd-terminal] ' + JSON.stringify({ event: 'sent', text: '已建立任务', promptInjected: true, taskPromptGeneration: 0 }))
  a.instance.setPromptInjectionEnabled(false)
  assert.equal(a.instance.getInterceptorStatus().enabled, true)
  assert.equal(a.instance.getInterceptorStatus().promptInjectionEnabled, false)
  assert.equal(b.instance.getInterceptorStatus().promptInjectionEnabled, true)
  assert.equal(a.configurations.at(-1).taskPromptInjected, true)
  assert.equal(a.configurations.at(-1).taskPromptGeneration, 0)
  assert.equal(a.configurations.at(-1).armBaseline, false)
  a.instance.setPromptParts({ basePrompt: 'base', toolPrompt: 'tools', prefix: 'changed environment' })
  await a.instance.installInterceptor()
  assert.equal(a.configurations.at(-1).promptInjectionEnabled, false, 'Environment updates and reloads preserve the switch')
  const terminalOff = page('textarea', { enabled: false, promptInjectionEnabled: false })
  terminalOff.lifecycle.configure({ promptInjectionEnabled: true })
  assert.equal(terminalOff.state.enabled, false)
  terminalOff.composer.text = '普通对话'
  assert.equal(terminalOff.intercept(terminalOff.event()), false)
  log('PASS session prompt switch: unmodified text/image sends, live command tracking, re-enabling, task deduplication and independent terminal state')
}

async function rawSendGuardChecks() {
  const scenarios = [
    { reason: 'programmatic-send', setup: p => { p.state.programmatic = true } },
    { reason: 'model-generating', setup: p => { p.controls.generating = true } },
    { reason: 'image-draft', setup: p => { p.controls.image = true } },
    { reason: 'attachment-draft', setup: p => { p.controls.attachment = true } },
    { reason: 'text-draft', setup: p => { p.composer.text = 'private user draft' } }
  ]
  for (const kind of ['contenteditable', 'textarea']) {
    for (const scenario of scenarios) {
      const p = page(kind)
      const fixture = embed(p, 'claude')
      scenario.setup(p)
      const originalDraft = p.composer.text
      assert.equal(await fixture.instance.sendRaw('private command output'), 'busy')
      assert.equal(p.controls.writes, 0, 'A blocked send cannot write to the composer')
      assert.equal(p.submissions.length, 0)
      assert.equal(p.composer.text, originalDraft)
      assert.equal(p.events.at(-1).reason, scenario.reason)
      assert.equal(p.events.at(-1).composerTextLength, originalDraft.length)
      assert.equal(fixture.rawLog.writes.length, 1, 'The real console bridge persists guard metadata')
      const record = fixture.rawLog.writes[0]
      assert.match(record.file, /claude-raw-send-/)
      assert.match(record.value, new RegExp(scenario.reason))
      assert.doesNotMatch(record.value, /private user draft|private command output/)
      if (scenario.reason === 'attachment-draft') assert.match(record.value, /"attachmentCards":1/)
    }
  }
  const empty = page()
  const { instance, rawLog } = embed(empty, 'claude')
  const result = instance.sendRaw('harmless result')
  empty.flush()
  assert.equal(await result, 'ok')
  assert.equal(empty.submissions.length, 1)
  assert.equal(rawLog.writes.length, 0, 'Successful sends do not create blocked-send logs')
  const logger = rawSendLogFixture()
  const logPath = logger.writeRawSendDiagnostic('claude', {
    event: 'raw-busy', reason: 'untrusted-secret-value', composerTextLength: 0,
    attachmentCards: -1, attachmentInputFiles: 'private-filename', attachmentImages: NaN,
    attachmentRootFound: true, stopButtonFound: 'private label',
    text: 'private output', composerLeft: 'private draft', toolbar: [{ aria: 'private toolbar' }]
  })
  assert.ok(logPath)
  const record = JSON.parse(logger.writes[0].value.slice(logger.writes[0].value.indexOf('{')))
  assert.deepEqual(record, { event: 'raw-busy', reason: 'unknown', composerTextLength: 0, attachmentRootFound: true })
  assert.equal(logger.writeRawSendDiagnostic('../../unsafe', { event: 'raw-busy' }), null)
  assert.equal(logger.writeRawSendDiagnostic('claude', { event: 'sent-raw', text: 'private output' }), null)
  logger.failWrites()
  assert.equal(logger.writeRawSendDiagnostic('claude', { event: 'raw-busy', reason: 'text-draft' }), null, 'Logging failure does not break the send guard')
  log('PASS exact raw-send guard reasons, empty-composer sends, draft preservation and content-free automatic logs through the real main/page bridge')
}

function questionMarkdownChecks() {
  const parser = {}
  vm.runInNewContext([
    section('  const balancedObjects =', '  const readJsonishString ='),
    section('  const looksLikeQuestionReply =', '  const looksLikeCommandReply ='),
    'globalThis.parseQuestion = extractQuestion;'
  ].join('\n'), parser)
  const command = [
    "sudo tee /etc/systemd/system/usts-login.service >/dev/null <<'EOF'",
    '[Unit]',
    'Description=USTS Campus Network Auto Login',
    '',
    '[Service]',
    'Type=simple',
    'User=siyaoer',
    'Environment=HOME=/home/siyaoer',
    'ExecStart=/home/siyaoer/.local/bin/usts-login --auto-login',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    'EOF',
    'sudo systemctl daemon-reload && sudo systemctl enable --now usts-login.service',
    "  printf '%s\\n' '{literal shell escape}'"
  ].join('\n')
  const fence = '`'.repeat(3)
  for (const newline of ['\n', '\r\n']) {
    for (const fenced of [false, true]) {
      const question = ['请手动执行以下命令：', '', ...(fenced ? [fence + 'bash'] : []), command,
        ...(fenced ? [fence] : [])].join('\n').replace(/\n/g, newline)
      for (const type of ['question', 'questions']) {
        const request = type === 'question'
          ? { type, question }
          : { type, questions: [{ question }] }
        const raw = fence + 'json\n' + JSON.stringify(request) + '\n' + fence
        const parsed = parser.parseQuestion(raw)
        assert.ok(parsed, `${type}: an outer JSON fence must not corrupt nested Markdown`)
        assert.equal(parsed.questions[0].question, question)
        const { instance } = embed()
        instance.handlePageReport('[cmd-terminal] ' + JSON.stringify({
          event: 'question', messageId: 'multiline-question', live: true, ...parsed
        }))
        assert.equal(instance.getInterceptorStatus().pendingQuestion.questions[0].question, question,
          'Question lines, EOF, indentation and literal shell escapes must survive the main-process bridge')
      }
    }
  }
  const repairable = '{"type":"questions","questions":[{"question":' +
    JSON.stringify(fence + 'sh\n' + command + '\n' + fence) + ',}],}'
  assert.equal(parser.parseQuestion(repairable).questions[0].question, fence + 'sh\n' + command + '\n' + fence)
  assert.equal(parser.parseQuestion(JSON.stringify({ type: 'question', question: '确认？', command: 'echo nope' })), null)
  assert.equal(parser.parseQuestion('{"type":"questions","questions":[]}'), null)
  log('PASS real question parser and main-process bridge preserve plain/fenced commands, LF/CRLF and literal escapes')
}

async function questionChecks() {
  for (const kind of ['contenteditable', 'textarea']) {
    const { p, instance, configurations } = questionSession(kind)
    const messageId = p.state.pendingQuestion.messageId
    for (const change of ['ssh-connect', 'ssh-close', 'ssh-disconnect', 'ssh-switch', 'cwd', 'notes']) {
      instance.setPromptParts({ basePrompt: change, toolPrompt: 'tools', prefix: `environment-${change}` })
      assert.equal(configurations.at(-1).armBaseline, false)
      assert.equal(instance.getInterceptorStatus().pendingQuestion.messageId, messageId)
      assert.equal(p.state.pendingQuestion.messageId, messageId, `${change} must preserve the question`)
    }
    for (const enabled of [false, true, false]) {
      instance.setInterceptorEnabled(enabled)
      assert.equal(p.state.enabled, enabled)
      assert.equal(p.state.pendingQuestion.messageId, messageId)
      assert.equal(instance.getInterceptorStatus().pendingQuestion.messageId, messageId)
    }
    // A terminal execution flag is not the identity of the conversation's question.
    p.state.taskActive = false
    assert.equal(await p.lifecycle.answerQuestion('wrong-question', '旧答案'), 'stale')
    await assert.rejects(instance.answerQuestion('wrong-question', '旧答案'), /问题已失效/)
    const answer = instance.answerQuestion(messageId, '手动执行完成\n退出码 0')
    p.flush()
    assert.equal((await answer).pendingQuestion, null)
    assert.equal(p.state.pendingQuestion, null)
    assert.equal(p.submissions.at(-1), '手动执行完成\n退出码 0')
    assert.equal(p.events.filter(event => event.event === 'injected').length, 1)
    assert.equal(p.state.taskPromptInjected, true)
    await assert.rejects(instance.answerQuestion(messageId, '重复答案'), /问题已失效/)
    p.reply('{"type":"questions","questions":[{"question":"关闭终端模式后继续确认？"}]}')
    const followUpId = p.state.pendingQuestion.messageId
    assert.equal(instance.getInterceptorStatus().pendingQuestion.messageId, followUpId)
    const followUp = instance.answerQuestion(followUpId, '继续')
    p.flush()
    assert.equal((await followUp).pendingQuestion, null)
    assert.equal(p.events.filter(event => event.event === 'injected').length, 1)
    p.reply('{"command":"echo disabled","description":"不得自动执行"}')
    assert.equal(p.events.filter(event => event.event === 'command').length, 0, 'Answering must not re-enable terminal commands')
    log(`PASS ${kind}: SSH/environment changes and terminal toggles preserve questions; answers work without terminal flags`)
  }

  const retry = questionSession()
  const retryId = retry.p.state.pendingQuestion.messageId
  retry.p.controls.accept = false
  const failed = retry.instance.answerQuestion(retryId, '保留这份回答')
  const rejected = assert.rejects(failed, /尚未确认发送/)
  retry.p.flush()
  await rejected
  assert.equal(retry.p.state.answerDraft.text, '保留这份回答')
  retry.instance.setPromptParts({ basePrompt: 'local', toolPrompt: 'tools', prefix: 'local-after-ssh-close' })
  retry.instance.setInterceptorEnabled(false)
  assert.equal(retry.p.state.answerDraft.messageId, retryId)
  assert.equal(retry.p.state.answerDraft.text, '保留这份回答')
  retry.p.controls.accept = true
  const retried = retry.instance.answerQuestion(retryId, '保留这份回答')
  retry.p.flush()
  assert.equal((await retried).pendingQuestion, null)
  assert.equal(retry.p.state.answerDraft, null)
  assert.equal(retry.p.events.filter(event => event.event === 'injected').length, 1)
  log('PASS failed-answer draft remains retryable after SSH environment changes and disabling terminal mode')

  const waiting = page()
  waiting.send('等待模型的问题')
  const active = embed(waiting)
  active.instance.setBaselinePolicy(true)
  active.instance.handlePageReport('[cmd-terminal] ' + JSON.stringify(waiting.events.find(event => event.event === 'sent')))
  const awaitingReplySince = waiting.state.awaitingReplySince
  active.instance.setPromptParts({ basePrompt: 'remote', toolPrompt: 'tools', prefix: 'remote-environment' })
  active.instance.setInterceptorEnabled(false)
  assert.ok(awaitingReplySince > 0)
  assert.equal(waiting.state.awaitingReplySince, awaitingReplySince)
  waiting.reply('{"type":"questions","questions":[{"question":"下一步怎么做？"}]}')
  assert.ok(active.instance.getInterceptorStatus().pendingQuestion)
  log('PASS environment updates and terminal-mode changes preserve in-flight replies and live follow-up questions')

  const ended = questionSession()
  const endedId = ended.p.state.pendingQuestion.messageId
  await ended.instance.endTask()
  assert.equal(ended.p.state.pendingQuestion, null)
  assert.equal(ended.instance.getInterceptorStatus().pendingQuestion, null)
  await assert.rejects(ended.instance.answerQuestion(endedId, '结束后的回答'), /问题已失效/)

  const replaced = questionSession()
  const oldId = replaced.p.state.pendingQuestion.messageId
  replaced.p.send('换一个问题')
  replaced.p.reply('{"type":"questions","questions":[{"question":"新的确认问题？"}]}')
  const newId = replaced.p.state.pendingQuestion.messageId
  assert.notEqual(newId, oldId)
  await assert.rejects(replaced.instance.answerQuestion(oldId, '旧问题的回答'), /问题已失效/)
  assert.equal(replaced.instance.getInterceptorStatus().pendingQuestion.messageId, newId)
  assert.equal(replaced.p.state.pendingQuestion.messageId, newId)
  log('PASS explicit task termination and replaced question IDs still reject obsolete answers')
}

async function cancelQuestionChecks() {
  for (const kind of ['contenteditable', 'textarea']) {
    const { p, instance } = questionSession(kind)
    const messageId = p.state.pendingQuestion.messageId
    const before = instance.getInterceptorStatus()
    const pageBefore = { ...p.state }
    const submissions = p.submissions.length
    const eventCount = p.events.length
    assert.equal(await p.lifecycle.cancelQuestion('wrong-question'), 'stale')
    await assert.rejects(instance.cancelQuestion('wrong-question'), /问题已失效/)
    assert.equal(p.state.pendingQuestion.messageId, messageId)
    p.state.programmatic = true
    await assert.rejects(instance.cancelQuestion(messageId), /正在处理中/)
    assert.equal(p.state.pendingQuestion.messageId, messageId)
    p.state.programmatic = false
    const cancelled = await instance.cancelQuestion(messageId)
    p.flush()
    assert.equal(cancelled.pendingQuestion, null)
    assert.equal(p.state.pendingQuestion, null)
    assert.equal(p.state.answerDraft, null)
    assert.equal(cancelled.taskStartedAt, before.taskStartedAt)
    assert.equal(cancelled.taskFinishedAt, before.taskFinishedAt)
    for (const key of ['taskActive', 'taskPromptInjected', 'taskPromptGeneration', 'awaitingReplySince', 'lastCommandMessageId']) {
      assert.equal(p.state[key], pageBefore[key], `Cancellation must preserve ${key}`)
    }
    assert.equal(p.submissions.length, submissions, 'Cancellation must not send anything to the model')
    assert.deepEqual(p.events.slice(eventCount).map(event => event.event), ['question-cleared'])
    p.checkForCommand()
    instance.setPromptParts({ basePrompt: 'local', toolPrompt: 'tools', prefix: 'environment-after-cancel' })
    instance.setInterceptorEnabled(false)
    instance.setInterceptorEnabled(true)
    assert.equal(p.state.pendingQuestion, null, 'DOM/configuration updates must not reopen the cancelled question')
    assert.equal(instance.getInterceptorStatus().pendingQuestion, null)
    await assert.rejects(instance.answerQuestion(messageId, '取消后的旧回答'), /问题已失效/)
    p.send('用户主动发送后续消息')
    assert.equal(p.submissions.at(-1), '用户主动发送后续消息')
    assert.equal(p.events.filter(event => event.event === 'injected').length, 1, 'Task prompt must remain injected')
    p.reply('{"type":"questions","questions":[{"question":"后续的新问题？"}]}')
    assert.ok(instance.getInterceptorStatus().pendingQuestion)
    log(`PASS ${kind}: local cancellation sends nothing, preserves task/prompt and does not reopen old questions`)
  }

  for (const edited of [false, true]) {
    const { p, instance } = questionSession()
    const messageId = p.state.pendingQuestion.messageId
    p.controls.accept = false
    const answer = instance.answerQuestion(messageId, '未确认发送的回答草稿')
    const rejected = assert.rejects(answer, /尚未确认发送/)
    p.flush()
    await rejected
    assert.ok(p.state.answerDraft)
    const submissions = p.submissions.length
    const userMessages = p.events.filter(event => event.event === 'user-message').length
    if (edited) p.composer.text = '用户后来编辑的独立草稿'
    await instance.cancelQuestion(messageId)
    p.flush()
    assert.equal(p.composer.text, edited ? '用户后来编辑的独立草稿' : '')
    assert.equal(p.state.answerDraft, null)
    assert.equal(p.submissions.length, submissions)
    assert.equal(p.events.filter(event => event.event === 'user-message').length, userMessages)
  }
  log('PASS cancellation clears only its owned failed-answer draft and preserves user edits without sending')

  const retry = questionSession()
  const retryId = retry.p.state.pendingQuestion.messageId
  retry.p.state.answerDraft = { messageId: retryId, text: '无法清除的草稿' }
  retry.p.composer.text = '无法清除的草稿'
  retry.p.controls.write = false
  await assert.rejects(retry.instance.cancelQuestion(retryId), /未能清除/)
  assert.equal(retry.p.state.pendingQuestion.messageId, retryId)
  assert.ok(retry.p.state.answerDraft)
  retry.p.controls.write = true
  await retry.instance.cancelQuestion(retryId)
  assert.equal(retry.p.state.pendingQuestion, null)
  log('PASS failed draft clearing leaves the question retryable')

  const race = questionSession()
  const oldId = race.p.state.pendingQuestion.messageId
  const evaluate = race.instance.view.webContents.executeJavaScript
  let release
  race.instance.view.webContents.executeJavaScript = async script => {
    const outcome = await evaluate(script)
    if (script.includes('.cancelQuestion(')) await new Promise(resolve => { release = resolve })
    return outcome
  }
  const cancellation = race.instance.cancelQuestion(oldId)
  await Promise.resolve()
  race.p.send('主动提出下一步')
  race.p.reply('{"type":"questions","questions":[{"question":"新问题不能被旧取消清除。"}]}')
  const newId = race.p.state.pendingQuestion.messageId
  assert.notEqual(newId, oldId)
  release()
  const status = await cancellation
  assert.equal(status.pendingQuestion.messageId, newId)
  await assert.rejects(race.instance.cancelQuestion(oldId), /问题已失效/)
  assert.equal(race.p.state.pendingQuestion.messageId, newId)
  log('PASS stale cancellation and delayed results preserve a newer question')

  // Execute the actual IPC handler with a runner that rejects all task-ending calls.
  const indexSource = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8')
  const start = indexSource.indexOf('  ipcMain.handle(IpcChannels.interceptorCancelQuestion,')
  const end = indexSource.indexOf('  ipcMain.handle(IpcChannels.interceptorEndTask,', start)
  assert.ok(start >= 0 && end > start)
  let handler
  const calls = []
  const runtime = {
    embed: { cancelQuestion: async id => { calls.push(id); return { pendingQuestion: null } } },
    runner: { endTask() { throw new Error('Cancellation must not end the task') }, interruptTerminal() { throw new Error('Cancellation must not interrupt commands') } },
    endTask() { throw new Error('Cancellation must not end the task') }
  }
  vm.runInNewContext(ts.transpileModule(indexSource.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText, {
    ipcMain: { handle(channel, callback) { handler = callback } },
    IpcChannels: { interceptorCancelQuestion: 'interceptor:cancel-question' },
    runtimeForEvent: () => runtime
  })
  assert.equal((await handler({}, 'question-id')).pendingQuestion, null)
  assert.deepEqual(calls, ['question-id'])
  await assert.rejects(handler({}, null), /当前会话不可用/)
  log('PASS cancellation IPC targets only the question and never ends tasks or interrupts commands')
}

log(`Log: ${logFile}`)
main().then(remaining).then(promptInjectionToggleChecks).then(rawSendGuardChecks).then(composerBoundaryChecks).then(composerControlChecks).then(promptDiagnosticChecks).then(questionMarkdownChecks).then(questionChecks).then(cancelQuestionChecks).then(() => log('PASS all offline task-prompt checks; live website behavior still requires user testing'))
  .catch(error => { log(`FAIL ${error.stack || error}`); process.exitCode = 1 })
