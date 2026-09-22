/*
 * Injected into the chatgpt.com page's MAIN WORLD by src/main/embed.ts.
 *
 * It is plain browser JavaScript on purpose: it does not run in the app's
 * process, has no access to `window.api`, and must not be type-checked against
 * the Node/Electron libs. It is bundled as a string via Vite's `?raw` import.
 *
 * Two jobs:
 *
 *  1. OUTBOUND — intercept the moment a message is about to be sent, prepend a
 *     fixed system prompt inside the composer, and only then actually submit.
 *
 *  2. INBOUND — watch the thread for the assistant's reply, pull the JSON
 *     command out of it, and report it to the main process so it can be run.
 *     It also exposes `sendRaw()`, which the main process uses to feed command
 *     output back into the conversation WITHOUT the system prompt.
 *
 * Why the composer needs such careful handling: ChatGPT's input is a
 * ProseMirror editor (`#prompt-textarea`, a contenteditable div). Writing to
 * `innerHTML` does NOT work — ProseMirror owns the document state and will
 * overwrite it, and the send button stays disabled. `document.execCommand(
 * 'insertText')` goes through the browser's editing pipeline, so ProseMirror
 * sees a normal user edit and updates its state.
 */
;(() => {
  const STATE_KEY = '__cmdTerminalInterceptor'
  const COMPOSER_SELECTOR = '#prompt-textarea'
  const SEND_BUTTON_SELECTORS = [
    '[data-testid="send-button"]',
    'button[aria-label="Send message"]',
    'button[aria-label="发送消息"]'
  ]
  const ASSISTANT_SELECTOR = '[data-message-author-role="assistant"]'
  const STOP_BUTTON_SELECTORS = [
    '[data-testid="stop-button"]',
    'button[aria-label="Stop generating"]',
    'button[aria-label="Stop streaming"]',
    'button[aria-label="停止生成"]'
  ]
  /** Any turn, either role — used to locate the thread's scroll container. */
  const MESSAGE_SELECTOR = '[data-message-author-role]'
  const MESSAGE_ID_ATTR = 'data-message-id'
  const LOG_TAG = '[cmd-terminal] '

  /**
   * How long the reply text must stop changing before we treat it as final.
   * The reply streams token by token; parsing mid-stream would read half a JSON
   * object, and a half-parsed command could be a DIFFERENT, still-valid command
   * (e.g. `{"command":"dir"}` before the real payload arrives).
   */
  const REPLY_SETTLE_MS = 800

  /** Retries before a send is declared stuck (~3s at 150ms per attempt). */
  const MAX_SEND_ATTEMPTS = 20
  /** Hard ceiling so a caller awaiting sendRaw() can never hang forever. */
  const SEND_TIMEOUT_MS = 10_000

  // Re-injection (e.g. after a reload) must not stack duplicate listeners.
  if (window[STATE_KEY]) return

  const state = {
    enabled: false,
    prefix: '',
    injectedCount: 0,
    /** True while WE are driving the composer; suppresses prefixing/interception. */
    programmatic: false,
    lastCommandMessageId: null,
    /**
     * Timestamp of the last message we sent, cleared once its reply is handled.
     *
     * This is the whole safety model: while it is set, the next assistant message
     * is a reply to us; when it is clear, whatever is on screen is history.
     */
    awaitingReplySince: 0,
    /** Dedupe for the "looked like a command but would not parse" report. */
    lastUnparsedMessageId: null
  }

  const report = (payload) => {
    try {
      console.log(LOG_TAG + JSON.stringify(payload))
    } catch (_) {
      /* never break the page because reporting failed */
    }
  }

  const collapse = (value) => (value || '').replace(/\s+/g, ' ').trim()

  const getComposer = () => document.querySelector(COMPOSER_SELECTOR)

  const findSendButton = () => {
    for (const selector of SEND_BUTTON_SELECTORS) {
      const button = document.querySelector(selector)
      if (button) return button
    }
    return null
  }

  const findStopButton = () => {
    for (const selector of STOP_BUTTON_SELECTORS) {
      const button = document.querySelector(selector)
      if (button) return button
    }
    return null
  }

  /* ------------------------------------------------------------------ *
   * Keeping the newest message in view
   * ------------------------------------------------------------------ */

  /**
   * The thread's scroll container.
   *
   * ChatGPT's class names are hashed and change without notice, so this is found
   * by BEHAVIOUR rather than by selector: the nearest ancestor that actually
   * overflows vertically. Walking up from the newest turn is tried first because
   * it is cheap and lands on the right element; the full scan is only a fallback
   * for the case where that chain has nothing scrollable in it.
   */
  const findScroller = () => {
    const nodes = document.querySelectorAll(MESSAGE_SELECTOR)
    let element = nodes.length > 0 ? nodes[nodes.length - 1].parentElement : null

    while (element) {
      const style = getComputedStyle(element)
      const scrolls = /(auto|scroll)/.test(style.overflowY)
      if (scrolls && element.scrollHeight > element.clientHeight + 4) return element
      element = element.parentElement
    }

    let best = null
    const all = document.querySelectorAll('div')
    for (let i = 0; i < all.length; i += 1) {
      const candidate = all[i]
      if (candidate.scrollHeight <= candidate.clientHeight + 4) continue
      if (!/(auto|scroll)/.test(getComputedStyle(candidate).overflowY)) continue
      // `>=`, not `>`: querySelectorAll returns document order, so on a tie the
      // later element is the INNER one. Between a wrapper and the thread inside
      // it, the thread is the one whose bottom actually matters.
      if (best === null || candidate.scrollHeight >= best.scrollHeight) best = candidate
    }
    return best
  }

  /**
   * Put the newest message back in view.
   *
   * A programmatic send does not make ChatGPT scroll the way a real click does:
   * the message we just injected, and the reply that follows it, land below the
   * fold and the user has to scroll by hand every single time. Its own
   * "stick to the bottom" heuristic is what the synthetic editing pipeline
   * appears to disturb, so the position is set outright instead of being
   * requested.
   *
   * `behavior: 'instant'` is deliberate. The thread is styled with smooth
   * scrolling, and an animated scroll here competes with the re-render that
   * immediately follows the send — the animation is cancelled part-way and
   * settles short, which is the same symptom in a new costume.
   */
  const scrollToBottom = () => {
    const target = findScroller()
    if (!target) return false
    const top = target.scrollHeight
    try {
      target.scrollTo({ top: top, behavior: 'instant' })
    } catch (_) {
      target.scrollTop = top
    }
    return true
  }

  /**
   * Re-assert the position for a moment after a send.
   *
   * The thread keeps growing as the new turn renders and again when the reply
   * starts, so a single scroll lands short. The window is short and fixed rather
   * than running until the reply finishes: past that point the user may be
   * reading something further up, and dragging them back would be worse than the
   * problem being fixed.
   */
  const SCROLL_SETTLE_MS = [0, 120, 350, 700, 1200]

  const scheduleScrollToBottom = () => {
    for (const delay of SCROLL_SETTLE_MS) {
      if (delay === 0) scrollToBottom()
      else setTimeout(scrollToBottom, delay)
    }
  }

  /* ------------------------------------------------------------------ *
   * Composer plumbing
   * ------------------------------------------------------------------ */

  /** True when the prefix is already sitting in the composer. */
  const hasPrefix = (element) => {
    if (!state.prefix) return true
    const head = collapse(state.prefix).slice(0, 40)
    return collapse(element.innerText).startsWith(head)
  }

  const placeCaretAtStart = (element) => {
    const range = document.createRange()
    range.selectNodeContents(element)
    range.collapse(true)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
  }

  const insertText = (element, text) => {
    element.focus()
    placeCaretAtStart(element)
    // Keep focus/selection honest so ProseMirror records a real edit.
    return document.execCommand('insertText', false, text)
  }

  /**
   * Clicking send is NOT proof that the message went out. ChatGPT ignores the
   * click while it is still finishing the previous turn, and the text then just
   * sits in the composer looking sent. The only trustworthy signal is that the
   * composer actually cleared — so verify, and retry until it does.
   *
   * `done` is only supplied for programmatic sends, so the caller can report the
   * real outcome instead of assuming success.
   */
  const submitWithRetry = (text, attempt, isRaw, done) => {
    const finish = (ok) => {
      state.programmatic = false
      if (ok) {
        // Once a message actually goes out, the next assistant turn is ours.
        state.awaitingReplySince = Date.now()
        // Mark the reply that is on screen right now as already handled, so it
        // cannot be mistaken for the answer.
        state.lastCommandMessageId = lastAssistantId()
        // The send landed, so the new turn is about to render below the fold.
        scheduleScrollToBottom()
      }
      report(
        ok
          ? isRaw
            ? { event: 'sent-raw', text: text.slice(0, 200) }
            : { event: 'sent', text: text.slice(0, 400) }
          : { event: 'send-failed', text: text.slice(0, 200) }
      )
      if (done) done(ok ? 'ok' : 'stuck')
    }

    const button = findSendButton()

    if (!button || button.disabled) {
      // The send button only enables once ProseMirror has committed the edit,
      // and it disappears entirely while a reply is streaming.
      if (attempt < MAX_SEND_ATTEMPTS) {
        setTimeout(() => submitWithRetry(text, attempt + 1, isRaw, done), 80)
      } else {
        finish(false)
      }
      return
    }

    button.click()

    setTimeout(() => {
      const element = getComposer()
      if (!element || collapse(element.innerText) === '') {
        finish(true)
        return
      }
      if (attempt < MAX_SEND_ATTEMPTS) {
        submitWithRetry(text, attempt + 1, isRaw, done)
      } else {
        finish(false)
      }
    }, 150)
  }

  /** @returns true when the event was consumed and the send was taken over. */
  const intercept = (event) => {
    // Our own sends must pass through untouched: no prefix, no interception.
    if (state.programmatic) return false
    if (!state.enabled || !state.prefix) return false

    const element = getComposer()
    if (!element) return false
    // Already injected for this draft: let ChatGPT send it normally.
    if (hasPrefix(element)) return false

    event.preventDefault()
    event.stopImmediatePropagation()

    const text = collapse(element.innerText)
    if (!insertText(element, state.prefix)) {
      // Injection refused: never trap the user's message in the box.
      report({ event: 'inject-failed' })
      submitWithRetry(text, 0, false)
      return true
    }

    state.injectedCount += 1
    report({ event: 'injected', count: state.injectedCount })
    setTimeout(() => submitWithRetry(text, 0, false), 60)
    return true
  }

  // Capture phase, on `document`: survives ChatGPT's client-side route changes,
  // and runs before React's own handlers on the composer.
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
      if (event.defaultPrevented || event.repeat) return
      const element = getComposer()
      if (!element || !element.contains(event.target)) return
      intercept(event)
    },
    true
  )

  document.addEventListener(
    'click',
    (event) => {
      const target = event.target
      if (!target || typeof target.closest !== 'function') return
      if (!SEND_BUTTON_SELECTORS.some((selector) => target.closest(selector))) return
      intercept(event)
    },
    true
  )

  /* ------------------------------------------------------------------ *
   * Inbound: find the command in the assistant's reply
   * ------------------------------------------------------------------ */

  /**
   * Pull every balanced top-level `{...}` out of `text`.
   * Brace counting is string-aware so braces inside quoted values do not
   * throw it off.
   */
  const balancedObjects = (text) => {
    const found = []
    let start = -1
    let depth = 0
    let inString = false
    let escaped = false

    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i]
      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') {
        inString = true
        continue
      }
      if (ch === '{') {
        if (depth === 0) start = i
        depth += 1
      } else if (ch === '}') {
        if (depth > 0) {
          depth -= 1
          if (depth === 0 && start >= 0) {
            found.push(text.slice(start, i + 1))
            start = -1
          }
        }
      }
    }
    return found
  }

  /**
   * The system prompt used to advertise the malformed example
   * `{"command":"","description",""}`. It is fixed now, but models sometimes
   * copy old habits, so repair the obvious variants before giving up.
   */
  const repairJson = (text) =>
    text
      // "key","value"  ->  "key":"value"
      .replace(/"([A-Za-z0-9_]+)"\s*,\s*("(?:[^"\\]|\\.)*")\s*([,}])/g, '"$1":$2$3')
      // trailing comma before } or ]
      .replace(/,\s*([}\]])/g, '$1')

  /**
   * Read a `"key": "value"` pair out of text that may not be valid JSON.
   *
   * The value ends at the first quote followed by `,` or `}` — that is what
   * separates the real terminator from the unescaped quotes the model leaves
   * inside a cmd command, which is full of them: `for /f "tokens=1"`,
   * `if not "%a"==""`, `cmd /c "..."`.
   *
   * A backslash only counts as an escape when a legal JSON escape follows it, so
   * an unescaped Windows path such as `C:\Users` survives intact.
   */
  const readJsonishString = (text, key) => {
    const match = new RegExp(`"${key}"\\s*:\\s*"`).exec(text)
    if (!match) return null

    let value = ''
    let i = match.index + match[0].length

    while (i < text.length) {
      const ch = text[i]

      if (ch === '\\' && i + 1 < text.length) {
        const next = text[i + 1]
        if (next === '"' || next === '\\' || next === '/') {
          value += next
          i += 2
          continue
        }
        if (next === 'n') {
          value += '\n'
          i += 2
          continue
        }
        if (next === 'r') {
          value += '\r'
          i += 2
          continue
        }
        if (next === 't') {
          value += '\t'
          i += 2
          continue
        }
        // Not a JSON escape — keep the backslash (a Windows path, most likely).
        value += '\\'
        i += 1
        continue
      }

      if (ch === '"') {
        if (/^\s*[,}]/.test(text.slice(i + 1))) return value
        // An unescaped quote inside the value.
        value += '"'
        i += 1
        continue
      }

      value += ch
      i += 1
    }

    return null
  }

  /**
   * Last resort for a reply whose JSON cannot be parsed.
   *
   * Dropping the command silently is the worst outcome available: the terminal
   * shows nothing at all, so nothing distinguishes "the model forgot to escape
   * its quotes" from "the model had nothing to say". It then looks like the app
   * simply stopped working.
   */
  const lenientCommand = (candidate) => {
    const command = readJsonishString(candidate, 'command')
    if (command === null) return null
    const description = readJsonishString(candidate, 'description')
    return { command: command.trim(), description: (description ?? '').trim() }
  }

  const toCommand = (candidate) => {
    for (const attempt of [candidate, repairJson(candidate)]) {
      let parsed
      try {
        parsed = JSON.parse(attempt)
      } catch (_) {
        continue
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      if (typeof parsed.command !== 'string') continue
      return {
        command: parsed.command.trim(),
        description: typeof parsed.description === 'string' ? parsed.description.trim() : ''
      }
    }

    // Both strict attempts failed — read the fields textually rather than
    // throwing the command away.
    return lenientCommand(candidate)
  }

  /** Take the LAST valid command object — "只运行最后一个命令". */
  const extractCommand = (rawText) => {
    const text = String(rawText || '')
    if (!text) return null

    // Drop markdown code fences but keep their contents.
    const cleaned = text.replace(/```[a-zA-Z0-9_-]*/g, '\n')
    const candidates = balancedObjects(cleaned)

    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      const parsed = toCommand(candidates[i])
      if (parsed) return parsed
    }
    return null
  }

  let settleTimer = null

  const scheduleCheck = () => {
    if (settleTimer) clearTimeout(settleTimer)
    settleTimer = setTimeout(checkForCommand, REPLY_SETTLE_MS)
  }

  /**
   * Runs after the reply has been quiet for REPLY_SETTLE_MS. Only the LAST
   * assistant message is considered, and each message id is reported at most
   * once — the main process does the durable deduplication against SQLite.
   */
  const checkForCommand = () => {
    const nodes = document.querySelectorAll(ASSISTANT_SELECTOR)
    if (nodes.length === 0) return

    const node = nodes[nodes.length - 1]
    const messageId = node.getAttribute(MESSAGE_ID_ATTR) || ''
    if (!messageId || messageId === state.lastCommandMessageId) return

    const text = node.innerText || ''
    const parsed = extractCommand(text)

    // Nothing runnable yet. Deliberately do NOT mark it handled and do NOT
    // consume the awaiting flag: ChatGPT renders the assistant turn — and keeps
    // re-rendering it — before any text arrives, so the first thing seen after a
    // send is usually an empty placeholder turn. Consuming the flag there made
    // the real reply look like restored history.
    if (!parsed) {
      // Only complain about a reply that is actually FINISHED. An unbalanced brace
      // count means it is still streaming, and reporting then is a pure false
      // alarm: the very first fragment of a command is `{"command":"`, which
      // parses as nothing and looks exactly like a malformed reply.
      const opens = (text.match(/\{/g) || []).length
      const closes = (text.match(/\}/g) || []).length
      const finished = opens > 0 && opens === closes

      if (finished && state.lastUnparsedMessageId !== messageId && /"command"\s*:/.test(text)) {
        state.lastUnparsedMessageId = messageId
        report({ event: 'parse-failed', text: text.slice(0, 300) })
        return
      }

      // A settled non-command reply is the final answer for this goal.
      // A quiet period while streaming is not final: the stop button remains visible until generation ends.
      if (text.trim() && state.awaitingReplySince !== 0 && !findStopButton()) {
        state.lastCommandMessageId = messageId
        state.awaitingReplySince = 0
        report({ event: 'task-finished', messageId })
      }

      return
    }

    // "Have we sent anything in this page view?" — NOT consumed here.
    //
    // Consuming it on the first report is what made the flag misfire: any earlier
    // quiet period (ChatGPT renders the assistant turn before its text arrives)
    // ate the flag, and the real reply then looked like restored history. It is
    // only reset when history is actually being loaded, i.e. by armBaseline().
    const live = state.awaitingReplySince !== 0
    state.lastCommandMessageId = messageId

    report({
      event: 'command',
      messageId,
      command: parsed.command,
      description: parsed.description,
      live
    })
  }

  /** The message id of the newest assistant turn currently in the DOM. */
  const lastAssistantId = () => {
    const nodes = document.querySelectorAll(ASSISTANT_SELECTOR)
    const node = nodes.length > 0 ? nodes[nodes.length - 1] : null
    return node ? node.getAttribute(MESSAGE_ID_ATTR) || null : null
  }

  /**
   * Called when history is (re)loaded: a real conversation change, or a page
   * (re)load. It forgets what we have handled so the restored replies are
   * re-evaluated, and clears any stale "awaiting a reply" flag left over from
   * the conversation we came from.
   *
   * It resets unconditionally: deciding WHICH navigations count as "history is
   * being restored" belongs to the main process, which is the side that can see
   * the previous conversation id. Sending the first message of a new chat
   * creates the conversation, so that URL change must not land here.
   */
  const armBaseline = () => {
    state.awaitingReplySince = 0
    state.lastCommandMessageId = null
    return true
  }

  /**
   * Force an immediate re-check of the last reply, bypassing the "already
   * handled" guard.
   *
   * Treated as live on purpose: this is the user explicitly asking to resume, so
   * in auto mode the command it finds should run.
   */
  const checkNow = () => {
    if (settleTimer) clearTimeout(settleTimer)
    state.lastCommandMessageId = null
    state.awaitingReplySince = Date.now()
    checkForCommand()
    return true
  }

  const observer = new MutationObserver(scheduleCheck)
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })

  /* ------------------------------------------------------------------ *
   * Public surface used by the main process
   * ------------------------------------------------------------------ */

  window[STATE_KEY] = {
    configure(config) {
      if (!config) return { ...state }
      if (typeof config.enabled === 'boolean') state.enabled = config.enabled
      if (typeof config.prefix === 'string') state.prefix = config.prefix
      // A freshly (re)loaded page has no message of ours outstanding, so nothing
      // it renders can be a reply to us.
      if (config.armBaseline === true) {
        state.awaitingReplySince = 0
        state.lastCommandMessageId = null
      }
      report({
        event: 'configured',
        enabled: state.enabled,
        prefixLength: state.prefix.length
      })
      return { ...state }
    },

    /**
     * Type `text` into the composer and submit it WITHOUT the system prompt.
     * Used to hand command output back to the model.
     *
     * Resolves only once the send has been CONFIRMED (the composer cleared), so
     * callers can tell the user the truth instead of assuming success.
     *
     * @returns Promise<'ok' | 'no-composer' | 'busy' | 'insert-failed' | 'stuck'>
     */
    sendRaw(text) {
      const element = getComposer()
      if (!element) return Promise.resolve('no-composer')
      // Never clobber something the user is in the middle of typing.
      if (collapse(element.innerText) !== '') return Promise.resolve('busy')

      const payload = String(text)

      state.programmatic = true
      let inserted = false
      try {
        inserted = insertText(element, payload)
      } catch (_) {
        inserted = false
      }
      if (!inserted) {
        state.programmatic = false
        report({ event: 'inject-failed' })
        return Promise.resolve('insert-failed')
      }

      return new Promise((resolve) => {
        let settled = false
        let timeout = null
        const done = (outcome) => {
          if (settled) return
          settled = true
          if (timeout) clearTimeout(timeout)
          resolve(outcome)
        }

        // Hard ceiling: this promise is awaited across IPC. Clear it as soon as
        // this raw send settles; otherwise an OLD send's 10s timer can fire while
        // a newer command result is being retried, flip programmatic=false, and
        // let the normal click interceptor prepend the system prompt to that raw result.
        timeout = setTimeout(() => {
          state.programmatic = false
          done('stuck')
        }, SEND_TIMEOUT_MS)

        submitWithRetry(payload, 0, true, done)
      })
    },

    checkNow,
    armBaseline,
    status: () => ({ ...state })
  }

  report({ event: 'installed' })
})()
