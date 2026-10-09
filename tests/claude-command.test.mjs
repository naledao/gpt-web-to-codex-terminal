// User-run offline regression tests: the actual injected script runs in a VM with
// synthetic DOM nodes and timers. No Electron, browser session, network or shell.
// Run from the repository root: node --test tests/claude-command.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'

const interceptorSource = readFileSync(new URL('../src/main/injected/send-interceptor.js', import.meta.url), 'utf8')
const platformSource = readFileSync(new URL('../src/shared/platforms.ts', import.meta.url), 'utf8')
const platformExports = {}
new Script(ts.transpileModule(platformSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText).runInNewContext({
  exports: platformExports,
  require(name) {
    assert.equal(name, './types')
    // Conversation URL validation is outside these page-adapter tests.
    return { isConversationId() { throw new Error('Unexpected conversation validation') } }
  }
})
const { CLAUDE_PAGE, DEEPSEEK_PAGE } = platformExports

class ElementFixture {
  nodeType = 1
  isConnected = true
  parentElement = null
  position = 0

  constructor(tag, attributes = {}, content = []) {
    this.tagName = tag.toUpperCase()
    this.attributes = attributes
    this.childNodes = (Array.isArray(content) ? content : [content]).map((child) =>
      typeof child === 'string' ? { nodeType: 3, nodeValue: child } : child
    )
    for (const child of this.childNodes) child.parentElement = this
  }

  get className() { return this.attributes.class || '' }
  get textContent() { return this.childNodes.map((child) => child.nodeType === 3 ? child.nodeValue : child.textContent).join('') }
  get innerText() { return this.textContent }
  getAttribute(name) { return this.attributes[name] ?? null }
  getClientRects() { return [{}] }
  compareDocumentPosition(other) { return this.position < other.position ? 4 : this.position > other.position ? 2 : 0 }

  matches(selector) {
    if (selector.includes(',')) return selector.split(',').some((part) => this.matches(part.trim()))
    if (/^[a-z]+$/i.test(selector)) return this.tagName.toLowerCase() === selector.toLowerCase()
    if (/^\.[\w-]+$/.test(selector)) return this.className.split(/\s+/).includes(selector.slice(1))
    const match = /^(\w+)?\[([\w-]+)(?:([*^$]?=)"([^"]*)")?\]$/.exec(selector)
    if (!match || (match[1] && this.tagName.toLowerCase() !== match[1])) return false
    const value = this.getAttribute(match[2])
    if (value === null) return false
    if (!match[3]) return true
    if (match[3] === '*=') return value.includes(match[4])
    if (match[3] === '^=') return value.startsWith(match[4])
    if (match[3] === '$=') return value.endsWith(match[4])
    return value === match[4]
  }

  descendants() {
    return this.childNodes.filter((child) => child.nodeType === 1).flatMap((child) => [child, ...child.descendants()])
  }

  querySelectorAll(selector) { return this.descendants().filter((node) => node.matches(selector)) }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
  closest(selector) {
    for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node
    return null
  }
  contains(other) { return this === other || this.descendants().includes(other) }
}

const element = (tag, attributes, content) => new ElementFixture(tag, attributes, content)
const commandJson = (command = 'uname -a') => JSON.stringify({ command, description: '查看系统信息', timeout_seconds: 30 })
const codeReply = (command = 'uname -a') => element('div', { 'data-testid': 'assistant-message', class: 'group/message-row' }, [
  element('span', { class: 'sr-only' }, 'Claude responded: '),
  element('pre', {}, [element('code', {}, commandJson(command))])
])

function fixture(nodes, page = CLAUDE_PAGE) {
  const events = []
  const timers = new Map()
  let timerSerial = 0
  let notifyMutation
  const body = element('body', {}, nodes)
  const window = {}
  const refreshPositions = () => {
    ;[body, ...body.descendants()].forEach((node, index) => { node.position = index })
  }
  const document = {
    body,
    activeElement: null,
    addEventListener() {},
    querySelectorAll(selector) { refreshPositions(); return body.querySelectorAll(selector) },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
  }
  new Script(interceptorSource).runInNewContext({
    window, document,
    location: { pathname: '/chat/offline-fixture' },
    Element: ElementFixture,
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3, DOCUMENT_POSITION_FOLLOWING: 4, DOCUMENT_POSITION_PRECEDING: 2 },
    MutationObserver: class {
      constructor(callback) { notifyMutation = callback }
      observe() {}
    },
    getComputedStyle: () => ({ visibility: 'visible' }),
    setTimeout(callback, delay) { const id = ++timerSerial; timers.set(id, { callback, delay }); return id },
    clearTimeout(id) { timers.delete(id) },
    console: { log(line) { events.push(JSON.parse(line.slice('[cmd-terminal] '.length))) } }
  })
  const controller = window.__cmdTerminalInterceptor
  controller.configure({ enabled: true, page })
  return {
    controller, events,
    commands: () => events.filter((event) => event.event === 'command'),
    replaceNodes(next) {
      body.childNodes = next
      for (const node of next) node.parentElement = body
    },
    scan() {
      notifyMutation()
      // Run just the reply-settle timers; never use wall-clock waits or send handlers.
      for (const [id, timer] of [...timers]) {
        if (timer.delay !== 800) continue
        timers.delete(id)
        timer.callback()
      }
    }
  }
}

test('Claude code-only JSON is detected without its usual answer font class', () => {
  const command = "printf '%s\\n' 'hello'; uname -a"
  const app = fixture([codeReply(command)])
  app.controller.checkNow()
  assert.equal(app.commands().length, 1)
  assert.equal(app.commands()[0].command, command)
  assert.equal(app.commands()[0].description, '查看系统信息')
  assert.equal(app.commands()[0].timeoutSeconds, 30)
  assert.equal(app.commands()[0].live, true)
  app.scan()
  assert.equal(app.commands().length, 1, 'repeated DOM scans must not report the command again')
})

test('the preferred answer container still excludes surrounding command-shaped text', () => {
  const answer = element('div', { class: 'font-claude-response' }, commandJson('pwd'))
  const reply = element('div', { 'data-testid': 'assistant-message' }, [
    commandJson('unrelated-before'), answer, commandJson('unrelated-after')
  ])
  const app = fixture([reply])
  app.controller.checkNow()
  assert.equal(app.commands()[0].command, 'pwd')
})

test('an answer marker on the turn itself also works', () => {
  const reply = element('div', { 'data-testid': 'assistant-message', class: 'font-claude-response' }, commandJson('pwd'))
  const app = fixture([reply])
  app.controller.checkNow()
  assert.equal(app.commands()[0].command, 'pwd')
})

test('explicit assistant roles exclude user turns even with answer-like descendants', () => {
  const user = element('div', { 'data-testid': 'user-message' }, [
    element('div', { class: 'font-claude-response' }, commandJson('user-input'))
  ])
  // Broaden discovery deliberately to exercise the role check independently.
  const app = fixture([user], { ...CLAUDE_PAGE, assistantSelectors: CLAUDE_PAGE.messageSelectors })
  app.controller.checkNow()
  assert.equal(app.commands().length, 0)
  assert.ok(app.events.some((event) => event.reason === 'not-assistant-turn'))
})

test('a code-only reply waits for generation to stop before being reported', () => {
  const reply = codeReply()
  const stop = element('button', { 'aria-label': 'Stop response' })
  const app = fixture([reply, stop])
  app.controller.checkNow()
  assert.equal(app.commands().length, 0)
  assert.ok(app.events.some((event) => event.reason === 'still-generating'))
  app.replaceNodes([reply])
  app.scan()
  assert.equal(app.commands().length, 1)
  assert.equal(app.commands()[0].live, true)
})

test('restored Claude replies remain history rather than live commands', () => {
  const app = fixture([codeReply()])
  app.controller.armBaseline()
  app.scan()
  assert.equal(app.commands().length, 1)
  assert.equal(app.commands()[0].live, false)
})

test('terminal mode off suppresses a recognized code-only command', () => {
  const app = fixture([codeReply()])
  app.controller.configure({ enabled: false })
  app.controller.checkNow()
  assert.equal(app.commands().length, 0)
  assert.ok(app.events.some((event) => event.reason === 'terminal-mode-off'))
})

test('reconfiguration clears Claude roles and retains DeepSeek answer-based recognition', () => {
  const user = element('div', { 'data-virtual-list-item-key': 'user' }, commandJson('user-input'))
  const app = fixture([user])
  app.controller.configure({ page: DEEPSEEK_PAGE })
  app.controller.checkNow()
  assert.equal(app.commands().length, 0)
  const reply = element('div', { 'data-virtual-list-item-key': 'assistant' }, [
    element('div', { class: 'ds-assistant-message-main-content' }, commandJson('pwd'))
  ])
  app.replaceNodes([reply])
  app.scan()
  assert.equal(app.commands().length, 1)
  assert.equal(app.commands()[0].command, 'pwd')
})
