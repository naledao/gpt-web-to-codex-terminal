/** User-run offline scroll lifecycle checks. No Electron, application data or network. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const logDir = path.join(os.tmpdir(), 'gpt-login-diag')
fs.mkdirSync(logDir, { recursive: true })
const logFile = path.join(logDir, `conversation-scroll-check-${Date.now()}.log`)
const log = message => { fs.appendFileSync(logFile, message + '\n'); console.log(message) }

function fixture(storage = new Map()) {
  let nextFrame = 0
  const frames = new Map(), observers = []
  const window = {
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    requestAnimationFrame: callback => { frames.set(++nextFrame, callback); return nextFrame },
    cancelAnimationFrame: id => frames.delete(id)
  }
  class ResizeObserver {
    constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this) }
    observe() {}
    disconnect() { this.disconnected = true }
  }
  const exports = {}
  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/src/conversation-scroll.ts'), 'utf8')
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText, { exports, window, ResizeObserver })
  const flush = () => {
    for (let turn = 0; frames.size && turn < 10; turn++) {
      const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback())
    }
    assert.equal(frames.size, 0, 'Scheduled work must settle')
  }
  const resize = () => { observers.filter(observer => !observer.disconnected).forEach(observer => observer.callback()); flush() }
  const viewport = (heights = [220, 380, 500, 400]) => {
    let top = 0
    const listeners = new Map()
    const element = {
      heights, clientHeight: 400,
      get scrollHeight() { return this.heights.reduce((sum, height) => sum + height, 64) },
      get scrollTop() { return top },
      set scrollTop(value) { top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)) },
      getBoundingClientRect: () => ({ top: 100, bottom: 500 }),
      querySelectorAll() { return this.heights.map((height, index) => ({
        dataset: { messageId: `fixture-message-${index}` },
        getBoundingClientRect: () => {
          const messageTop = 100 + this.heights.slice(0, index).reduce((sum, value) => sum + value, 32) - top
          return { top: messageTop, bottom: messageTop + height }
        }
      })) },
      addEventListener: (name, handler) => listeners.set(name, handler),
      removeEventListener: name => listeners.delete(name),
      emitScroll: () => listeners.get('scroll')?.(),
      userScroll(value) { this.scrollTop = value; this.emitScroll() },
      listeners
    }
    return element
  }
  return { ...exports, storage, frames, observers, window, flush, resize, viewport }
}

try {
  log(`Log: ${logFile}`)
  const f = fixture(), key = f.conversationScrollKey('session-a', 'chatgpt', 'conversation-a')
  let away = false
  const first = f.viewport()
  let binding = f.attachConversationScroll(first, {}, key, value => { away = value })
  assert.equal(first.scrollTop, first.scrollHeight - first.clientHeight)
  assert.equal(away, false)
  first.userScroll(250); f.flush()
  assert.equal(away, true)
  binding.dispose()
  const restored = f.viewport()
  binding = f.attachConversationScroll(restored, {}, key, value => { away = value })
  assert.equal(restored.scrollTop, 250)
  restored.emitScroll(); f.flush()
  restored.heights[0] += 160; f.resize()
  assert.equal(restored.scrollTop, 410, 'Late image growth above the anchor keeps the same message in view')
  restored.heights.push(700); f.resize()
  assert.equal(restored.scrollTop, 410, 'An appended reply cannot pull a history reader to the bottom')
  binding.toBottom()
  assert.equal(restored.scrollTop, restored.scrollHeight - restored.clientHeight)
  assert.equal(away, false)
  restored.heights.push(200); f.resize()
  assert.equal(restored.scrollTop, restored.scrollHeight - restored.clientHeight)
  restored.userScroll(500)
  // Simulate a layout change before the saved scroll frame runs.
  restored.heights.push(100); f.resize()
  assert.equal(restored.scrollTop, 500, 'A user scroll stops following even when a resize is pending')
  binding.dispose()
  assert.equal(restored.listeners.size, 0)
  assert.ok(f.observers.every(observer => observer.disconnected))
  assert.equal(f.frames.size, 0)
  log('PASS view remount restoration, late images, appended replies, bottom button/following and teardown')

  for (const otherKey of [
    f.conversationScrollKey('session-b', 'chatgpt', 'conversation-a'),
    f.conversationScrollKey('session-a', 'deepseek', 'conversation-a'),
    f.conversationScrollKey('session-a', 'chatgpt', 'conversation-b')
  ]) {
    const other = f.viewport()
    const otherBinding = f.attachConversationScroll(other, {}, otherKey, () => {})
    assert.equal(other.scrollTop, other.scrollHeight - other.clientHeight)
    otherBinding.dispose()
  }
  // A new module instance represents a renderer reload; only fake storage is retained.
  const reloaded = fixture(f.storage), again = reloaded.viewport([380, 380, 500, 400, 700, 200, 100])
  const againBinding = reloaded.attachConversationScroll(again, {}, key, () => {})
  assert.equal(again.scrollTop, 500)
  againBinding.dispose()
  log('PASS workspace/platform/conversation isolation and persistence across a renderer reload')

  const shrinkKey = f.conversationScrollKey('late-layout', 'chatgpt', 'conversation-a')
  const before = f.viewport()
  const beforeBinding = f.attachConversationScroll(before, {}, shrinkKey, () => {})
  before.userScroll(250); beforeBinding.dispose()
  const short = f.viewport([60, 80])
  const shortBinding = f.attachConversationScroll(short, {}, shrinkKey, () => {})
  short.emitScroll(); f.flush()
  short.heights = [220, 380, 500, 400]; f.resize()
  assert.equal(short.scrollTop, 250, 'Temporary short content must not erase the remembered coordinate/anchor')
  shortBinding.dispose()
  f.window.localStorage.getItem = () => { throw new Error('storage unavailable') }
  f.window.localStorage.setItem = () => { throw new Error('storage unavailable') }
  const fallbackKey = f.conversationScrollKey('memory-only', 'chatgpt', 'conversation-a')
  const fallback = f.viewport()
  const fallbackBinding = f.attachConversationScroll(fallback, {}, fallbackKey, () => {})
  fallback.userScroll(320); fallbackBinding.dispose()
  const fallbackRestored = f.viewport()
  const fallbackRestoredBinding = f.attachConversationScroll(fallbackRestored, {}, fallbackKey, () => {})
  assert.equal(fallbackRestored.scrollTop, 320)
  fallbackRestoredBinding.dispose()
  log('PASS temporarily short content and unavailable localStorage retain the in-memory reading position')
  log('PASS all offline conversation scroll checks; real UI behavior still requires user testing')
} catch (error) {
  log(`FAIL ${error.stack || error}`)
  process.exitCode = 1
}
