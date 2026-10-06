/** User-run offline observer checks. Fixtures are synthetic; they do not prove Gemini's live attachment markup. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const vm = require('node:vm')
const Module = require('node:module')
const ts = require('typescript')
const capture = require('./attachment-capture.cjs')
const describeRequest = require('./gemini-attachment-network.cjs')
const directory = path.join(os.tmpdir(), 'gpt-login-diag')
fs.mkdirSync(directory, { recursive: true })
const logFile = path.join(directory, `gemini-attachments-check-${Date.now()}.log`)
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
  constructor(tag, attrs = {}, text = '', children = []) {
    this.tagName = tag.toUpperCase(); this.attrs = attrs; this.text = text; this.children = []
    this.className = attrs.class || ''; this.disabled = false; this.accept = ''; this.multiple = false; this.files = []; this.shown = true
    children.forEach(child => this.append(child))
  }
  append(child) { child.parentElement = this; this.children.push(child); return child }
  remove() { this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null }
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
      const tag = rule.match(/^[a-z][a-z0-9-]*/i)?.[0]
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
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null }
  click() { throw new Error('Observer must not click') }
  dispatchEvent() { throw new Error('Observer must not submit or select files') }
}

try {
  const { GEMINI_PLATFORM: platform } = load('src/shared/platforms.ts')
  const { fileReadingPlatform } = load('src/shared/types.ts')
  assert.equal(platform.partition, 'persist:gemini')
  assert.equal(fileReadingPlatform('gemini').id, 'gemini', 'Gemini is enabled after both user-driven attachment captures')
  const page = platform.page
  const privateText = 'PRIVATE_CONVERSATION_CONTENT'
  const privateLabel = 'PRIVATE_ATTACHMENT_LABEL'
  const privateId = 'message-content-id-r_PRIVATE_MESSAGE_ID'
  const privateFile = 'PRIVATE_SELECTED_FILE.txt'
  const samples = ['sample.txt', 'sample.js', 'sample.png', 'sample.pdf', 'hosts', '样本 空格.md', 'long-attachment-diagnostic-example-document.txt']
  const fileInput = new Element('input', { type: 'file' })
  fileInput.shown = false; fileInput.multiple = true; fileInput.accept = '.txt,.pdf,image/*'
  const composer = new Element('div', { class: 'ql-editor textarea new-input-ui', contenteditable: 'true' }, '')
  const send = new Element('button', { 'aria-label': '发送', 'aria-disabled': 'true' })
  const menu = new Element('div', { role: 'menu' }, '', [new Element('button', {}, 'Upload from computer'), new Element('button', {}, 'Google Drive')])
  const draftCard = new Element('file-preview-fixture', { title: privateLabel }, '', [new Element('span', {}, samples[0]), new Element('button', { 'aria-label': 'Remove file' })])
  const panel = new Element('form', {}, '', [draftCard, new Element('rich-textarea', {}, '', [composer]), send, fileInput])
  const oldQuery = new Element('user-query', { id: 'PRIVATE_OLD_USER_ID' }, '', [new Element('file-preview-fixture', {}, samples[0])])
  const response = new Element('message-content', { id: privateId }, privateText)
  const assistant = new Element('model-response', {}, '', [response])
  const body = new Element('body', {}, '', [new Element('main', {}, '', [new Element('section', {}, '', [oldQuery, assistant]), panel]), menu])
  const listeners = new Map()
  let mutationCallback
  let observerCount = 0
  class MutationObserver {
    constructor(callback) { mutationCallback = callback; observerCount++ }
    observe(target, options) { assert.equal(target, body); assert.ok(options.attributeFilter.includes('class')) }
  }
  const document = { body, readyState: 'complete', querySelectorAll: selector => body.querySelectorAll(selector), getElementById: id => body.querySelectorAll('[id]').find(node => node.getAttribute('id') === id) || null, addEventListener: (type, callback) => { assert.equal(listeners.has(type), false, 'Listener registered twice'); listeners.set(type, callback) } }
  const context = vm.createContext({ window: {}, document, MutationObserver, location: { origin: 'https://gemini.google.com', pathname: '/app/PRIVATE_CONVERSATION_ID' }, getComputedStyle: () => ({ visibility: 'visible' }) })
  const script = `(${capture.toString()})(${JSON.stringify(page)},${JSON.stringify(samples)},{"platformId":"gemini"})`
  new vm.Script(script)
  const inspect = () => vm.runInContext(script, context)
  const first = inspect()
  assert.equal(first.composer.tag, 'div')
  assert.equal(first.composer.draftEmpty, true)
  assert.equal(first.page.pathKind, 'conversation')
  assert.equal(first.fileInputs[0].multiple, true)
  assert.equal(first.fileInputs[0].visible, false)
  assert.equal(first.fileInputs[0].accept, fileInput.accept)
  assert.equal(first.composerRegion.root.tag, 'form')
  assert.equal(first.composerRegion.root.messageCount, 0)
  assert.equal(first.sendControls[0].disabled, true)
  assert.ok(first.customTags.some(row => row.tag === 'rich-textarea'))
  assert.ok(first.menus[0].tree.nodes.some(node => node.controlTokens.includes('computer')))
  assert.ok(first.messages.find(node => node.tag === 'model-response').assistant)
  assert.ok(first.filenameNodes.some(node => node.ancestors.some(parent => parent.messageMatches.includes('user-query'))))
  assert.ok(first.filenameNodes.some(node => node.ancestors.some(parent => parent.containsComposer && parent.messageCount === 0)))
  log('PASS shipped Gemini descriptor, Quill empty draft, hidden input, local/Drive menu, disabled send, nested assistant and attachment-only user discovery')

  const again = inspect()
  const message = first.messages.find(node => node.tag === 'message-content')
  const stableMessage = again.messages.find(node => node.tag === 'message-content')
  const idAlias = node => node.attributes.find(attribute => attribute.name === 'id').keyAlias
  assert.equal(stableMessage.nodeAlias, message.nodeAlias)
  assert.equal(idAlias(stableMessage), idAlias(message))
  response.attrs.id = 'PRIVATE_NEW_MESSAGE_ID'
  const recycled = inspect()
  const recycledMessage = recycled.messages.find(node => node.tag === 'message-content')
  assert.equal(recycledMessage.nodeAlias, message.nodeAlias)
  assert.notEqual(idAlias(recycledMessage), idAlias(message))
  context.location.pathname = '/app/PRIVATE_OTHER_CONVERSATION_ID'
  assert.notEqual(inspect().page.routeAlias, first.page.routeAlias)
  context.location.pathname = '/app'
  assert.equal(inspect().page.pathKind, 'new')
  log('PASS HTML id aliases, stable/recycled nodes and redacted Gemini conversation/new-chat routes')

  fileInput.files = [{ name: privateFile, type: 'text/plain', size: 42 }]
  listeners.get('change')({ target: fileInput })
  fileInput.files = []
  send.attrs['aria-disabled'] = 'false'
  listeners.get('click')({ target: send })
  listeners.get('keydown')({ target: composer, key: 'Enter', shiftKey: false, isComposing: false })
  const selected = inspect()
  assert.equal(selected.events.find(event => event.kind === 'file-selection').input.files[0].size, 42)
  assert.equal(selected.fileInputs[0].files.length, 0)
  assert.ok(selected.events.some(event => event.kind === 'control-click' && event.control.controlTokens.includes('发送')))
  assert.ok(selected.events.some(event => event.kind === 'composer-enter'))
  assert.equal(inspect().events.length, 0)
  const editorRoot = composer.parentElement
  composer.remove()
  const replacement = editorRoot.append(new Element('div', { class: 'ql-editor', contenteditable: 'true' }, privateText))
  inspect()
  listeners.get('keydown')({ target: replacement, key: 'Enter', shiftKey: true, isComposing: false })
  assert.ok(inspect().events.some(event => event.kind === 'composer-enter' && event.shift))
  assert.equal(listeners.size, 3)
  assert.equal(observerCount, 1)
  log('PASS native selection before FileList reset, manual submit evidence and composer remount without repeated listeners')

  fileInput.files = samples.slice(1, 4).map((name, index) => ({ name, type: ['text/plain', 'image/png', 'application/pdf'][index], size: 100 + index }))
  listeners.get('change')({ target: fileInput })
  fileInput.files = []
  const mixedCards = samples.slice(1, 4).map(name => panel.append(new Element('file-preview-fixture', {}, name)))
  const mixed = inspect()
  const batch = mixed.events.find(event => event.kind === 'file-selection').input.files
  assert.equal(batch.length, 3)
  assert.deepEqual(Array.from(batch, file => file.nameIndex), [1, 2, 3])
  const jsCard = mixed.filenameNodes.find(node => node.textNameMatches.includes(1) && node.tag === 'file-preview-fixture')
  assert.ok(jsCard)
  mixedCards[0].remove()
  assert.equal(inspect().filenameNodes.some(node => node.textNameMatches.includes(1)), false)
  mixedCards[0] = panel.append(new Element('file-preview-fixture', {}, samples[1]))
  const restored = inspect().filenameNodes.find(node => node.textNameMatches.includes(1) && node.tag === 'file-preview-fixture')
  assert.notEqual(restored.nodeAlias, jsCard.nodeAlias)
  mixedCards.forEach(card => card.remove())
  log('PASS three-file metadata capture, removal and re-add with distinct preview-node aliases')

  const spinner = panel.append(new Element('mat-spinner'))
  mutationCallback()
  spinner.remove()
  mutationCallback()
  const transitions = inspect().events.filter(event => event.kind === 'upload-markers')
  assert.equal(transitions.length, 2)
  assert.ok(transitions[0].markers.some(node => node.tag === 'mat-spinner'))
  assert.equal(transitions[1].markers.length, 0)
  const alert = panel.append(new Element('div', { role: 'alert' }, 'Unsupported file'))
  const failure = inspect()
  assert.ok(failure.statusNodes.some(node => node.statusTokens.includes('unsupported')))
  alert.remove()
  log('PASS transient Angular/ARIA status discovery and unsupported-file semantics without error text')

  const image = draftCard.append(new Element('img', { alt: samples[5], src: 'https://storage.googleapis.com/PRIVATE_IMAGE?token=PRIVATE_TOKEN' }))
  const shortened = draftCard.append(new Element('span', {}, 'long-attachment-diagnostic…txt'))
  const labels = inspect()
  assert.ok(labels.filenameNodes.some(node => node.labelNameMatches.includes(5)))
  assert.ok(labels.filenameNodes.some(node => node.truncatedNameCandidates.some(candidate => candidate.index === 6)))
  image.remove(); shortened.remove()
  const newQuery = oldQuery.parentElement.append(new Element('user-query', { id: 'PRIVATE_NEW_USER_ID' }, '', [new Element('file-preview-fixture', {}, samples[0])]))
  const repeated = inspect()
  const users = repeated.messages.filter(node => node.tag === 'user-query')
  assert.equal(users.length, 2)
  assert.notEqual(users[0].nodeAlias, users[1].nodeAlias)
  assert.notEqual(idAlias(users[0]), idAlias(users[1]))
  assert.equal(users[0].textNameMatches[0], users[1].textNameMatches[0])
  assert.ok(newQuery.textContent.includes(samples[0]))
  log('PASS repeated-name sent cards, Chinese/space filename labels and truncated-name indices without raw values')

  // Native roots below come from the 2026-10-06 user capture. Deep fixtures
  // exercise the observer's former depth gap, not production readiness rules.
  const wrap = (child, levels) => {
    for (let level = 0; level < levels; level++) child = new Element('div', {}, '', [child])
    return child
  }
  const flatten = node => [node, ...(node.nodes || []).flatMap(flatten)]
  const tooltip = body.append(new Element('div', { id: 'PRIVATE_TOOLTIP_ID', role: 'tooltip' }, samples[0]))
  tooltip.shown = false
  const nativeCard = panel.append(new Element('uploader-file-preview', {}, '', [
    new Element('div', { class: 'file-preview-container', 'aria-describedby': 'PRIVATE_TOOLTIP_ID PRIVATE_MISSING_REFERENCE' }, '', [
      wrap(new Element('gem-attachment', {}, '', [new Element('span', {}, 'sample'), new Element('span', {}, 'TXT')]), 6)
    ])
  ]))
  const draftImage = new Element('img', { src: 'blob:https://gemini.google.com/PRIVATE_BLOB_ID' })
  Object.assign(draftImage, { width: 64, height: 64, naturalWidth: 64, naturalHeight: 64, complete: true })
  const nativeMedia = panel.append(new Element('uploader-file-preview', {}, '', [wrap(new Element('gem-media-attachment', {}, '', [draftImage]), 6)]))
  const sentImage = new Element('img', { src: 'https://storage.googleapis.com/PRIVATE_SENT_IMAGE?token=PRIVATE_IMAGE_TOKEN' })
  Object.assign(sentImage, { width: 64, height: 64, naturalWidth: 64, naturalHeight: 64, complete: true })
  const carousel = newQuery.append(new Element('user-query-file-carousel', {}, '', [
    wrap(new Element('user-query-file-preview', {}, '', [new Element('div', { 'data-test-id': 'uploaded-file' }, '', [new Element('button', { 'aria-label': samples[3] })])]), 6),
    wrap(new Element('user-query-file-preview', {}, '', [sentImage]), 6)
  ]))
  const assistantCarousel = assistant.append(new Element('user-query-file-carousel', {}, '', [new Element('img', { src: 'data:image/png;base64,PRIVATE_ASSISTANT_IMAGE' })]))
  const deepCards = inspect()
  assert.equal(deepCards.attachmentDetails.draft.length, 2)
  assert.equal(deepCards.attachmentDetails.sent.length, 1, 'Exclude carousels outside user-query')
  const draftNodes = deepCards.attachmentDetails.draft.flatMap(row => flatten(row.tree))
  const splitStem = draftNodes.find(node => node.tag === 'span' && node.namePartMatches.some(match => match.index === 0 && match.stemMatch))
  const splitExtension = draftNodes.find(node => node.tag === 'span' && node.namePartMatches.some(match => match.index === 0 && match.extensionMatch))
  assert.ok(splitStem && splitExtension, 'Capture split basename/extension below the old five-level depth limit')
  assert.equal(splitStem.textNameMatches.length, 0)
  const refs = draftNodes.find(node => node.references.length === 2).references
  assert.equal(refs[0].found, true)
  assert.equal(refs[0].visible, false)
  assert.deepEqual(Array.from(refs[0].textNameMatches), [0])
  assert.equal(refs[1].found, false)
  assert.equal(refs[0].keyAlias, deepCards.filenameNodes.find(node => node.tag === 'div' && node.attributes.some(attr => attr.semantic === 'tooltip')).attributes.find(attr => attr.name === 'id').keyAlias)
  assert.equal(draftNodes.find(node => node.tag === 'img').image.sourceKind, 'blob')
  assert.equal(draftNodes.find(node => node.tag === 'img').image.naturalWidth, 64)
  const sentNodes = flatten(deepCards.attachmentDetails.sent[0].tree)
  assert.ok(sentNodes.some(node => node.labelNameMatches?.includes(3)))
  assert.equal(sentNodes.find(node => node.tag === 'img').image.sourceKind, 'http')
  assert.ok(deepCards.attachmentDetails.sent[0].ancestors.some(node => node.tag === 'user-query'))
  tooltip.remove()
  const missingTooltip = inspect()
  const missingRefs = missingTooltip.attachmentDetails.draft.flatMap(row => flatten(row.tree)).find(node => node.references.length === 2).references
  assert.equal(missingRefs[0].found, false)
  assert.equal(missingRefs[0].keyAlias, refs[0].keyAlias)
  nativeCard.remove(); nativeMedia.remove(); carousel.remove(); assistantCarousel.remove()
  log('PASS deep native draft/sent card trees, linked/missing tooltip aliases, split names and scoped image dimensions/source categories')

  const transientInput = menu.append(new Element('input', { type: 'file', 'aria-hidden': 'true' }))
  transientInput.multiple = true
  mutationCallback()
  transientInput.remove()
  mutationCallback()
  const inputLifecycle = inspect()
  const inputEvents = inputLifecycle.events.filter(event => event.kind === 'file-inputs')
  assert.equal(inputEvents.length, 2, 'Capture native inputs created and removed between polling ticks')
  assert.equal(inputEvents[0].inputs.length, 2)
  assert.equal(inputEvents[1].inputs.length, 1)
  assert.equal(inputEvents[1].inputs[0].nodeAlias, first.fileInputs[0].nodeAlias)
  assert.equal(observerCount, 1)
  assert.equal(listeners.size, 3)
  log('PASS transient file-input lifecycle without repeated observers/listeners or native chooser actions')

  const upload = describeRequest({
    url: 'https://content-push.googleapis.com/upload/PRIVATE_FILENAME?token=PRIVATE_UPLOAD_TOKEN', method: 'POST', resourceType: 'xhr',
    requestHeaders: { 'Cookie': 'SID=PRIVATE_COOKIE', 'Content-Type': 'application/x-www-form-urlencoded', 'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'upload, finalize', 'X-Goog-Upload-Offset': 'PRIVATE_OFFSET', 'X-Goog-Upload-URL': 'PRIVATE_UPLOAD_URL' }
  })
  assert.equal(upload.observe, true)
  assert.equal(upload.googleService, true)
  assert.equal(upload.firstParty, false)
  assert.equal(upload.resumableUpload, true)
  assert.equal(upload.uploadCommand, 'upload,finalize')
  assert.equal(describeRequest({ url: 'https://gemini.google.com/_/rpc', method: 'POST' }).observe, true)
  assert.equal(describeRequest({ url: 'https://storage.googleapis.com/opaque', method: 'PUT' }).observe, true)
  assert.equal(describeRequest({ url: 'https://gstatic.com/static.js', method: 'GET' }).observe, false)
  assert.equal(describeRequest({ url: 'invalid' }).observe, false)
  const hostileHeaders = describeRequest({ url: 'https://gemini.google.com/app', method: 'POST', resourceType: 'PRIVATE_RESOURCE', requestHeaders: { 'X-Goog-Upload-Command': 'PRIVATE_COMMAND', 'X-Goog-Upload-Protocol': 'PRIVATE_PROTOCOL' } })
  assert.equal(hostileHeaders.uploadCommand, '')
  assert.equal(hostileHeaders.uploadProtocol, '')
  assert.equal(hostileHeaders.resourceType, 'other')
  log('PASS Google resumable/PUT/RPC classification and allowlisted request metadata; no network accessed')

  const output = JSON.stringify([first, again, recycled, selected, failure, labels, repeated, deepCards, missingTooltip, inputLifecycle, upload, hostileHeaders])
  for (const secret of [privateText, privateLabel, privateId, privateFile, ...samples, 'long-attachment-diagnostic…txt', 'PRIVATE_OLD_USER_ID', 'PRIVATE_NEW_MESSAGE_ID', 'PRIVATE_NEW_USER_ID', 'PRIVATE_CONVERSATION_ID', 'PRIVATE_OTHER_CONVERSATION_ID', 'PRIVATE_IMAGE', 'PRIVATE_TOKEN', 'PRIVATE_FILENAME', 'PRIVATE_UPLOAD_TOKEN', 'PRIVATE_COOKIE', 'PRIVATE_OFFSET', 'PRIVATE_UPLOAD_URL', 'PRIVATE_COMMAND', 'PRIVATE_PROTOCOL', 'PRIVATE_RESOURCE', 'PRIVATE_TOOLTIP_ID', 'PRIVATE_MISSING_REFERENCE', 'PRIVATE_BLOB_ID', 'PRIVATE_SENT_IMAGE', 'PRIVATE_IMAGE_TOKEN', 'PRIVATE_ASSISTANT_IMAGE']) assert.ok(!output.includes(secret), `Sensitive value leaked: ${secret}`)
  context.document = { ...document, querySelectorAll: () => [] }
  const noComposer = inspect()
  assert.equal(noComposer.composer, null)
  assert.equal(noComposer.fileInputs.length, 0)
  assert.equal(noComposer.messages.length, 0)
  assert.ok(context.window.__geminiAttachmentProbe)
  assert.equal(context.window.__claudeAttachmentProbe, undefined)
  assert.equal(require('./claude-attachment-capture.cjs'), capture, 'Claude retains the same standalone serialized observer')
  log('PASS no draft/file/label/key/route/URL/cookie-value leakage, no-composer pages and isolated observer state')
  log('DONE offline observer checks only; automatic Gemini delivery still requires user application testing')
} catch (error) {
  log('FAIL ' + error.stack)
  process.exitCode = 1
} finally { console.log(`日志：${logFile}`) }
