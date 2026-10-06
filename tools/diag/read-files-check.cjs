/** Offline checks: the user runs this script; it does not start Electron or access the network. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const Module = require('node:module')
const vm = require('node:vm')
const ts = require('typescript')

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
const { parseReadFilesRequest } = load('src/shared/file-requests.ts')
const { prepareFiles, resolveFilePath, MAX_FILE_BYTES } = load('src/main/file-access.ts')
const { sendPageFiles } = load('src/main/page-files.ts')
const { toolPromptForPlatform, fileReadingPlatform } = load('src/shared/types.ts')
const { CHATGPT_PAGE, DEEPSEEK_PAGE, CLAUDE_PAGE, GEMINI_PAGE } = load('src/shared/platforms.ts')
// Keep the existing sender regressions on ChatGPT and exercise DeepSeek separately.
const sendChatGptFiles = (page, ...args) => sendPageFiles(page, 'chatgpt', ...args)
const { EventEmitter } = require('node:events')
const logDir = path.join(os.tmpdir(), 'gpt-login-diag')
fs.mkdirSync(logDir, { recursive: true })
const logFile = path.join(logDir, `read-files-check-${Date.now()}.log`)
const log = text => { fs.appendFileSync(logFile, text + '\n'); console.log(text) }

async function main() {
  assert.equal(toolPromptForPlatform('chatgpt'), toolPromptForPlatform('deepseek'))
  assert.equal(toolPromptForPlatform('chatgpt'), toolPromptForPlatform('claude'))
  assert.equal(toolPromptForPlatform('chatgpt'), toolPromptForPlatform('gemini'))
  for (const platform of ['chatgpt', 'deepseek', 'claude', 'gemini']) {
    assert.match(toolPromptForPlatform(platform), /^【工具：read_files】/)
    assert.doesNotMatch(toolPromptForPlatform(platform), /ChatGPT|DeepSeek|Claude|Gemini/)
    assert.match(toolPromptForPlatform(platform), /files 为 1–3 个/)
    assert.match(toolPromptForPlatform(platform), /每次 1–3 个非空普通文件/)
  }
  assert.equal(toolPromptForPlatform('unadapted'), '')
  assert.equal(fileReadingPlatform('unadapted'), null)
  const injectedSource = fs.readFileSync(path.resolve(__dirname, '../../src/main/injected/send-interceptor.js'), 'utf8')
  new vm.Script(injectedSource)
  // Exercise the actual injected picker without starting the page or Electron.
  const pickerStart = injectedSource.indexOf('  const chooseAttachmentInput =')
  const pickerEnd = injectedSource.indexOf('  const findAttachmentInput =', pickerStart)
  assert.ok(pickerStart >= 0 && pickerEnd > pickerStart, 'Attachment picker not found')
  const chooseInput = vm.runInNewContext(injectedSource.slice(pickerStart, pickerEnd) + '\nchooseAttachmentInput')
  const image = { fileName: '上传.PNG', mimeType: 'image/png' }
  const textFile = { fileName: 'sample.txt', mimeType: 'text/plain' }
  const mediaInput = { accept: 'image/*,video/*', multiple: true, disabled: false }
  const imageInput = { accept: 'image/*', multiple: true, disabled: false }
  const generalInput = { accept: '', multiple: true, disabled: false }
  const observedInputs = [mediaInput, imageInput, generalInput]
  assert.equal(chooseInput([image], observedInputs, observedInputs), generalInput)
  assert.equal(chooseInput([image], observedInputs.toReversed(), observedInputs), generalInput)
  assert.equal(chooseInput([image, textFile], observedInputs, observedInputs), generalInput)
  assert.equal(chooseInput([image], [], observedInputs), generalInput)
  assert.equal(chooseInput([image], [imageInput], observedInputs), imageInput)
  assert.equal(chooseInput([image], [mediaInput, imageInput], observedInputs), null)
  assert.equal(chooseInput([image], [generalInput, { ...generalInput }], []), null)
  assert.equal(chooseInput([image], [{ ...generalInput, disabled: true }], []), null)
  assert.equal(chooseInput([image, textFile], [{ ...generalInput, multiple: false }], []), null)
  const extensionInput = { accept: '.png', multiple: false, disabled: false }
  assert.equal(chooseInput([image], [extensionInput], []), extensionInput)
  assert.equal(chooseInput([textFile], [extensionInput], []), null)
  log('PASS observed three-input regression, composer scoping, batch support and ambiguous-input rejection')
  // Exercise the real scope/text extraction too. A toolbar-only root and removing
  // all clickable cards both miss the file even though upload has completed.
  class Element {
    constructor(tag, attributes = {}, text = '', children = []) {
      this.tagName = tag.toUpperCase(); this.attributes = attributes; this.text = text; this.children = children
      this.shown = true
      children.forEach(child => { child.parentElement = this })
    }
    get textContent() { return this.text + this.children.map(child => child.textContent).join(' ') }
    getClientRects() { return this.shown ? [{}] : [] }
    getAttribute(name) { return this.attributes[name] ?? null }
    matches(selector) {
      return selector.split(',').some(raw => {
        const rule = raw.trim()
        const classRule = rule.match(/^([a-z][a-z0-9-]*)?\.([\w-]+)$/i)
        if (classRule) return (!classRule[1] || this.tagName.toLowerCase() === classRule[1]) && String(this.attributes.class || '').split(/\s+/).includes(classRule[2])
        const negation = rule.match(/^(.*):not\(([^)]+)\)$/)
        if (negation) return this.matches(negation[1]) && !this.matches(negation[2])
        const tagged = rule.match(/^([a-z][a-z0-9-]*)(\[.*)$/i)
        if (tagged) return this.tagName.toLowerCase() === tagged[1].toLowerCase() && this.matches(tagged[2])
        if (!rule.startsWith('[')) return this.tagName.toLowerCase() === rule
        const parts = rule.match(/\[[^\]]+\]/g)
        if (!parts || parts.join('') !== rule) return false
        return parts.every(part => {
          const match = part.match(/^\[([^=$*^~\]]+)(?:([$*^~]?=)"([^"]*)")?\]$/)
          if (!match || !(match[1] in this.attributes)) return false
          const value = String(this.attributes[match[1]])
          return !match[2] || (match[2] === '=' ? value === match[3] : match[2] === '$=' ? value.endsWith(match[3]) : match[2] === '^=' ? value.startsWith(match[3]) : match[2] === '~=' ? value.split(/\s+/).includes(match[3]) : value.includes(match[3]))
        })
      })
    }
    querySelectorAll(selector) { return this.children.flatMap(child => [child, ...child.querySelectorAll('*')]).filter(child => selector === '*' || child.matches(selector)) }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
    closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null }
    contains(node) { return this === node || this.children.some(child => child.contains(node)) }
    cloneNode() { return new Element(this.tagName, { ...this.attributes }, this.text, this.children.map(child => child.cloneNode())) }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this) }
  }
  const editor = new Element('textarea', {}, 'private draft')
  const toolbar = new Element('div', {}, '', [editor, new Element('button'), new Element('div', { role: 'button' })])
  const card = new Element('div', { role: 'button', title: 'full-document-name.md' }, 'codex_can_do.md')
  const panel = new Element('div', {}, '', [card, toolbar])
  const history = new Element('div', { 'data-virtual-list-item-key': '4' }, 'old-history-file.md')
  const layout = new Element('div', {}, '', [history, panel])
  const body = new Element('body', {}, '', [layout])
  const scopeContext = {
    PAGE: DEEPSEEK_PAGE, CONTROL_SELECTOR: 'button,[role="button"]', getComposer: () => editor,
    collapse: text => String(text).trim(), collectImages: node => node.querySelectorAll('img'),
    document: { body, querySelectorAll: selector => body.querySelectorAll(selector) }
  }
  vm.createContext(scopeContext)
  const rootStart = injectedSource.indexOf('  const attachmentHasMessages =')
  assert.ok(rootStart >= 0 && rootStart < pickerStart)
  const scopeApi = vm.runInContext(injectedSource.slice(rootStart, pickerStart) + '\n({attachmentRoot, attachmentSnapshot, draftAttachmentEvidence, attachmentNameEvidence})', scopeContext)
  const imageDraftStart = injectedSource.indexOf('  const hasDraftImageAttachment =')
  const imageDraftEnd = injectedSource.indexOf('  const beginUserImageCapture =', imageDraftStart)
  assert.ok(imageDraftStart >= 0 && imageDraftEnd > imageDraftStart)
  const hasDraftImage = vm.runInContext(injectedSource.slice(imageDraftStart, imageDraftEnd) + '\nhasDraftImageAttachment', scopeContext)
  assert.equal(scopeApi.attachmentRoot(), panel)
  assert.match(scopeApi.attachmentSnapshot().text, /codex_can_do\.md/)
  assert.match(scopeApi.attachmentSnapshot().text, /full-document-name\.md/)
  assert.doesNotMatch(scopeApi.attachmentSnapshot().text, /private draft|old-history-file/)
  assert.equal(scopeApi.draftAttachmentEvidence(), true)
  card.remove()
  assert.equal(scopeApi.draftAttachmentEvidence(), false)
  panel.tagName = 'FORM'
  assert.equal(scopeApi.attachmentRoot(), panel)
  log('PASS file cards above toolbar, clickable card text, full-name labels, draft protection and conversation boundary')
  // 2026-10-06 raw-send log: no files/images/upload, but attachment-draft.
  // The 2026-10-05 capture measured the model button's Chinese aria-label.
  // Exercise the real snapshot and guard with version text and nested labels.
  const chatGptEditor = new Element('div', { contenteditable: 'true', 'data-composer-markdown': '' }, '\n')
  const chatGptModel = new Element('button', { 'aria-label': '选择 ChatGPT 模型', title: 'GPT-6.1' }, '', [
    new Element('span', { title: 'long-toolbar-model-label…', 'aria-label': 'toolbar-hint.md' }, 'GPT-6.1 Sol 中')
  ])
  const chatGptPanel = new Element('form', {}, '', [chatGptEditor, chatGptModel, new Element('button')])
  const chatGptHistory = new Element('div', { 'data-content-search-unit-key': 'history:user' }, 'old-history-file.md')
  scopeContext.PAGE = CHATGPT_PAGE; scopeContext.getComposer = () => chatGptEditor
  scopeContext.document.body = new Element('body', {}, '', [new Element('main', {}, '', [chatGptHistory, chatGptPanel])])
  scopeContext.document.querySelectorAll = selector => scopeContext.document.body.querySelectorAll(selector)
  assert.equal(scopeApi.attachmentRoot(), chatGptPanel)
  const emptyChatGptSnapshot = scopeApi.attachmentSnapshot()
  assert.equal(emptyChatGptSnapshot.inputFiles, 0)
  assert.equal(emptyChatGptSnapshot.images, 0)
  assert.equal(emptyChatGptSnapshot.uploading, false)
  assert.doesNotMatch(emptyChatGptSnapshot.text, /GPT-6\.1|toolbar|private|old-history/)
  assert.equal(scopeApi.draftAttachmentEvidence(), false, 'The model selector cannot block an empty ChatGPT draft')
  // Do not fix this by weakening extensions or dropping all clickable controls.
  for (const fileName of ['GPT-6.1', 'archive.7z', 'full-document-name.md', 'long-document-filename…']) {
    const preview = new Element('button', { title: fileName }, '', [new Element('span', { 'aria-label': fileName }, fileName)])
    chatGptPanel.children.push(preview); preview.parentElement = chatGptPanel
    assert.equal(scopeApi.draftAttachmentEvidence(), true, 'A genuine clickable file preview remains protected')
    assert.equal(scopeApi.attachmentNameEvidence(scopeApi.attachmentSnapshot().text, [{ fileName }])[0].method, 'exact')
    preview.remove()
    assert.equal(scopeApi.draftAttachmentEvidence(), false)
  }
  const selectedFile = new Element('input', { type: 'file' })
  selectedFile.files = [{ type: 'text/plain' }]
  chatGptPanel.children.push(selectedFile); selectedFile.parentElement = chatGptPanel
  assert.equal(scopeApi.draftAttachmentEvidence(), true, 'Protect selected files before their previews appear')
  selectedFile.remove()
  const chatGptImage = new Element('img')
  chatGptImage.src = 'blob:diagnostic'; chatGptImage.naturalWidth = 64; chatGptImage.naturalHeight = 64
  chatGptPanel.children.push(chatGptImage); chatGptImage.parentElement = chatGptPanel
  assert.equal(scopeApi.attachmentSnapshot().images, 1)
  assert.equal(scopeApi.draftAttachmentEvidence(), true)
  assert.equal(hasDraftImage(), true)
  chatGptImage.remove()
  const chatGptUpload = new Element('div', { role: 'progressbar' })
  chatGptPanel.children.push(chatGptUpload); chatGptUpload.parentElement = chatGptPanel
  assert.equal(scopeApi.draftAttachmentEvidence(), true, 'Protect a pending upload without filename text')
  chatGptUpload.remove()
  assert.equal(scopeApi.draftAttachmentEvidence(), false, 'Cleared attachments must not leave the model toolbar busy')
  log('PASS ChatGPT model version and nested toolbar labels do not block results or upload confirmation; real clickable files, native selections, images and uploading drafts stay protected')
  // The other computer's 2026-10-05 log: uploads all returned 201, but the
  // closest form lost its cards while a safe outer composer ancestor had them.
  const batchFiles = [
    'DGSNet_阶段工作成果与后续计划_2026-10-05.md',
    'DGSNet_阶段工作成果与后续计划_2026-10-03.md',
    'DGSNet_implementation_status.md',
    'DGSNet_数据接口与模型说明_2026-10-03.md',
    'DGSNet_drug_conditioning_validation_summary_2026-10-03.md'
  ].map(fileName => ({ fileName, mimeType: 'text/markdown' }))
  const shortenedName = 'DGSNet_drug_conditioning_val…'
  const batchLabels = batchFiles.slice(0, 4).map(file => file.fileName).join(' ') + ' ' + shortenedName
  const nestedEditor = new Element('div', { contenteditable: 'true' }, 'private editor draft')
  const innerForm = new Element('form', {}, '', [nestedEditor, new Element('button'), new Element('button')])
  const batchCards = batchFiles.map((file, index) => new Element('div', {
    role: 'button', contenteditable: 'false', title: index === 4 ? shortenedName : file.fileName
  }, index === 4 ? shortenedName : file.fileName))
  const outsideFormPanel = new Element('div', {}, '', [...batchCards, innerForm])
  // This empty-text history message must still be a hard boundary.
  const attachmentOnlyHistory = new Element('div', {
    class: 'group/user-message', 'data-chatgpt-search-unit-key': 'history:user'
  }, 'unrelated-history-file.md')
  scopeContext.PAGE = CHATGPT_PAGE
  scopeContext.getComposer = () => nestedEditor
  scopeContext.document.body = new Element('body', {}, '', [new Element('div', {}, '', [attachmentOnlyHistory, outsideFormPanel])])
  scopeContext.document.querySelectorAll = selector => scopeContext.document.body.querySelectorAll(selector)
  assert.equal(scopeApi.attachmentRoot(), outsideFormPanel)
  const outsideSnapshot = scopeApi.attachmentSnapshot()
  assert.doesNotMatch(outsideSnapshot.text, /private editor draft|unrelated-history-file/)
  assert.deepEqual(Array.from(scopeApi.attachmentNameEvidence(outsideSnapshot.text, batchFiles), name => name.method), ['exact', 'exact', 'exact', 'exact', 'truncated'])
  // The same wrapper works before the website moves the cards out of the form.
  batchCards.forEach(node => { node.remove(); innerForm.children.push(node); node.parentElement = innerForm })
  assert.equal(scopeApi.attachmentRoot(), outsideFormPanel)
  assert.deepEqual(Array.from(scopeApi.attachmentNameEvidence(scopeApi.attachmentSnapshot().text, batchFiles), name => name.method), ['exact', 'exact', 'exact', 'exact', 'truncated'])
  batchCards[4].remove()
  assert.equal(scopeApi.attachmentNameEvidence(scopeApi.attachmentSnapshot().text, batchFiles)[4].method, 'missing')
  // A form containing history is unsafe too; do not return it early.
  outsideFormPanel.tagName = 'FORM'
  innerForm.children.unshift(attachmentOnlyHistory)
  attachmentOnlyHistory.parentElement = innerForm
  assert.equal(scopeApi.attachmentRoot(), null)
  assert.equal(scopeApi.attachmentSnapshot().rootFound, false)
  const nameEvidence = scopeApi.attachmentNameEvidence
  assert.equal(nameEvidence('cafe\u0301.md', [{ fileName: 'café.md' }])[0].method, 'normalized')
  assert.equal(nameEvidence('two  words.md', [{ fileName: 'two words.md' }])[0].method, 'normalized')
  assert.equal(nameEvidence('sample\u200b.txt', [{ fileName: 'sample.txt' }])[0].method, 'normalized')
  assert.deepEqual(Array.from(nameEvidence('same-long-prefix…', [{ fileName: 'same-long-prefix-one.md' }, { fileName: 'same-long-prefix-two.md' }]), name => name.method), ['missing', 'missing'])
  assert.equal(nameEvidence('short…', [{ fileName: 'short-file.md' }])[0].method, 'missing')
  log('PASS nested form and relocated five-card batch, empty-text history boundaries, read-only previews, missing/ambiguous names and Unicode normalization')
  // Run the actual attachment-only public methods with an in-memory DOM model.
  // insertText is deliberately a trap: no status text or marker may be written.
  const publicStart = injectedSource.indexOf('  window[STATE_KEY] = {', pickerEnd)
  const publicEnd = injectedSource.indexOf('    configure(config) {', publicStart)
  assert.ok(publicStart > pickerEnd && publicEnd > publicStart, 'Attachment public methods not found')
  const composer = { text: '' }
  const button = { disabled: false, cssDisabled: false, getAttribute: () => null, matches(selector) { return this.cssDisabled && selector === '.ds-button--disabled' } }
  const fileInput = { ...generalInput, setAttribute() {}, removeAttribute() {} }
  const mockTurn = (key, images = [], text = '') => ({
    getAttribute: name => name === 'data-content-search-unit-key' ? key : null,
    images, textContent: text, innerText: text
  })
  const thumbnail = { alt: '', title: '', getAttribute: () => '', attachment: true }
  const oldTurn = mockTurn('old-turn', [thumbnail])
  const turns = [oldTurn]
  let draftImages = 0
  let draftText = ''
  let clickAction = () => { draftImages = 0; turns.push(mockTurn('new-turn', [thumbnail])) }
  const scheduledChecks = []
  const pageContext = {
    window: {}, STATE_KEY: '__files', state: { programmatic: false }, PAGE: CHATGPT_PAGE, CONTROL_SELECTOR: 'button,[role="button"]',
    document: { querySelectorAll: selector => selector === 'input[type="file"]' ? [mediaInput, imageInput, fileInput] : pageContext.document.body?.querySelectorAll(selector) || [] },
    attachmentRoot: () => ({ querySelectorAll: () => [mediaInput, imageInput, fileInput] }),
    attachmentSnapshot: () => ({ rootFound: true, text: draftText, images: draftImages, uploading: false, error: false, inputFiles: 0 }),
    draftAttachmentEvidence: () => draftImages > 0 || draftText !== '',
    getComposer: () => composer, readComposer: node => node?.text || '',
    composerMatches: (node, expected) => !!node && node.text === expected,
    collapse: text => String(text).trim(), findStopButton: () => null,
    findSendButton: () => button, controlDisabled: node => node.disabled,
    userTurns: () => turns, messageIdOf: () => null,
    collectImages: node => node?.images || node?.querySelectorAll?.('img') || [], imageLooksLikeAttachment: image => image.attachment,
    lastAssistantId: () => 'previous-assistant', pressButton: () => clickAction(),
    report() {}, scheduleScrollToBottom() {}, scheduleCheck: () => scheduledChecks.push(() => vm.runInContext('checkForCommand()', pageContext)),
    insertText: () => { throw new Error('Attachment send wrote text') },
    lastDraftImageAttachments: [], lastDraftImageCapturedAt: 0, lastDraftImagePromise: Promise.resolve([])
  }
  vm.createContext(pageContext)
  const nameStart = injectedSource.indexOf('  const normalizeAttachmentName =')
  const nameEnd = injectedSource.indexOf('  const draftAttachmentEvidence =', nameStart)
  assert.ok(nameStart >= 0 && nameEnd > nameStart)
  vm.runInContext(injectedSource.slice(nameStart, nameEnd) + injectedSource.slice(pickerStart, publicStart) + injectedSource.slice(publicStart, publicEnd) + '\n};', pageContext)
  const fileApi = pageContext.window.__files
  assert.equal(fileApi.beginFileSend('attachment-only', [image]), 'ok')
  assert.equal(composer.text, '')
  assert.equal(fileApi.refreshFileInput('attachment-only'), true)
  fileApi.fileSelectionApplied('attachment-only')
  draftImages = 1
  assert.equal(fileApi.fileSendStatus('attachment-only').status, 'ready')
  assert.equal(fileApi.submitFileSend('attachment-only'), true)
  assert.equal(fileApi.fileSendStatus('attachment-only').status, 'sent')
  assert.equal(composer.text, '')
  assert.equal(fileApi.fileSendStatus('attachment-only').status, 'sent')
  composer.text = 'user draft'
  assert.equal(fileApi.beginFileSend('draft-protected', [image]), 'busy')
  assert.equal(composer.text, 'user draft')
  composer.text = ''
  assert.equal(fileApi.beginFileSend('no-files', []), 'no-files')
  assert.equal(fileApi.beginFileSend('rerender', [image]), 'ok')
  fileApi.fileSelectionApplied('rerender')
  draftImages = 1
  clickAction = () => { draftImages = 0; turns[turns.length - 1] = mockTurn('new-turn', [thumbnail]) }
  assert.equal(fileApi.submitFileSend('rerender'), true)
  assert.equal(fileApi.fileSendStatus('rerender').status, 'confirming')
  turns.push(mockTurn('text-only-turn', [], image.fileName))
  assert.equal(fileApi.fileSendStatus('rerender').status, 'confirming')
  turns.push(mockTurn('next-image-turn', [thumbnail]))
  assert.equal(fileApi.fileSendStatus('rerender').status, 'sent')
  const turnShowsFiles = vm.runInContext('turnShowsFiles', pageContext)
  assert.equal(turnShowsFiles(mockTurn('document', [], 'sample.txt'), [textFile]), true)
  assert.equal(turnShowsFiles(mockTurn('missing-document', [], ''), [textFile]), false)
  assert.equal(turnShowsFiles(mockTurn('mixed', [thumbnail], 'sample.txt'), [image, textFile]), true)
  assert.equal(turnShowsFiles(mockTurn('missing-image', [], 'sample.txt'), [image, textFile]), false)
  log('PASS attachment-only send without text, draft protection, image/document confirmation and old-turn rerenders')
  // Upload completion alone must not submit a batch with a missing card.
  assert.equal(fileApi.beginFileSend('five-card-batch', batchFiles), 'ok')
  fileApi.fileSelectionApplied('five-card-batch')
  draftText = batchFiles.slice(0, 4).map(file => file.fileName).join(' ')
  assert.equal(fileApi.fileSendStatus('five-card-batch').status, 'uploading')
  assert.equal(fileApi.fileSendStatus('five-card-batch').nameEvidence[4].method, 'missing')
  draftText = batchLabels
  assert.equal(fileApi.fileSendStatus('five-card-batch').status, 'ready')
  clickAction = () => { draftText = ''; turns.push(mockTurn('five-card-next:user', [], batchLabels)) }
  assert.equal(fileApi.submitFileSend('five-card-batch'), true)
  assert.equal(fileApi.fileSendStatus('five-card-batch').status, 'sent')
  assert.equal(composer.text, '')
  log('PASS five-card readiness and acknowledgement use the same matcher, require every file and send no text')
  // ChatGPT's selectable text and file card need not share the same node.
  // Use the real boundary/root helpers with nested user units and sibling cards.
  const hostsFile = { fileName: 'hosts', mimeType: 'application/octet-stream' }
  const previousUserUnit = new Element('div', { 'data-content-search-unit-key': 'turn-0:user' })
  const previousMessage = new Element('div', {}, '', [previousUserUnit, new Element('div', {}, 'hosts')])
  const selection = new Element('div', { 'data-chatgpt-selection-message-id': 'user-id-1' })
  const currentUserUnit = new Element('div', { 'data-content-search-unit-key': 'turn-1:user' }, '', [selection])
  const documentCard = new Element('div', { title: 'different-file' }, '文件')
  const currentMessage = new Element('div', {}, '', [documentCard, currentUserUnit])
  const assistantAnswer = new Element('div', { 'data-markdown-text-style': 'assistant-message' }, 'hosts 上传成功')
  const assistantSelection = new Element('div', { 'data-chatgpt-selection-message-id': 'assistant-id-1' }, '', [assistantAnswer])
  const assistantUnit = new Element('div', { 'data-content-search-unit-key': 'turn-1:assistant' }, '', [assistantSelection])
  const messageList = new Element('div', {}, '', [previousMessage])
  const messageBody = new Element('body', {}, '', [messageList])
  pageContext.document.body = messageBody
  turns.splice(0, turns.length, previousUserUnit)
  assert.equal(fileApi.beginFileSend('chatgpt-sibling-card', [hostsFile]), 'ok')
  fileApi.fileSelectionApplied('chatgpt-sibling-card')
  draftText = hostsFile.fileName
  clickAction = () => { draftText = ''; turns[0] = previousUserUnit.cloneNode() }
  assert.equal(fileApi.submitFileSend('chatgpt-sibling-card'), true)
  assert.equal(fileApi.fileSendStatus('chatgpt-sibling-card').status, 'confirming')
  messageList.children.push(currentMessage, assistantUnit)
  currentMessage.parentElement = messageList
  assistantUnit.parentElement = messageList
  turns.push(currentUserUnit, selection, assistantUnit, assistantSelection)
  assert.equal(vm.runInContext('fileUserTurns().length', pageContext), 2)
  assert.equal(vm.runInContext('fileAttachmentRoot', pageContext)(selection), currentMessage)
  // Neither the old card nor the assistant's claim confirms this new user turn.
  const missingCardStatus = fileApi.fileSendStatus('chatgpt-sibling-card')
  assert.equal(missingCardStatus.newTurnSeen, true)
  assert.equal(missingCardStatus.turnFilesSeen, false)
  documentCard.attributes.title = 'hosts'
  assert.equal(turnShowsFiles(selection, [hostsFile]), true)
  delete documentCard.attributes.title
  documentCard.attributes['aria-label'] = 'hosts'
  assert.equal(fileApi.fileSendStatus('chatgpt-sibling-card').status, 'sent')
  assert.equal(composer.text, '')
  const imageUnit = new Element('div', { 'data-content-search-unit-key': 'turn-2:user' })
  const siblingImage = new Element('img')
  siblingImage.attachment = true
  const imageMessage = new Element('div', {}, '', [siblingImage, imageUnit])
  messageList.children.push(imageMessage)
  imageMessage.parentElement = messageList
  assert.equal(turnShowsFiles(imageUnit, [image]), true)
  assert.equal(turnShowsFiles(imageUnit, [hostsFile]), false)
  // The composer is a hard boundary too, even if no other message is present.
  const isolatedUnit = new Element('div', { 'data-content-search-unit-key': 'isolated:user' })
  const isolatedComposer = new Element('div')
  const unsafeParent = new Element('div', {}, 'hosts', [isolatedUnit, isolatedComposer])
  unsafeParent.parentElement = messageBody
  pageContext.getComposer = () => isolatedComposer
  assert.equal(vm.runInContext('fileAttachmentRoot', pageContext)(isolatedUnit), isolatedUnit)
  assert.equal(turnShowsFiles(isolatedUnit, [hostsFile]), false)
  pageContext.getComposer = () => composer
  log('PASS ChatGPT nested user units, sibling document/image cards, title/aria names and old/assistant/composer boundaries')
  // Captured 2026-10-05: the file card is inside group/user-message, alongside
  // an empty text unit. The text unit is removed/recreated while sending.
  // The next user wrapper is discoverable even before ANY text unit exists.
  const transientTextUnit = new Element('div', { 'data-content-search-unit-key': 'captured-old:user' })
  const fullUser = new Element('div', {
    class: 'group/user-message flex flex-col items-end gap-2',
    'data-chatgpt-search-unit-key': 'captured-old:user',
    'data-chatgpt-search-message-ids': 'old-user-message-id'
  }, '', [new Element('span', { title: 'hosts(1)' }, 'hosts(1)'), transientTextUnit])
  const fullUserList = new Element('div', {}, '', [fullUser])
  pageContext.document.body = new Element('body', {}, '', [fullUserList])
  turns.splice(0, turns.length, transientTextUnit)
  assert.equal(vm.runInContext('fileUserTurns().length', pageContext), 1)
  assert.equal(vm.runInContext('fileUserTurnRoot', pageContext)(transientTextUnit), fullUser)
  assert.equal(vm.runInContext('fileAttachmentRoot', pageContext)(transientTextUnit), fullUser)
  assert.equal(fileApi.beginFileSend('captured-no-text-unit', [hostsFile]), 'ok')
  fileApi.fileSelectionApplied('captured-no-text-unit')
  draftText = hostsFile.fileName
  clickAction = () => { draftText = ''; transientTextUnit.remove(); turns.splice(0, turns.length) }
  assert.equal(fileApi.submitFileSend('captured-no-text-unit'), true)
  // An older card survives while its text unit disappears; it is still old.
  assert.equal(fileApi.fileSendStatus('captured-no-text-unit').status, 'confirming')
  assert.equal(vm.runInContext('fileUserTurns().length', pageContext), 1)
  const rerenderedFullUser = fullUser.cloneNode()
  fullUserList.children[0] = rerenderedFullUser
  rerenderedFullUser.parentElement = fullUserList
  assert.equal(fileApi.fileSendStatus('captured-no-text-unit').status, 'confirming')
  const nextFullUser = new Element('div', {
    class: 'group/user-message flex flex-col items-end gap-2',
    'data-chatgpt-search-unit-key': 'captured-next:user',
    'data-chatgpt-search-message-ids': 'next-user-message-id'
  }, '', [new Element('span', { title: 'hosts(2)' }, 'hosts(2)')])
  fullUserList.children.push(nextFullUser)
  nextFullUser.parentElement = fullUserList
  assert.equal(fileApi.fileSendStatus('captured-no-text-unit').status, 'sent')
  assert.equal(vm.runInContext('fileUserTurns().length', pageContext), 2)
  const hydratedUnit = new Element('div', { 'data-content-search-unit-key': 'captured-next:user' })
  nextFullUser.children.push(hydratedUnit)
  hydratedUnit.parentElement = nextFullUser
  turns.push(hydratedUnit)
  assert.equal(vm.runInContext('fileUserTurns().length', pageContext), 2)
  assert.equal(vm.runInContext('fileUserTurnKey', pageContext)(vm.runInContext('fileUserTurnRoot', pageContext)(hydratedUnit)), 'captured-next:user')
  // A fresh wrapper key also works if the page reuses its DOM node.
  assert.equal(fileApi.beginFileSend('captured-wrapper-reuse', [hostsFile]), 'ok')
  fileApi.fileSelectionApplied('captured-wrapper-reuse')
  draftText = hostsFile.fileName
  clickAction = () => { draftText = ''; nextFullUser.attributes['data-chatgpt-search-unit-key'] = 'captured-reused-next:user' }
  assert.equal(fileApi.submitFileSend('captured-wrapper-reuse'), true)
  assert.equal(fileApi.fileSendStatus('captured-wrapper-reuse').status, 'sent')
  log('PASS captured ChatGPT full user wrappers, missing/hydrated text units, renamed hosts cards and stable rerender/reuse identity')
  // Claude capture 2026-10-06: attachment-only messages lack user-message;
  // file-thumbnail cards are siblings of optional text inside the ms-auto wrapper.
  // PDF names can exist only in an img alt, including a small/unloaded preview.
  pageContext.PAGE = CLAUDE_PAGE
  assert.equal(CLAUDE_PAGE.messageIdAttr, '', 'List positions must not become command IDs')
  assert.equal(fileReadingPlatform('claude').id, 'claude')
  const claudeCard = (name, isImage = false) => {
    const content = new Element(isImage ? 'img' : 'span', isImage ? { alt: name } : { title: name }, isImage ? '' : name)
    if (isImage) { content.alt = name; content.title = ''; content.attachment = false }
    return new Element('div', { 'data-testid': 'file-thumbnail' }, '', [content])
  }
  const claudeRow = (position, cards = [], text = '') => {
    const children = [...cards]
    if (text) children.push(new Element('div', { 'data-testid': 'user-message' }, text))
    return new Element('div', { 'data-testid': 'transcript-row', 'data-rs-index': String(position) }, '', [
      new Element('div', { class: 'group/message-row ms-auto flex w-full items-end' }, '', children)
    ])
  }
  const oldClaudeRow = claudeRow(0, [claudeCard('hosts')])
  const claudeList = new Element('div', { 'data-testid': 'transcript-list' }, '', [oldClaudeRow])
  pageContext.document.body = new Element('body', {}, '', [claudeList])
  turns.splice(0, turns.length)
  assert.equal(vm.runInContext('fileUserTurns().length', pageContext), 1)
  assert.equal(fileApi.beginFileSend('claude-repeated-name', [hostsFile]), 'ok')
  fileApi.fileSelectionApplied('claude-repeated-name')
  draftText = 'hosts'
  clickAction = () => { draftText = ''; claudeList.children[0] = oldClaudeRow.cloneNode(); claudeList.children[0].parentElement = claudeList }
  assert.equal(fileApi.submitFileSend('claude-repeated-name'), true)
  assert.equal(fileApi.fileSendStatus('claude-repeated-name').status, 'confirming', 'Old same-name card rerender is not a new send')
  const newClaudeRow = claudeRow(2, [claudeCard('hosts')])
  claudeList.children.push(newClaudeRow); newClaudeRow.parentElement = claudeList
  assert.equal(fileApi.fileSendStatus('claude-repeated-name').status, 'sent')
  const claudeUser = newClaudeRow.children[0]
  const claudeText = new Element('div', { 'data-testid': 'user-message' }, 'user text')
  claudeUser.children.push(claudeText); claudeText.parentElement = claudeUser; turns.push(claudeText)
  assert.equal(vm.runInContext('fileUserTurns().length', pageContext), 2, 'Hydrated text must normalize to one full wrapper')
  assert.equal(vm.runInContext('fileUserTurnPosition', pageContext)(claudeUser), 2)
  assert.equal(fileApi.beginFileSend('claude-row-reuse', [hostsFile]), 'ok')
  fileApi.fileSelectionApplied('claude-row-reuse'); draftText = 'hosts'
  clickAction = () => { draftText = ''; newClaudeRow.attributes['data-rs-index'] = '4' }
  assert.equal(fileApi.submitFileSend('claude-row-reuse'), true)
  assert.equal(fileApi.fileSendStatus('claude-row-reuse').status, 'sent')
  const sourceFile = { fileName: 'sample.js', mimeType: 'text/plain' }
  const pdfFile = { fileName: 'sample.pdf', mimeType: 'application/pdf' }
  const pngFile = { fileName: 'sample.png', mimeType: 'image/png' }
  const mixedClaudeRow = claudeRow(6, [claudeCard(sourceFile.fileName), claudeCard(pdfFile.fileName, true), claudeCard(pngFile.fileName, true)])
  assert.equal(turnShowsFiles(mixedClaudeRow.children[0], [sourceFile, pdfFile, pngFile]), true)
  mixedClaudeRow.children[0].children.pop()
  assert.equal(turnShowsFiles(mixedClaudeRow.children[0], [sourceFile, pdfFile, pngFile]), false, 'Every file needs evidence inside its own user message')
  const userClaim = claudeRow(8, [], 'sample.js sample.pdf sample.png')
  assert.equal(turnShowsFiles(userClaim.children[0], [sourceFile, pdfFile, pngFile]), false, 'Plain filename mentions are not native attachment cards')
  const assistantClaim = new Element('div', { 'data-testid': 'assistant-message' }, 'hosts')
  claudeList.children.push(assistantClaim); assistantClaim.parentElement = claudeList
  turns.push(assistantClaim)
  assert.equal(turnShowsFiles(claudeUser, [pdfFile]), false, 'Do not widen into another user or assistant message')
  const noPosition = claudeRow(10, [claudeCard('hosts')]); delete noPosition.attributes['data-rs-index']
  const baselineClaude = { node: claudeUser, count: 2, keys: new Set(['0', '4']), maxPosition: 4 }
  assert.equal(vm.runInContext('isNewFileUserTurn', pageContext)(noPosition.children[0], [claudeUser, noPosition.children[0]], baselineClaude), false, 'Missing row positions cannot confirm a rerender')
  log('PASS Claude attachment-only wrappers, repeated names, old-row rejection, ancestor positions, recycled rows and native PNG/PDF/source-card evidence')
  // Exercise the actual draft/scope helpers too: an extensionless card remains
  // protected even after FileList resets, and PDF alt contributes name evidence.
  const claudeEditor = new Element('div', { contenteditable: 'true', 'data-testid': 'chat-input' })
  const previewPdf = claudeCard(pdfFile.fileName, true)
  const previewImage = previewPdf.children[0]
  previewImage.naturalWidth = 16; previewImage.naturalHeight = 16; previewImage.src = 'https://example.invalid/preview'
  const modelButton = new Element('button', {}, 'Sonnet 5.5 中等')
  const menuButton = new Element('button', { 'aria-label': 'long-toolbar-label…' })
  const claudePanel = new Element('fieldset', {}, '', [claudeCard('hosts'), previewPdf, claudeEditor, modelButton, menuButton])
  const claudeBody = new Element('body', {}, '', [new Element('main', {}, '', [oldClaudeRow, claudePanel])])
  scopeContext.PAGE = CLAUDE_PAGE; scopeContext.getComposer = () => claudeEditor
  scopeContext.document = { body: claudeBody, querySelectorAll: selector => claudeBody.querySelectorAll(selector) }
  assert.equal(scopeApi.attachmentRoot(), claudePanel)
  assert.equal(scopeApi.draftAttachmentEvidence(), true)
  assert.equal(hasDraftImage(), true, 'A PDF preview in the second native card still protects the draft')
  assert.match(scopeApi.attachmentSnapshot().text, /sample\.pdf/)
  claudePanel.children = [claudeEditor, modelButton, menuButton]
  claudePanel.children.forEach(child => { child.parentElement = claudePanel })
  assert.match(scopeApi.attachmentSnapshot().text, /Sonnet 5\.5/)
  assert.equal(scopeApi.draftAttachmentEvidence(), false, 'Model version and truncated toolbar label are not attachments')
  const oldPreview = claudeCard('old-image.png', true)
  oldPreview.children[0].src = 'https://example.invalid/old-image'
  oldPreview.children[0].naturalWidth = 100; oldPreview.children[0].naturalHeight = 100
  oldClaudeRow.children[0].children.push(oldPreview); oldPreview.parentElement = oldClaudeRow.children[0]
  const toolbarImage = new Element('img')
  toolbarImage.src = 'https://example.invalid/toolbar-icon'; toolbarImage.naturalWidth = 80; toolbarImage.naturalHeight = 80
  claudePanel.children.push(toolbarImage); toolbarImage.parentElement = claudePanel
  assert.equal(hasDraftImage(), false, 'History and toolbar images cannot block an empty Claude draft')
  assert.equal(scopeApi.attachmentSnapshot().images, 0)
  assert.equal(scopeApi.draftAttachmentEvidence(), false)
  const nativeInput = new Element('input', { type: 'file' })
  nativeInput.files = [{ type: 'text/plain' }]
  claudePanel.children.push(nativeInput); nativeInput.parentElement = claudePanel
  assert.equal(scopeApi.draftAttachmentEvidence(), true, 'Protect a selection before native cards appear')
  nativeInput.files = []
  assert.equal(scopeApi.draftAttachmentEvidence(), false)
  const uploadingCard = new Element('div', { 'data-testid': 'file-thumbnail', 'aria-busy': 'true' })
  claudePanel.children.push(uploadingCard); uploadingCard.parentElement = claudePanel
  assert.equal(scopeApi.attachmentSnapshot().uploading, true)
  assert.equal(scopeApi.draftAttachmentEvidence(), true, 'Protect an uploading card before its filename appears')
  uploadingCard.remove()
  log('PASS Claude version/ellipsis toolbar text and old images do not block an empty draft; selected files, extensionless cards, PDF alt and uploading cards remain protected')
  // Gemini's 08:54 focused capture: split text/extension, card-linked hidden
  // tooltip, native uploaded-img, and opaque IDs on surrounding conversations.
  const geminiEditor = new Element('div', { class: 'ql-editor', contenteditable: 'true' })
  const geminiTooltip = new Element('div', { id: 'gemini-card-hint', role: 'tooltip' }, 'sample.txt')
  const unrelatedTooltip = new Element('div', { id: 'unrelated-hint', role: 'tooltip' }, 'unrelated.md')
  const geminiDraftCard = new Element('uploader-file-preview', {}, '', [
    new Element('div', { 'aria-describedby': 'gemini-card-hint' }, '', [
      new Element('span', { class: 'gem-attachment-text' }, 'sample'), new Element('span', { class: 'gem-attachment-extension-label' }, 'TXT')
    ])
  ])
  const geminiPanel = new Element('fieldset', { class: 'input-area-fieldset' }, '', [geminiEditor, geminiDraftCard, new Element('button'), new Element('button', {}, 'toolbar filename.md')])
  const geminiBody = new Element('body', {}, '', [geminiPanel, geminiTooltip, unrelatedTooltip])
  scopeContext.PAGE = GEMINI_PAGE; scopeContext.getComposer = () => geminiEditor
  scopeContext.document = { body: geminiBody, querySelectorAll: selector => geminiBody.querySelectorAll(selector), getElementById: id => geminiBody.querySelectorAll('[id]').find(node => node.getAttribute('id') === id) || null }
  assert.equal(scopeApi.attachmentRoot(), geminiPanel)
  assert.match(scopeApi.attachmentSnapshot().text, /sample\.txt/)
  assert.doesNotMatch(scopeApi.attachmentSnapshot().text, /unrelated\.md|toolbar filename/)
  geminiDraftCard.children[0].attributes['aria-describedby'] = 'missing-hint'
  assert.equal(scopeApi.attachmentNameEvidence(scopeApi.attachmentSnapshot().text, [textFile])[0].method, 'missing', 'Do not guess full filenames from separate basename/extension')
  assert.equal(scopeApi.draftAttachmentEvidence(), true, 'Protect native cards even before linked names become available')
  geminiDraftCard.children[0].attributes['aria-describedby'] = 'unrelated-hint'
  unrelatedTooltip.attributes.role = 'article'
  assert.doesNotMatch(scopeApi.attachmentSnapshot().text, /unrelated\.md/, 'References to arbitrary conversation content are not filename evidence')
  const geminiDraftImage = new Element('img', { class: 'gem-attachment-style-img' })
  geminiDraftImage.src = 'blob:diagnostic'; geminiDraftImage.naturalWidth = 64; geminiDraftImage.naturalHeight = 64
  const geminiMedia = new Element('uploader-file-preview', {}, '', [new Element('gem-media-attachment', {}, '', [geminiDraftImage])])
  geminiPanel.children.push(geminiMedia); geminiMedia.parentElement = geminiPanel
  assert.equal(scopeApi.attachmentSnapshot().images, 1)
  assert.equal(hasDraftImage(), true)
  const geminiSpinner = new Element('mat-progress-spinner')
  geminiDraftCard.children.push(geminiSpinner); geminiSpinner.parentElement = geminiDraftCard
  assert.equal(scopeApi.attachmentSnapshot().uploading, true)
  geminiDraftCard.remove(); geminiMedia.remove()
  assert.equal(scopeApi.draftAttachmentEvidence(), false, 'Stale tooltip/toolbar names cannot block an empty Gemini draft')
  log('PASS Gemini draft scope, split names with linked tooltips, unrelated/missing references, native images, Angular upload progress and empty-draft protection')

  pageContext.PAGE = GEMINI_PAGE
  const geminiSentCard = (name, isImage = false) => {
    const child = isImage ? new Element('img', { 'data-test-id': 'uploaded-img' }) : new Element('button', { 'aria-label': name })
    if (isImage) child.attachment = true
    return new Element('user-query-file-preview', {}, '', [child])
  }
  const geminiRow = (id, cards = [], text = '') => new Element('div', { class: 'conversation-container', ...(id ? { id } : {}) }, '', [new Element('user-query', {}, text, [new Element('user-query-file-carousel', {}, '', cards)])])
  const geminiOld = geminiRow('opaque-old', [geminiSentCard('sample.txt')])
  const geminiList = new Element('div', {}, '', [geminiOld])
  pageContext.document.body = new Element('body', {}, '', [geminiList])
  turns.splice(0, turns.length)
  const geminiMixed = [textFile, pdfFile, pngFile]
  assert.equal(fileReadingPlatform('gemini').id, 'gemini')
  assert.equal(fileApi.beginFileSend('gemini-cards', geminiMixed), 'ok')
  fileApi.fileSelectionApplied('gemini-cards'); draftText = geminiMixed.map(file => file.fileName).join(' '); draftImages = 1
  clickAction = () => { draftText = ''; draftImages = 0; geminiList.children[0] = geminiOld.cloneNode(); geminiList.children[0].parentElement = geminiList }
  assert.equal(fileApi.submitFileSend('gemini-cards'), true)
  assert.equal(fileApi.fileSendStatus('gemini-cards').status, 'confirming', 'Same-ID old card rerender is not a new send')
  const pendingGemini = geminiRow('', [geminiSentCard('sample.txt'), geminiSentCard('sample.pdf'), geminiSentCard('', true)])
  geminiList.children.push(pendingGemini); pendingGemini.parentElement = geminiList
  assert.equal(fileApi.fileSendStatus('gemini-cards').status, 'confirming', 'Wait for the final surrounding ID, not the pending-request placeholder')
  pendingGemini.attributes.id = 'opaque-new'
  assert.equal(fileApi.fileSendStatus('gemini-cards').status, 'sent')
  assert.equal(turnShowsFiles(geminiRow('plain-claim', [], 'sample.txt sample.pdf sample.png').children[0], geminiMixed), false)
  const partialGemini = geminiRow('partial', [geminiSentCard('sample.txt'), geminiSentCard('sample.pdf')])
  const icon = new Element('img'); icon.attachment = true
  partialGemini.children[0].children[0].children[1].children.push(icon)
  assert.equal(turnShowsFiles(partialGemini.children[0], geminiMixed), false, 'Document icons do not stand in for uploaded-img')
  log('PASS Gemini mixed attachment-only messages, native document/image evidence, opaque ancestor IDs, old-row rerenders and pending placeholders')

  const savedRoot = pageContext.attachmentRoot, savedPress = pageContext.pressButton, savedQueries = pageContext.document.querySelectorAll
  let menuOpened = false, localClicks = 0
  const nativeControl = () => ({ disabled: false, getClientRects: () => [{}] })
  const uploadMenu = nativeControl(), uploadLocal = nativeControl(), uploadDrive = nativeControl()
  pageContext.attachmentRoot = () => ({ querySelectorAll: selector => GEMINI_PAGE.fileUploadMenuSelectors.includes(selector) ? [uploadMenu] : [] })
  pageContext.document.querySelectorAll = selector => selector === GEMINI_PAGE.fileLocalUploadSelector && menuOpened ? [uploadLocal] : []
  pageContext.pressButton = node => {
    assert.notEqual(node, uploadDrive)
    if (node === uploadMenu) menuOpened = true
    if (node === uploadLocal) localClicks++
  }
  composer.text = 'user draft'
  assert.equal(fileApi.beginFileSend('gemini-native-chooser', geminiMixed), 'busy')
  composer.text = ''
  assert.equal(fileApi.beginFileSend('gemini-native-chooser', geminiMixed), 'ok', 'A permanent file input is not required')
  assert.equal(await fileApi.openFileChooser('wrong-token'), false)
  assert.equal(await fileApi.openFileChooser('gemini-native-chooser'), 'waiting')
  assert.equal(await fileApi.openFileChooser('gemini-native-chooser'), true)
  assert.equal(menuOpened, true); assert.equal(localClicks, 1)
  fileApi.releaseFileSend('gemini-native-chooser')
  assert.equal(await fileApi.openFileChooser('gemini-native-chooser'), false, 'A released run must not reopen a chooser')
  const filesTile = new Element('button', {}, '文件', [new Element('mat-icon', {}, 'attach_file')])
  const driveTile = new Element('button', {}, '云端硬盘')
  const photosTile = new Element('button', {}, 'Google 相册')
  const localSubmenu = new Element('button', { 'data-test-id': 'local-images-files-uploader-button' }, 'Upload from computer')
  const popup = new Element('div', { role: 'menu' }, '', [filesTile, driveTile, photosTile])
  const outsideFiles = new Element('button', {}, '文件')
  const chooserBody = new Element('body', {}, '', [popup, outsideFiles])
  pageContext.document.querySelectorAll = selector => chooserBody.querySelectorAll(selector)
  let tileClicks = 0, submenuClicks = 0
  const clickedChooserNodes = []
  pageContext.pressButton = node => {
    clickedChooserNodes.push(node)
    assert.notEqual(node, driveTile); assert.notEqual(node, photosTile); assert.notEqual(node, outsideFiles)
    if (node === filesTile) tileClicks++
    if (node === localSubmenu) submenuClicks++
  }
  assert.equal(fileApi.beginFileSend('gemini-compact-direct', geminiMixed), 'ok')
  assert.equal(fileApi.openFileChooser('gemini-compact-direct'), 'waiting', 'Compact Files can open the native chooser directly')
  assert.equal(tileClicks, 1)
  assert.equal(fileApi.openFileChooser('gemini-compact-direct'), 'waiting')
  assert.equal(tileClicks, 1, 'Polling cannot repeatedly click or toggle a Files entry')
  const rebuiltTile = filesTile.cloneNode()
  popup.children[0] = rebuiltTile; rebuiltTile.parentElement = popup
  assert.equal(fileApi.openFileChooser('gemini-compact-direct'), 'waiting')
  assert.equal(clickedChooserNodes.includes(rebuiltTile), false, 'A remounted Files tile cannot trigger the same step again')
  popup.children[0] = filesTile; filesTile.parentElement = popup
  fileApi.releaseFileSend('gemini-compact-direct')
  assert.equal(fileApi.beginFileSend('gemini-compact-direct', geminiMixed), 'ok')
  assert.equal(fileApi.openFileChooser('gemini-compact-direct'), 'waiting')
  assert.equal(tileClicks, 2, 'A retry can reuse the same menu DOM after resetting clicked-control state')
  fileApi.releaseFileSend('gemini-compact-direct')
  assert.equal(fileApi.beginFileSend('gemini-compact-submenu', geminiMixed), 'ok')
  assert.equal(fileApi.openFileChooser('gemini-compact-submenu'), 'waiting')
  popup.children.push(localSubmenu); localSubmenu.parentElement = popup
  assert.equal(fileApi.openFileChooser('gemini-compact-submenu'), true, 'Files can reveal the measured local submenu on the next tick')
  assert.equal(submenuClicks, 1)
  assert.equal(fileApi.openFileChooser('gemini-compact-submenu'), 'waiting')
  assert.equal(submenuClicks, 1)
  fileApi.releaseFileSend('gemini-compact-submenu')
  localSubmenu.remove()
  filesTile.text = 'Files'
  assert.equal(fileApi.beginFileSend('gemini-compact-english', geminiMixed), 'ok')
  assert.equal(fileApi.openFileChooser('gemini-compact-english'), 'waiting')
  assert.equal(tileClicks, 4)
  fileApi.releaseFileSend('gemini-compact-english')
  const duplicateTile = new Element('button', {}, 'Files')
  popup.children.push(duplicateTile); duplicateTile.parentElement = popup
  assert.equal(fileApi.beginFileSend('gemini-compact-ambiguous', geminiMixed), 'ok')
  assert.equal(fileApi.openFileChooser('gemini-compact-ambiguous'), 'waiting')
  assert.equal(tileClicks, 4)
  const chooserDiagnostics = fileApi.fileChooserDiagnostics()
  assert.equal(chooserDiagnostics.captionEntryCount, 2)
  assert.equal(chooserDiagnostics.entryAmbiguous, true)
  assert.equal(chooserDiagnostics.entryClicked, false)
  assert.doesNotMatch(JSON.stringify(chooserDiagnostics), /文件|Files|云端硬盘|Google|Upload/)
  fileApi.releaseFileSend('gemini-compact-ambiguous')
  duplicateTile.attributes['aria-hidden'] = 'true'
  filesTile.attributes['aria-hidden'] = 'true'
  assert.equal(fileApi.beginFileSend('gemini-compact-hidden', geminiMixed), 'ok')
  assert.equal(fileApi.openFileChooser('gemini-compact-hidden'), 'waiting')
  assert.equal(tileClicks, 4, 'Hidden helpers and history captions must not trigger local upload')
  fileApi.releaseFileSend('gemini-compact-hidden')
  pageContext.attachmentRoot = savedRoot; pageContext.pressButton = savedPress; pageContext.document.querySelectorAll = savedQueries
  log('PASS Gemini desktop/compact Files entries, direct chooser/submenu paths, single clicks, retries, hidden/ambiguous rejection, safe diagnostics and draft/stale-token boundaries')
  // DeepSeek can recycle rows and keep the same number of visible user turns.
  // A greater numeric position or a fresh opaque key plus files is required.
  pageContext.PAGE = DEEPSEEK_PAGE
  pageContext.document.body = null
  const disabledStart = injectedSource.indexOf('  const controlDisabled =')
  const disabledEnd = injectedSource.indexOf('/**', disabledStart)
  const isDisabled = vm.runInContext(injectedSource.slice(disabledStart, disabledEnd) + '\ncontrolDisabled', pageContext)
  assert.equal(isDisabled({ disabled: false, getAttribute: () => null, matches: selector => selector === '.ds-button--disabled' }), true)
  assert.equal(isDisabled({ disabled: false, getAttribute: () => null, matches: () => false }), false)
  assert.equal(DEEPSEEK_PAGE.messageIdAttr, '')
  assert.equal(turnShowsFiles(mockTurn('image-card', [], image.fileName), [image]), true)
  assert.equal(turnShowsFiles(mockTurn('incomplete-card', [], image.fileName), [image, textFile]), false)
  const virtualRow = { position: '4', textContent: image.fileName, getAttribute(name) { return name === 'data-virtual-list-item-key' ? this.position : null } }
  turns.splice(0, turns.length, virtualRow)
  assert.equal(fileApi.beginFileSend('deepseek-card', [image]), 'ok')
  fileApi.fileSelectionApplied('deepseek-card')
  draftImages = 1
  button.cssDisabled = true
  assert.equal(fileApi.fileSendStatus('deepseek-card').status, 'uploading')
  button.cssDisabled = false
  clickAction = () => { draftImages = 0 }
  assert.equal(fileApi.submitFileSend('deepseek-card'), true)
  assert.equal(fileApi.fileSendStatus('deepseek-card').status, 'confirming')
  turns[0] = { ...virtualRow }
  assert.equal(fileApi.fileSendStatus('deepseek-card').status, 'confirming')
  turns[0].position = '6'
  turns[0].textContent = ''
  assert.equal(fileApi.fileSendStatus('deepseek-card').status, 'confirming')
  turns[0].textContent = image.fileName
  assert.equal(fileApi.fileSendStatus('deepseek-card').status, 'sent')
  // Reuse the actual DOM node on a second send; the row position must advance.
  assert.equal(fileApi.beginFileSend('deepseek-recycled', [image]), 'ok')
  fileApi.fileSelectionApplied('deepseek-recycled')
  draftImages = 1
  clickAction = () => { draftImages = 0; turns[0].position = '8' }
  assert.equal(fileApi.submitFileSend('deepseek-recycled'), true)
  assert.equal(fileApi.fileSendStatus('deepseek-recycled').status, 'sent')
  assert.equal(fileApi.beginFileSend('deepseek-placeholder', [image]), 'ok')
  fileApi.fileSelectionApplied('deepseek-placeholder')
  draftImages = 1
  clickAction = () => {
    draftImages = 0
    turns[0].position = '10'
    turns.push({ ...virtualRow, position: '11', textContent: '' })
  }
  assert.equal(fileApi.submitFileSend('deepseek-placeholder'), true)
  assert.equal(fileApi.fileSendStatus('deepseek-placeholder').status, 'sent')
  // The failing live log had no numeric baseline, then a numeric placeholder,
  // then a file-bearing row with no numeric position. Exercise that key mix.
  const opaqueRow = { ...virtualRow, position: 'old-user-key' }
  const reasoningRow = {
    ...virtualRow, position: '9', textContent: image.fileName,
    querySelector: selector => selector === '.ds-think-content' ? {} : null
  }
  turns.splice(0, turns.length, opaqueRow, reasoningRow)
  assert.equal(fileApi.beginFileSend('deepseek-opaque', [image]), 'ok')
  fileApi.fileSelectionApplied('deepseek-opaque')
  draftImages = 1
  clickAction = () => { draftImages = 0; turns[0] = { ...opaqueRow } }
  assert.equal(fileApi.submitFileSend('deepseek-opaque'), true)
  const oldOpaqueStatus = fileApi.fileSendStatus('deepseek-opaque')
  assert.equal(oldOpaqueStatus.status, 'confirming')
  assert.equal(oldOpaqueStatus.baselinePositionAvailable, false)
  assert.equal(oldOpaqueStatus.baselineKeyCount, 1)
  assert.equal(oldOpaqueStatus.turnKeyKnown, true)
  turns.push({ ...virtualRow, position: '8', textContent: '' })
  assert.equal(fileApi.fileSendStatus('deepseek-opaque').status, 'confirming')
  // A new reasoning row that mentions the name is not an acknowledgement.
  turns.push({ ...reasoningRow, position: 'new-reasoning-key' })
  assert.equal(fileApi.fileSendStatus('deepseek-opaque').status, 'confirming')
  turns.push({ ...opaqueRow, position: 'new-user-key' })
  assert.equal(fileApi.fileSendStatus('deepseek-opaque').status, 'sent')
  turns.splice(0, turns.length, { ...opaqueRow, position: 'recycled-opaque-old' })
  assert.equal(fileApi.beginFileSend('deepseek-opaque-recycled', [image]), 'ok')
  fileApi.fileSelectionApplied('deepseek-opaque-recycled')
  draftImages = 1
  clickAction = () => { draftImages = 0; turns[0].position = 'recycled-opaque-new' }
  assert.equal(fileApi.submitFileSend('deepseek-opaque-recycled'), true)
  assert.equal(fileApi.fileSendStatus('deepseek-opaque-recycled').status, 'sent')
  log('PASS mixed numeric/opaque keys, old opaque rerenders, reasoning exclusion and opaque DOM row reuse')
  // Run the actual command scanner too: a submitted but unconfirmed send used
  // to block this function forever, even after the main process finished.
  const commandEvents = []
  let assistantKey = 'next-command'
  pageContext.queryAllAssistant = () => [{}]
  pageContext.isAssistantTurn = () => true
  pageContext.turnKeyOf = () => assistantKey
  pageContext.readReplyText = () => '{"command":"Get-ChildItem -File","description":"列出文件","timeout_seconds":60}'
  pageContext.looksLikeReadFilesReply = () => false
  pageContext.looksLikeQuestionReply = () => false
  pageContext.extractCommand = text => { const value = JSON.parse(text); return { ...value, timeoutSeconds: value.timeout_seconds } }
  pageContext.noteScan = () => {}
  pageContext.report = event => { if (event.event === 'command') commandEvents.push(event) }
  pageContext.state.enabled = true
  const checkStart = injectedSource.indexOf('  const checkForCommand =')
  const checkEnd = injectedSource.indexOf('  const lastAssistantId =', checkStart)
  assert.ok(checkStart >= 0 && checkEnd > checkStart)
  vm.runInContext(injectedSource.slice(checkStart, checkEnd), pageContext)
  const scan = () => vm.runInContext('checkForCommand()', pageContext)
  let submitClicks = 0
  const beginUnconfirmed = token => {
    turns.splice(0, turns.length, { ...virtualRow, position: null })
    assert.equal(fileApi.beginFileSend(token, [image]), 'ok')
    fileApi.fileSelectionApplied(token)
    draftImages = 1
    clickAction = () => { submitClicks++; draftImages = 0 }
    assert.equal(fileApi.submitFileSend(token), true)
    assert.equal(fileApi.fileSendStatus(token).status, 'confirming')
  }
  beginUnconfirmed('expired-confirmation')
  fileApi.releaseFileSend('wrong-token')
  scan()
  assert.equal(commandEvents.length, 0)
  assert.equal(scheduledChecks.length, 0)
  fileApi.releaseFileSend('expired-confirmation')
  assert.equal(pageContext.state.programmatic, false)
  assert.equal(fileApi.fileSendStatus('expired-confirmation').status, 'stale')
  assert.equal(scheduledChecks.length, 1)
  // The old assistant turn is still baselined; releasing does not reset dedup.
  assistantKey = 'previous-assistant'
  scan()
  assert.equal(commandEvents.length, 0)
  assistantKey = 'next-command'
  scheduledChecks.shift()()
  assert.equal(commandEvents.length, 1)
  assert.equal(commandEvents[0].live, true)
  assert.equal(commandEvents[0].command, 'Get-ChildItem -File')
  scan()
  fileApi.releaseFileSend('expired-confirmation')
  assert.equal(commandEvents.length, 1)
  assert.equal(submitClicks, 1)
  assert.equal(scheduledChecks.length, 0)
  // Before submission, preserve the selected draft for an explicit retry.
  assert.equal(fileApi.beginFileSend('retry-before-submit', [image]), 'ok')
  fileApi.fileSelectionApplied('retry-before-submit')
  draftImages = 1
  fileApi.releaseFileSend('retry-before-submit')
  assert.equal(scheduledChecks.length, 0)
  assert.equal(fileApi.beginFileSend('retry-before-submit', [image]), 'resume')
  assert.equal(fileApi.submitFileSend('retry-before-submit'), true)
  pageContext.state.enabled = false
  fileApi.releaseFileSend('retry-before-submit')
  assert.equal(scheduledChecks.length, 0)
  pageContext.state.enabled = true
  beginUnconfirmed('old-page-baseline')
  pageContext.state.awaitingReplySince = 0
  fileApi.releaseFileSend('old-page-baseline')
  assert.equal(scheduledChecks.length, 0)
  // Normal confirmation also schedules a scan for an already-rendered reply.
  turns.splice(0, turns.length, { ...virtualRow, position: '20' })
  assert.equal(fileApi.beginFileSend('confirmed-next-command', [image]), 'ok')
  fileApi.fileSelectionApplied('confirmed-next-command')
  draftImages = 1
  clickAction = () => { submitClicks++; draftImages = 0; turns[0].position = '22' }
  assert.equal(fileApi.submitFileSend('confirmed-next-command'), true)
  assert.equal(fileApi.fileSendStatus('confirmed-next-command').status, 'sent')
  assert.equal(scheduledChecks.length, 1)
  assistantKey = 'command-after-confirmation'
  scheduledChecks.shift()()
  assert.equal(commandEvents.length, 2)
  scan()
  assert.equal(commandEvents.length, 2)
  log('PASS confirmation release resumes the real command scanner once, preserves dedup/drafts and respects disabled/history state')
  const deepseekInput = { accept: '.txt,.md,.js', multiple: true, disabled: false, setAttribute() {}, removeAttribute() {} }
  pageContext.attachmentRoot = () => ({ querySelectorAll: () => [deepseekInput] })
  pageContext.document.querySelectorAll = () => [deepseekInput]
  assert.equal(fileApi.beginFileSend('deepseek-unsupported', [{ fileName: '.gitconfig', mimeType: 'application/octet-stream', sizeBytes: 287 }]), 'unsupported-file-type')
  assert.equal(chooseInput([{ fileName: '.gitconfig.txt', mimeType: 'text/plain' }], [deepseekInput], []), deepseekInput)
  pageContext.attachmentRoot = () => ({ querySelectorAll: () => [] })
  pageContext.document.querySelectorAll = () => []
  assert.equal(fileApi.beginFileSend('deepseek-missing-input', [image]), 'no-file-input')
  log('PASS DeepSeek prompt gating, custom disabled controls, filename cards, old-row rejection and recycled row confirmation')
  const base = { type: 'read_files', files: [{ path: 'sample.txt' }], description: '读取样例' }
  const scannerStart = injectedSource.indexOf('  const balancedObjects =')
  const scannerEnd = injectedSource.indexOf('  const readJsonishString =', scannerStart)
  const parserStart = injectedSource.indexOf('  const looksLikeReadFilesReply =')
  const parserEnd = injectedSource.indexOf('  // Questions have their own discriminator.', parserStart)
  assert.ok(scannerStart >= 0 && scannerEnd > scannerStart && parserStart >= 0 && parserEnd > parserStart)
  const extractFiles = vm.runInNewContext(injectedSource.slice(scannerStart, scannerEnd) + '\n' +
    injectedSource.slice(parserStart, parserEnd) + '\nextractReadFiles')
  for (const count of [0, 1, 2, 3, 4, 5, 6]) {
    const request = { ...base, files: Array.from({ length: count }, (_, index) => ({ path: `sample-${index}.txt` })) }
    const accepted = count >= 1 && count <= 3
    assert.equal(parseReadFilesRequest(request) !== null, accepted, `Main-process ${count}-file boundary`)
    assert.equal(extractFiles(JSON.stringify(request)) !== null, accepted, `Injected ${count}-file boundary`)
  }
  for (const count of [0, 4, 5]) {
    let reads = 0
    const request = { ...base, files: Array.from({ length: count }, (_, index) => ({ path: `sample-${index}.txt` })),
      context: { scope: 'ssh', hostId: 'fixture', cwd: '/srv' } }
    await assert.rejects(prepareFiles(request, new AbortController().signal, async () => {
      reads++
      return Buffer.from('must not read')
    }), /最多读取 3 个文件/)
    assert.equal(reads, 0, 'Oversized stored requests must fail before reading any file')
  }
  log('PASS three-file limit in both request parsers, platform prompts and stored-request preparation')
  const valid = parseReadFilesRequest(base)
  assert.deepEqual(valid.files, [{ path: 'sample.txt' }])
  const legacy = parseReadFilesRequest({ ...base, files: [{ path: ' sample.txt ', mode: 'text', start_line: 2, max_lines: 1, encoding: 'gb18030' }] })
  assert.deepEqual(legacy, valid)
  for (const invalid of [
    { ...base, command: 'echo x' }, { ...base, questions: [] }, { ...base, description: ' ' },
    { ...base, files: [] }, { ...base, files: Array(4).fill({ path: 'x' }) },
    { ...base, files: [{ path: 'x\0y' }] }, { ...base, files: [{ path: ' ' }] },
    { ...base, files: [{ path: 42 }] }, { ...base, files: [{ path: 'x'.repeat(4097) }] }
  ]) assert.equal(parseReadFilesRequest(invalid), null)
  log('PASS path-only request validation, legacy normalization and injected-script syntax')
  function fakePage(begin, afterSubmit, url = 'https://chatgpt.com/c/test', options = {}) {
    const debug = new EventEmitter()
    let attached = false
    const selected = []
    const commands = []
    debug.isAttached = () => attached
    debug.attach = () => { attached = true }
    debug.detach = () => { attached = false }
    debug.sendCommand = async (method, params) => {
      commands.push({ method, params })
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } }
      if (method === 'DOM.querySelector') return { nodeId: 2 }
      if (method === 'DOM.setFileInputFiles') {
        selected.push(params.files)
        if (options.chooser) assert.equal(params.backendNodeId, 45)
        if (options.uploadFailure || options.unrelatedFailure) {
          const requestId = 'fake-network-request'
          debug.emit('message', {}, 'Network.requestWillBeSent', { requestId, request: { method: 'POST', headers: options.uploadFailure ? { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'upload, finalize' } : {} } })
          debug.emit('message', {}, 'Network.responseReceived', { requestId, response: { status: 401 } })
          debug.emit('message', {}, 'Network.loadingFinished', { requestId })
        }
        if (options.selectionException) throw new Error('fixture selection failed')
      }
      return {}
    }
    let submits = 0
    let chooserCalls = 0
    const begins = []
    const page = {
      debugger: debug, getURL: () => url, isDestroyed: () => false,
      executeJavaScript: async code => {
        if (code.includes('.beginFileSend(')) {
          begins.push(JSON.parse('[' + code.slice(code.indexOf('.beginFileSend(') + '.beginFileSend('.length, -1) + ']'))
          return begin
        }
        if (code.includes('.openFileChooser(')) {
          chooserCalls++
          assert.equal(commands.findLast(command => command.method === 'Page.setInterceptFileChooserDialog').params.enabled, true, 'Intercept before opening local native chooser')
          options.onChooser?.()
          if (options.noLocalEntry) return false
          if (chooserCalls <= (options.menuSteps || 0)) return 'waiting'
          debug.emit('message', {}, 'Page.fileChooserOpened', { backendNodeId: 45, mode: options.singleChooser ? 'selectSingle' : 'selectMultiple' })
          return options.directTile ? 'waiting' : true
        }
        if (code.includes('.submitFileSend(')) { submits++; afterSubmit?.(); return true }
        if (code.includes('.fileSendStatus(')) return { status: submits ? 'sent' : 'ready' }
        return true
      }
    }
    return { page, selected, begins, commands, submits: () => submits, chooserCalls: () => chooserCalls }
  }
  const mockAttachment = { path: path.join(os.tmpdir(), 'gpt-read-files-mock.txt'), fileName: 'mock.txt', mimeType: 'text/plain', sizeBytes: 1, sha256: '' }
  const empty = fakePage('ok')
  assert.equal(await sendChatGptFiles(empty.page, [], 'files-test-empty', () => true, new AbortController().signal), 'upload-failed')
  assert.equal(empty.begins.length, 0)
  assert.equal(empty.submits(), 0)
  const blocked = fakePage('busy')
  assert.equal(await sendChatGptFiles(blocked.page, [mockAttachment], 'files-test-busy', () => true, new AbortController().signal), 'busy')
  assert.equal(blocked.submits(), 0)
  const sent = fakePage('ok')
  assert.equal(await sendChatGptFiles(sent.page, [mockAttachment], 'files-test-send', () => true, new AbortController().signal), 'ok')
  assert.equal(sent.submits(), 1)
  assert.equal(sent.begins[0].length, 2)
  assert.deepEqual(sent.begins[0], ['files-test-send', [{ fileName: 'mock.txt', mimeType: 'text/plain', sizeBytes: 1 }]])
  let live = true
  const fast = fakePage('ok', () => { live = false })
  assert.equal(await sendChatGptFiles(fast.page, [mockAttachment], 'files-test-fast', () => live, new AbortController().signal), 'ok')
  assert.equal(fast.submits(), 1)
  const abortSend = new AbortController()
  abortSend.abort()
  const cancelled = fakePage('ok')
  assert.equal(await sendChatGptFiles(cancelled.page, [mockAttachment], 'files-test-cancel', () => true, abortSend.signal), 'cancelled')
  assert.equal(cancelled.submits(), 0)
  const deepseek = fakePage('ok', null, 'https://chat.deepseek.com/a/chat/s/test')
  assert.equal(await sendPageFiles(deepseek.page, 'deepseek', [mockAttachment], 'files-test-deepseek', () => true, new AbortController().signal), 'ok')
  assert.equal(deepseek.submits(), 1)
  assert.deepEqual(deepseek.begins[0], ['files-test-deepseek', [{ fileName: 'mock.txt', mimeType: 'text/plain', sizeBytes: 1 }]])
  assert.deepEqual(deepseek.selected, [[mockAttachment.path]])
  assert.equal(deepseek.page.debugger.isAttached(), false)
  assert.equal(deepseek.page.debugger.listenerCount('message'), 0)
  const claude = fakePage('ok', null, 'https://claude.ai/chat/test')
  assert.equal(await sendPageFiles(claude.page, 'claude', [mockAttachment], 'files-test-claude', () => true, new AbortController().signal), 'ok')
  assert.equal(claude.submits(), 1)
  assert.deepEqual(claude.begins[0], ['files-test-claude', [{ fileName: 'mock.txt', mimeType: 'text/plain', sizeBytes: 1 }]])
  assert.deepEqual(claude.selected, [[mockAttachment.path]])
  assert.equal(claude.page.debugger.isAttached(), false)
  assert.equal(claude.page.debugger.listenerCount('message'), 0)
  const gemini = fakePage('ok', null, 'https://gemini.google.com/app/test', { chooser: true, unrelatedFailure: true })
  assert.equal(await sendPageFiles(gemini.page, 'gemini', [mockAttachment], 'files-test-gemini', () => true, new AbortController().signal), 'ok')
  assert.equal(gemini.submits(), 1)
  assert.deepEqual(gemini.selected, [[mockAttachment.path]])
  assert.equal(gemini.commands.some(command => command.method === 'DOM.querySelector'), false, 'Use the transient chooser backend node, not a guessed permanent input')
  assert.equal(gemini.commands.findLast(command => command.method === 'Page.setInterceptFileChooserDialog').params.enabled, false)
  for (const [name, options, expectedCalls] of [
    ['compact-direct', { chooser: true, directTile: true }, 1],
    ['compact-submenu', { chooser: true, menuSteps: 2 }, 3]
  ]) {
    const compact = fakePage('ok', null, 'https://gemini.google.com/app/test', options)
    assert.equal(await sendPageFiles(compact.page, 'gemini', [mockAttachment], `files-test-gemini-${name}`, () => true, new AbortController().signal), 'ok')
    assert.equal(compact.chooserCalls(), expectedCalls)
    assert.equal(compact.submits(), 1)
    assert.deepEqual(compact.selected, [[mockAttachment.path]])
    assert.equal(compact.commands.findLast(command => command.method === 'Page.setInterceptFileChooserDialog').params.enabled, false)
  }
  const geminiAbort = new AbortController()
  for (const [name, options, outcome, signal] of [
    ['missing-local-entry', { chooser: true, noLocalEntry: true }, 'upload-failed', new AbortController().signal],
    ['selection-exception', { chooser: true, selectionException: true }, 'upload-failed', new AbortController().signal],
    ['resumable-upload-failure', { chooser: true, uploadFailure: true }, 'upload-failed', new AbortController().signal],
    ['cancelled-chooser', { chooser: true, onChooser: () => geminiAbort.abort() }, 'cancelled', geminiAbort.signal]
  ]) {
    const candidate = fakePage('ok', null, 'https://gemini.google.com/app/test', options)
    assert.equal(await sendPageFiles(candidate.page, 'gemini', [mockAttachment], `files-test-gemini-${name}`, () => true, signal), outcome)
    assert.equal(candidate.submits(), 0)
    assert.equal(candidate.commands.findLast(command => command.method === 'Page.setInterceptFileChooserDialog').params.enabled, false, 'Release chooser interception even when selection fails/cancels')
    assert.equal(candidate.page.debugger.isAttached(), false)
    assert.equal(candidate.page.debugger.listenerCount('message'), 0)
  }
  const singleChooser = fakePage('ok', null, 'https://gemini.google.com/app/test', { chooser: true, singleChooser: true })
  assert.equal(await sendPageFiles(singleChooser.page, 'gemini', [mockAttachment, mockAttachment], 'files-test-gemini-not-multiple', () => true, new AbortController().signal), 'upload-failed')
  assert.equal(singleChooser.selected.length, 0)
  assert.equal(singleChooser.submits(), 0)
  log('PASS Gemini transient CDP chooser selection, direct Files/submenu polling, unrelated Google errors, resumable upload failures, cancellation/exception cleanup and single submission')
  const unsupported = fakePage('unsupported-file-type', null, 'https://chat.deepseek.com/a/chat/s/test')
  assert.equal(await sendPageFiles(unsupported.page, 'deepseek', [mockAttachment], 'files-test-unsupported', () => true, new AbortController().signal), 'unsupported-file-type')
  assert.equal(unsupported.selected.length, 0)
  assert.equal(unsupported.submits(), 0)
  log('PASS no empty messages, no metadata payload, busy composer, single submission, fast next action and cancellation')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-read-files-check-'))
  const prepared = []
  try {
    // Larger fixture sets use separate legal calls; the tool itself does not
    // silently split or truncate an oversized request.
    async function prepareFixtureBatches(request, platform) {
      const batches = []
      for (let offset = 0; offset < request.files.length; offset += 3) {
        const result = await prepareFiles({ ...request, files: request.files.slice(offset, offset + 3) },
          new AbortController().signal, undefined, platform)
        prepared.push(result)
        batches.push(result)
      }
      return { failed: batches.some(result => result.failed),
        attachments: batches.flatMap(result => result.attachments),
        text: batches.map(result => result.text).join('\n') }
    }
    fs.writeFileSync(path.join(root, 'sample.txt'), 'source content\r\nsecond line\r\n')
    fs.writeFileSync(path.join(root, 'sample.ts'), 'export const value = 42\r\n')
    fs.writeFileSync(path.join(root, 'utf16.txt'), Buffer.concat([Buffer.from([255, 254]), Buffer.from('原始编码\r\n', 'utf16le')]))
    fs.writeFileSync(path.join(root, 'sample.bin'), Buffer.from([0, 255, 254, 1, 2]))
    fs.writeFileSync(path.join(root, 'empty.txt'), '')
    fs.writeFileSync(path.join(root, 'large.txt'), Buffer.alloc(3 * 1024 * 1024, 65))
    fs.writeFileSync(path.join(root, 'sample.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7V0AAAAASUVORK5CYII=', 'base64'))
    const request = { ...parseReadFilesRequest({ ...base, files: [{ path: 'sample.txt' }, { path: 'sample.png' }, { path: 'missing.txt' }] }), context: { scope: 'local', hostId: '', cwd: root } }
    const result = await prepareFiles(request, new AbortController().signal)
    prepared.push(result)
    assert.equal(result.failed, true)
    assert.equal(result.attachments.length, 2)
    assert.equal(result.images.length, 1)
    assert.doesNotMatch(result.text, /source content|second line|total_lines|next_start_line/)
    for (const attachment of result.attachments) {
      assert.notEqual(attachment.path, path.join(root, attachment.fileName))
      assert.deepEqual(fs.readFileSync(attachment.path), fs.readFileSync(path.join(root, attachment.fileName)))
    }
    const uploaded = fakePage('ok')
    assert.equal(await sendChatGptFiles(uploaded.page, result.attachments, 'files-test-upload', () => true, new AbortController().signal), 'ok')
    assert.deepEqual(uploaded.selected, [result.attachments.map(file => file.path)])
    assert.equal(uploaded.submits(), 1)
    assert.equal(uploaded.page.debugger.isAttached(), false)
    assert.equal(uploaded.page.debugger.listenerCount('message'), 0)
    await result.cleanup()
    assert.equal(fs.existsSync(path.join(root, 'sample.png')), true)
    assert.equal(fs.readFileSync(path.join(root, 'sample.txt'), 'utf8'), 'source content\r\nsecond line\r\n')
    const originals = await prepareFixtureBatches({ ...legacy, files: [{ path: 'sample.ts' }, { path: 'utf16.txt', mode: 'text', start_line: 2, max_lines: 1, encoding: 'gb18030' }, { path: 'sample.bin' }, { path: 'large.txt' }], context: request.context })
    assert.equal(originals.failed, false)
    assert.equal(originals.attachments.length, 4)
    assert.equal(originals.attachments[0].mimeType, 'text/plain')
    assert.equal(originals.attachments[2].mimeType, 'application/octet-stream')
    for (const attachment of originals.attachments) assert.deepEqual(fs.readFileSync(attachment.path), fs.readFileSync(path.join(root, attachment.fileName)))
    assert.doesNotMatch(originals.text, /export const value|原始编码|total_lines|next_start_line/)
    log('PASS text/source/image/binary attachments, unchanged bytes, CDP selection and source preservation')
    const configBytes = Buffer.from('[core]\r\n\teditor = code --wait\r\n# UTF-8 文本\r\n')
    fs.writeFileSync(path.join(root, '.gitconfig'), configBytes)
    fs.writeFileSync(path.join(root, 'Makefile'), 'all:\n\techo example\n')
    fs.writeFileSync(path.join(root, 'rawbinary'), Buffer.from([0, 1, 2, 3]))
    fs.writeFileSync(path.join(root, 'nonutf8'), Buffer.from([0xff, 0xfe, 65, 0]))
    const configRequest = { ...valid, files: ['.gitconfig', 'Makefile', 'rawbinary', 'nonutf8', 'sample.ts'].map(file => ({ path: file })), context: request.context }
    const nativeConfigs = await prepareFixtureBatches(configRequest, 'chatgpt')
    const deepseekConfigs = await prepareFixtureBatches(configRequest, 'deepseek')
    const claudeConfigs = await prepareFixtureBatches(configRequest, 'claude')
    assert.equal(deepseekConfigs.failed, false)
    assert.deepEqual(deepseekConfigs.attachments.map(file => file.fileName), ['.gitconfig.txt', 'Makefile.txt', 'rawbinary', 'nonutf8', 'sample.ts'])
    assert.equal(deepseekConfigs.attachments[0].mimeType, 'text/plain')
    assert.equal(deepseekConfigs.attachments[0].textNameAlias, true)
    assert.equal(deepseekConfigs.attachments[2].textNameAlias, false)
    assert.equal(deepseekConfigs.attachments[3].textNameAlias, false)
    assert.deepEqual(nativeConfigs.attachments.map(file => file.fileName), ['.gitconfig', 'Makefile', 'rawbinary', 'nonutf8', 'sample.ts'])
    assert.deepEqual(claudeConfigs.attachments.map(file => file.fileName), nativeConfigs.attachments.map(file => file.fileName))
    for (const [index, file] of claudeConfigs.attachments.entries()) {
      assert.equal(file.textNameAlias, false)
      assert.deepEqual(fs.readFileSync(file.path), fs.readFileSync(path.join(root, configRequest.files[index].path)))
    }
    for (const [index, file] of deepseekConfigs.attachments.entries()) assert.deepEqual(fs.readFileSync(file.path), fs.readFileSync(path.join(root, configRequest.files[index].path)))
    assert.deepEqual(fs.readFileSync(path.join(root, '.gitconfig')), configBytes)
    assert.match(deepseekConfigs.text, /临时附件增加 \.txt 后缀/)
    assert.doesNotMatch(deepseekConfigs.text, /editor = code|UTF-8 文本/)
    assert.equal(chooseInput([deepseekConfigs.attachments[0]], [deepseekInput], []), deepseekInput)
    const configPage = fakePage('ok', null, 'https://chat.deepseek.com/a/chat/s/test')
    assert.equal(await sendPageFiles(configPage.page, 'deepseek', [deepseekConfigs.attachments[0]], 'files-test-config', () => true, new AbortController().signal), 'ok')
    assert.deepEqual(configPage.begins[0], ['files-test-config', [{ fileName: '.gitconfig.txt', mimeType: 'text/plain', sizeBytes: configBytes.length }]])
    assert.deepEqual(configPage.selected, [[deepseekConfigs.attachments[0].path]])
    assert.equal(configPage.submits(), 1)
    fs.writeFileSync(path.join(root, '.gitconfig.txt'), 'a different source file\n')
    const configCollision = await prepareFiles({ ...configRequest, files: [{ path: '.gitconfig' }, { path: '.gitconfig.txt' }] }, new AbortController().signal, undefined, 'deepseek')
    prepared.push(configCollision)
    assert.equal(configCollision.failed, true)
    assert.equal(configCollision.attachments.length, 1)
    assert.equal(fs.readFileSync(path.join(root, '.gitconfig.txt'), 'utf8'), 'a different source file\n')
    log('PASS DeepSeek extensionless UTF-8 text alias, unsupported types, byte preservation, binary rejection and native ChatGPT names')
    fs.writeFileSync(path.join(root, 'oversized.txt'), '')
    fs.truncateSync(path.join(root, 'oversized.txt'), MAX_FILE_BYTES + 1)
    const oversized = await prepareFiles({ ...valid, files: [{ path: 'oversized.txt' }, { path: 'empty.txt' }], context: request.context }, new AbortController().signal)
    prepared.push(oversized)
    assert.equal(oversized.failed, true)
    assert.equal(oversized.attachments.length, 0)
    assert.match(oversized.text, /超过 20 MiB/)
    assert.match(oversized.text, /空文件不能作为附件上传/)
    const remote = { ...valid, context: { scope: 'ssh', hostId: 'test-host', cwd: '/srv/project' } }
    assert.equal(resolveFilePath(remote, '../sample.txt'), '/srv/sample.txt')
    const remoteResult = await prepareFiles(remote, new AbortController().signal, async file => { assert.equal(file, '/srv/project/sample.txt'); return Buffer.from('remote text') })
    prepared.push(remoteResult)
    assert.equal(remoteResult.attachments.length, 1)
    assert.deepEqual(fs.readFileSync(remoteResult.attachments[0].path), Buffer.from('remote text'))
    assert.doesNotMatch(remoteResult.text, /remote text/)
    const remoteConfig = await prepareFiles({ ...remote, files: [{ path: '.gitconfig' }] }, new AbortController().signal, async file => {
      assert.equal(file, '/srv/project/.gitconfig')
      return configBytes
    }, 'deepseek')
    prepared.push(remoteConfig)
    assert.equal(remoteConfig.attachments[0].fileName, '.gitconfig.txt')
    assert.deepEqual(fs.readFileSync(remoteConfig.attachments[0].path), configBytes)
    const batch = await prepareFiles({ ...remote, files: [{ path: 'first.txt' }, { path: 'second.txt' }] }, new AbortController().signal, async () => Buffer.alloc(13 * 1024 * 1024, 65))
    prepared.push(batch)
    assert.equal(batch.failed, true)
    assert.equal(batch.attachments.length, 1)
    assert.match(batch.text, /合计超过 25 MiB/)
    log('PASS nonempty file requirement, per-file and batch upload limits')
    const unavailable = await prepareFiles(remote, new AbortController().signal)
    prepared.push(unavailable)
    assert.match(unavailable.text, /SSH 文件通道不可用/)
    assert.doesNotMatch(unavailable.text, /source content/)
    const abort = new AbortController()
    abort.abort()
    await assert.rejects(prepareFiles(request, abort.signal))
    log('PASS SSH path routing, unavailable backend and cancellation')
  } finally {
    for (const result of prepared) await result.cleanup()
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(root).startsWith('gpt-read-files-check-')) throw new Error('Invalid cleanup target')
    fs.rmSync(root, { recursive: true, force: true })
  }
  log('ALL CHECKS PASSED')
}
main().catch(error => { log(`FAIL ${error.stack}`); process.exitCode = 1 }).finally(() => console.log(`日志：${logFile}`))
