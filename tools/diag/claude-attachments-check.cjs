/** The user runs these offline observer checks; no Electron, network or real files are inspected. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const vm = require('node:vm')
const Module = require('node:module')
const ts = require('typescript')
const capture = require('./claude-attachment-capture.cjs')
const directory = path.join(os.tmpdir(), 'gpt-login-diag')
fs.mkdirSync(directory, { recursive: true })
const logFile = path.join(directory, `claude-attachments-check-${Date.now()}.log`)
const log = line => { fs.appendFileSync(logFile, line + '\n'); console.log(line) }

function load(relative) {
  const file = path.resolve(__dirname, '../..', relative)
  const target = new Module(file, module)
  target.filename = file
  target.paths = Module._nodeModulePaths(path.dirname(file))
  target.require = function (request) {
    const local = path.resolve(path.dirname(file), request) + '.ts'
    return request.startsWith('.') && fs.existsSync(local) ? load(local) : Module.prototype.require.call(this, request)
  }
  target._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file)
  return target.exports
}

class Element {
  constructor(tag, attributes = {}, text = '', children = []) {
    this.tagName = tag.toUpperCase(); this.attrs = attributes; this.text = text; this.children = []
    this.className = attributes.class || ''; this.disabled = false; this.accept = ''; this.multiple = false; this.files = []; this.shown = true
    children.forEach(child => this.append(child))
  }
  append(child) { child.parentElement = this; this.children.push(child); return child }
  get attributes() { return Object.entries(this.attrs).map(([name, value]) => ({ name, value })) }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(' ') }
  get innerText() { return this.textContent }
  getAttribute(name) { return this.attrs[name] ?? null }
  getClientRects() { return this.shown ? [{}] : [] }
  contains(node) { return node === this || this.children.some(child => child.contains(node)) }
  matches(selector) {
    return selector.split(',').some(part => {
      let rule = part.trim()
      if (rule === '*') return true
      const tag = rule.match(/^[a-z]+/i)?.[0]
      if (tag) { if (this.tagName.toLowerCase() !== tag) return false; rule = rule.slice(tag.length) }
      const classRule = rule.match(/^\.([\w-]+)/)
      if (classRule) { if (!this.className.split(/\s+/).includes(classRule[1])) return false; rule = rule.slice(classRule[0].length) }
      const attributes = rule.match(/\[[^\]]+\]/g) || []
      if (attributes.join('') !== rule) return false
      return attributes.every(attribute => {
        const match = attribute.match(/^\[([^=*$~\]]+)(?:([*$~]?=)"([^"]*)")?\]$/)
        if (!match || !(match[1] in this.attrs)) return false
        const value = String(this.attrs[match[1]])
        return !match[2] || (match[2] === '*=' ? value.includes(match[3]) : match[2] === '$=' ? value.endsWith(match[3]) : match[2] === '~=' ? value.split(/\s+/).includes(match[3]) : value === match[3])
      })
    })
  }
  querySelectorAll(selector) { return this.children.flatMap(child => [child, ...child.querySelectorAll('*')]).filter(child => child.matches(selector)) }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null }
}

try {
  const { CLAUDE_PAGE: page } = load('src/shared/platforms.ts')
  const { fileReadingPlatform, toolPromptForPlatform } = load('src/shared/types.ts')
  assert.equal(fileReadingPlatform('claude').id, 'claude')
  assert.equal(toolPromptForPlatform('claude'), toolPromptForPlatform('chatgpt'))
  assert.doesNotMatch(toolPromptForPlatform('claude'), /Claude|ChatGPT|DeepSeek/)
  const privateText = 'PRIVATE_CONVERSATION_CONTENT'
  const privateLabel = 'PRIVATE_CARD_LABEL'
  const privateKey = 'PRIVATE_MESSAGE_UUID'
  const privateFile = 'PRIVATE_SELECTED_FILE.txt'
  const fileInput = new Element('input', { type: 'file', 'data-testid': 'file-upload-input' })
  fileInput.shown = false; fileInput.multiple = true; fileInput.accept = '.txt,.pdf,image/*'
  const composer = new Element('div', { contenteditable: 'true', 'data-testid': 'chat-input', role: 'textbox' }, privateText)
  const send = new Element('button', { 'data-testid': 'chat-input-send', 'aria-label': 'Send message' })
  const card = new Element('div', { 'data-testid': 'attachment-card', title: privateLabel }, 'sample.txt')
  const panel = new Element('form', {}, '', [card, composer, send, fileInput])
  const oldMessage = new Element('div', { 'data-testid': 'user-message', 'data-message-id': privateKey }, '', [new Element('span', {}, 'sample.txt')])
  const assistant = new Element('div', { 'data-testid': 'assistant-message' }, privateText)
  const thread = new Element('div', { 'data-testid': 'transcript-list' }, '', [oldMessage, assistant])
  const body = new Element('body', {}, '', [new Element('main', {}, '', [thread, panel])])
  const listeners = new Map()
  let mutationCallback
  let observerCount = 0
  class MutationObserver {
    constructor(callback) { mutationCallback = callback; observerCount++ }
    observe(target) { assert.equal(target, body) }
  }
  const document = { body, readyState: 'complete', querySelectorAll: selector => body.querySelectorAll(selector), addEventListener: (type, callback) => { assert.equal(listeners.has(type), false, 'Listener registered twice'); listeners.set(type, callback) } }
  const context = vm.createContext({ window: {}, document, MutationObserver, location: { origin: 'https://claude.ai', pathname: '/chat/PRIVATE_ROUTE_ID' }, getComputedStyle: () => ({ visibility: 'visible' }) })
  const inspect = () => vm.runInContext(`(${capture.toString()})(${JSON.stringify(page)},["sample.txt"])`, context)
  const first = inspect()
  assert.ok(first.composer)
  assert.equal(first.fileInputs[0].accept, fileInput.accept)
  assert.equal(first.fileInputs[0].multiple, true)
  assert.equal(first.fileInputs[0].visible, false)
  assert.equal(first.composerRegion.root.tag, 'form', 'Composer region must stop before conversation history')
  assert.equal(first.composerRegion.root.messageCount, 0)
  assert.ok(first.markers.some(marker => marker.marker === 'data-testid:attachment-card'))
  assert.ok(first.filenameNodes.some(node => node.ancestors.some(parent => parent.containsComposer && parent.messageCount === 0)))
  assert.ok(first.filenameNodes.some(node => node.ancestors.some(parent => parent.messageMatches.includes('[data-testid="user-message"]'))))
  assert.equal(listeners.size, 3)
  assert.equal(observerCount, 1)
  log('PASS shipped Claude descriptor, hidden native picker, composer/history boundary and draft/sent-card structure')

  const again = inspect()
  assert.equal(again.messages[0].nodeAlias, first.messages[0].nodeAlias)
  const previousKey = first.messages[0].attributes.find(attribute => attribute.name === 'data-message-id').keyAlias
  assert.equal(again.messages[0].attributes.find(attribute => attribute.name === 'data-message-id').keyAlias, previousKey)
  oldMessage.attrs['data-message-id'] = 'NEW_PRIVATE_MESSAGE_UUID'
  const recycled = inspect()
  assert.equal(recycled.messages[0].nodeAlias, first.messages[0].nodeAlias)
  assert.notEqual(recycled.messages[0].attributes.find(attribute => attribute.name === 'data-message-id').keyAlias, previousKey)
  context.location.pathname = '/chat/OTHER_PRIVATE_ROUTE'
  assert.notEqual(inspect().page.routeAlias, first.page.routeAlias)
  log('PASS stable node/key aliases, recycled DOM nodes and redacted conversation changes')

  fileInput.files = [{ name: privateFile, type: 'text/plain', size: 42 }]
  listeners.get('change')({ target: fileInput })
  fileInput.files = []
  listeners.get('click')({ target: send })
  listeners.get('keydown')({ target: composer, key: 'Enter', shiftKey: false, isComposing: false })
  const selected = inspect()
  assert.equal(selected.events.find(event => event.kind === 'file-selection').input.files[0].size, 42)
  assert.equal(selected.fileInputs[0].files.length, 0, 'Selection event survives FileList reset')
  assert.ok(selected.events.some(event => event.kind === 'composer-enter'))
  assert.ok(selected.events.some(event => event.kind === 'control-click' && event.control.controlTokens.includes('send')))
  assert.equal(inspect().events.length, 0, 'Events are drained once')
  panel.children = panel.children.filter(child => child !== composer)
  const replacement = panel.append(new Element('div', { contenteditable: 'true', 'data-testid': 'chat-input' }))
  inspect()
  listeners.get('keydown')({ target: replacement, key: 'Enter', shiftKey: true, isComposing: false })
  assert.ok(inspect().events.some(event => event.kind === 'composer-enter' && event.shift))
  log('PASS native FileList capture before reset, manual send observations and composer replacement without duplicate listeners')

  const progress = panel.append(new Element('div', { role: 'progressbar', 'aria-busy': 'true' }))
  mutationCallback()
  panel.children = panel.children.filter(child => child !== progress)
  mutationCallback()
  const transitions = inspect().events.filter(event => event.kind === 'upload-markers')
  assert.equal(transitions.length, 2)
  assert.ok(transitions[0].markers.some(node => node.attributes.some(attribute => attribute.semantic === 'progressbar')))
  assert.equal(transitions[1].markers.length, 0)
  assert.equal(observerCount, 1)
  log('PASS upload marker appears and disappears between polling ticks; observer installed once')

  const longName = 'long-attachment-diagnostic-example-document.txt'
  context.window.__claudeAttachmentProbe.names.push(longName)
  const shortened = panel.append(new Element('span', {}, 'long-attachment-diagnostic…txt'))
  const shortSnapshot = inspect()
  assert.ok(shortSnapshot.filenameNodes.some(node => node.truncatedNameCandidates.some(candidate => candidate.prefixLength >= 12 && candidate.ambiguous === false)))
  panel.children = panel.children.filter(child => child !== shortened)
  log('PASS truncated-name evidence includes indices/lengths without displayed or original names')

  const output = JSON.stringify([first, again, recycled, selected, shortSnapshot])
  for (const secret of [privateText, privateLabel, privateKey, privateFile, longName, 'long-attachment-diagnostic…txt', 'NEW_PRIVATE_MESSAGE_UUID', 'PRIVATE_ROUTE_ID', 'OTHER_PRIVATE_ROUTE']) assert.ok(!output.includes(secret), `Sensitive value leaked: ${secret}`)
  context.document = { ...document, querySelectorAll: () => [] }
  const noComposer = inspect()
  assert.equal(noComposer.composer, null)
  assert.equal(noComposer.fileInputs.length, 0)
  assert.equal(noComposer.messages.length, 0)
  log('PASS conversation/file/label/key/route values excluded; no-composer page yields missing evidence')
  log('DONE offline observer checks only; live Claude upload behavior still requires the user-driven probe')
} catch (error) {
  log('FAIL ' + error.stack)
  process.exitCode = 1
} finally { console.log(`日志：${logFile}`) }
