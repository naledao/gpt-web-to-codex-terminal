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
  const composer = { tagName: kind === 'textarea' ? 'TEXTAREA' : 'DIV', text: '' }
  const button = { disabled: false }
  const controls = { accept: true, write: true, image: false, writes: 0, selector: true, replyId: 'old-reply', reply: '' }
  const context = {
    Date: class extends Date { static now() { return now } },
    setTimeout: (run, delay) => { const id = ++timerSerial; timers.push({ id, run, at: now + delay }); return id },
    clearTimeout: id => { const at = timers.findIndex(timer => timer.id === id); if (at >= 0) timers.splice(at, 1) },
    getComposer: () => composer,
    readComposer: element => element.text,
    collapse: text => String(text || '').replace(/\s+/g, ' ').trim(),
    insertText: (element, text) => { controls.writes++; if (!controls.write) return false; element.text = text; return true },
    hasDraftImageAttachment: () => controls.image,
    beginUserImageCapture: () => `capture-${++imageSerial}`,
    discardUserImageCapture: () => {},
    findSendButton: () => controls.selector ? button : null,
    findStopButton: () => null,
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
    draftAttachmentEvidence: () => controls.image,
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
  context.pressButton = submit
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
    ...context.api, composer, controls, events, submissions, send, reply, flush, event,
    evaluate: script => vm.runInContext(script, context),
    onReport: listener => { context.report = event => { events.push(event); listener(event) } }
  }
}

function embed(livePage = null) {
  const exports = {}
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
      throw new Error(`Unexpected dependency: ${name}`)
    }
  })
  const instance = new exports.ChatGptEmbed({ id: 'fixture', homeUrl: 'https://example.invalid', page: {} }, {
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
  return { instance, configurations }
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
main().then(remaining).then(questionMarkdownChecks).then(questionChecks).then(cancelQuestionChecks).then(() => log('PASS all offline task-prompt checks; live website behavior still requires user testing'))
  .catch(error => { log(`FAIL ${error.stack || error}`); process.exitCode = 1 })
