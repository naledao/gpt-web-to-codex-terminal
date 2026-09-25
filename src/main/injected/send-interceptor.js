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
  const LOG_TAG = '[cmd-terminal] '

  /*
   * Which site this copy is running against.
   *
   * These are ChatGPT's values, and they are the DEFAULT rather than a constant because
   * the same script now drives more than one site: the main process pushes the site's
   * descriptor through `configure({ page })` right after injection. Everything
   * site-specific is reachable from here — nothing below this block may contain a
   * ChatGPT selector.
   */
  let PAGE = {
    composerKind: 'contenteditable',
    composerSelectors: ['#prompt-textarea', 'div[contenteditable="true"]'],
    sendButtonSelectors: [
      '[data-testid="send-button"]',
      'button[aria-label="Send message"]',
      'button[aria-label="发送消息"]'
    ],
    stopButtonSelectors: [
      '[data-testid="stop-button"]',
      'button[aria-label="Stop generating"]',
      'button[aria-label="Stop streaming"]',
      'button[aria-label="停止生成"]'
    ],
    assistantSelectors: ['[data-message-author-role="assistant"]'],
    messageSelectors: ['[data-message-author-role]'],
    messageIdAttr: 'data-message-id'
  }

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
    /** Remains true across clarification turns until explicit completion or manual end. */
    taskActive: false,
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

  // A textarea converts CRLF and bare CR to LF when its value is assigned. Git and
  // other terminal tools can put bare CR inside output, so compare and submit the
  // same text the browser actually keeps instead of reporting a false insert failure.
  const normalizeLineEndings = (value) => String(value).replace(/\r\n?/g, '\n')

  /** First element matching any of a selector list. Lists, so a rename degrades. */
  const queryFirst = (selectors) => {
    for (const selector of selectors) {
      const found = document.querySelector(selector)
      if (found) return found
    }
    return null
  }

  const getComposer = () => queryFirst(PAGE.composerSelectors)

  /**
   * Read the composer.
   *
   * TWO mechanisms, and using the wrong one reads an empty string forever:
   *
   *   - contenteditable (ChatGPT/ProseMirror): the text lives in the DOM, so `innerText`
   *     is the only view of it — `.value` is `undefined` on a div.
   *   - textarea (DeepSeek): a real form control, where `innerText` is always empty and
   *     `.value` holds the text.
   *
   * Detected from the ELEMENT rather than trusted from the descriptor alone: a site that
   * swaps its composer would otherwise leave this reading nothing, silently.
   */
  const readComposer = (element) => {
    if (!element) return ''
    if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') {
      return String(element.value || '')
    }
    return String(element.innerText || '')
  }

  /**
   * Contenteditable editors are allowed to normalize whitespace and line breaks while
   * accepting an insertText command. Compare the visible text in its normalized form so
   * a successful write is not mistaken for a failed injection.
   */
  const composerMatches = (element, expected) => {
    const actual = readComposer(element)
    return actual === expected || collapse(actual) === collapse(expected)
  }

  /**
   * The assistant's ANSWER text, from a turn element.
   *
   * On ChatGPT the turn's text is the answer, and this returns it unchanged. On a site
   * whose turn also carries reasoning and search citations, the answer is a narrower
   * descendant — and reading the whole turn would hand the JSON extractor the model's
   * private reasoning. That is not a cosmetic difference: reasoning routinely contains
   * braces and quoted JSON of its own, so it can parse as a command the model never issued.
   *
   * Falls back to the turn's own text when the marker is absent, which is the correct
   * behaviour on a site that has none.
   */
  const readReplyText = (node) => {
    if (!node) return ''
    const markers = PAGE.assistantReplySelectors
    if (markers && markers.length > 0) {
      for (const selector of markers) {
        const answer = node.querySelector(selector)
        if (answer) return String(answer.innerText || '')
      }
    }
    return String(node.innerText || '')
  }

  /** True when this turn is an ASSISTANT one, decided by structure rather than by class. */
  const isAssistantTurn = (node) => {
    // A missing element is not an assistant turn. The callers do not currently pass null,
    // but `readReplyText` right above guards it and this does not — an asymmetry that would
    // turn a future refactor into a TypeError in a page we do not control.
    if (!node) return false
    const markers = PAGE.assistantReplySelectors
    if (!markers || markers.length === 0) return true
    return markers.some((selector) => node.querySelector(selector) !== null)
  }

  /**
   * Write text into the composer, and report whether it took.
   *
   * The two paths exist for the same underlying reason — a framework owns the editor and
   * ignores a direct DOM write — but the escape hatch differs:
   *
   *   - contenteditable: `document.execCommand('insertText')` goes through the browser's
   *     editing pipeline, so ProseMirror records a normal user edit.
   *   - textarea: React tracks the previous value on the node itself, so assigning
   *     `.value` makes React treat the change as a no-op and the send button stays
   *     disabled. Going through the prototype's native setter and then dispatching
   *     `input` is what makes React see it.
   */
  const writeComposer = (element, text) => {
    if (!element) return false

    if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') {
      try {
        const value = normalizeLineEndings(text)
        const proto = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement
        const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set
        element.focus()
        if (setter) setter.call(element, value)
        else element.value = value
        element.dispatchEvent(new Event('input', { bubbles: true }))
        // DeepSeek may normalize line breaks or surrounding whitespace while its
        // controlled textarea handles the input event. Treat that normalization
        // the same way as the contenteditable path instead of reporting a false
        // insert failure after the text is visibly in the box.
        return composerMatches(element, value)
      } catch (_) {
        return false
      }
    }

    element.focus()
    // Select the whole draft so `insertText` REPLACES it rather than inserting at a caret whose
    // position we cannot control. See `selectAllIn`.
    selectAllIn(element)
    // Keep focus/selection honest so ProseMirror records a real edit.
    document.execCommand('insertText', false, text)
    return composerMatches(element, text)
  }

  const findSendButton = () => queryFirst(PAGE.sendButtonSelectors)

  /**
   * Fallback for textarea-based composers whose send button has no stable selector.
   * Programmatic sends keep state.programmatic=true, so our own Enter interceptor lets
   * this synthetic event pass through without injecting the terminal prompt again.
   */
  const pressEnter = (element) => {
    if (!element) return
    const init = { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 }
    try {
      element.focus()
      element.dispatchEvent(new KeyboardEvent('keydown', init))
      element.dispatchEvent(new KeyboardEvent('keypress', init))
      element.dispatchEvent(new KeyboardEvent('keyup', init))
    } catch (_) {
      /* submitWithRetry verifies success by checking whether the composer cleared */
    }
  }

  const findStopButton = () => queryFirst(PAGE.stopButtonSelectors)

  /* ------------------------------------------------------------------ *
   * Site-specific element lookup
   * ------------------------------------------------------------------ */

  /**
   * Every element matching any selector in a list, de-duplicated and in DOCUMENT ORDER.
   *
   * Lists overlap by design — a site may be matched by both a test id and a structural
   * selector — and a duplicated node would make the same turn look like two, which breaks
   * "the newest reply" and the once-per-message dedupe with it. Document order is
   * restored with `compareDocumentPosition` because concatenating per-selector results
   * would otherwise return them grouped by selector.
   */
  const queryAll = (selectors) => {
    const seen = new Set()
    const found = []
    for (const selector of selectors) {
      let matches = []
      try {
        matches = [...document.querySelectorAll(selector)]
      } catch (_) {
        continue
      }
      for (const element of matches) {
        if (seen.has(element)) continue
        seen.add(element)
        found.push(element)
      }
    }
    return found.sort((a, b) => {
      const relation = a.compareDocumentPosition(b)
      if (relation & Node.DOCUMENT_POSITION_FOLLOWING) return -1
      if (relation & Node.DOCUMENT_POSITION_PRECEDING) return 1
      return 0
    })
  }

  const queryAllAssistant = () => queryAll(PAGE.assistantSelectors)
  const queryAllMessages = () => queryAll(PAGE.messageSelectors)

  /**
   * A stable id for one message, or null when the site has no such attribute.
   *
   * Used only to look for the attribute; `turnKeyOf` below is what callers should use,
   * because an empty answer here must never become an empty identity.
   */
  const messageIdOf = (node) => {
    if (!node || !PAGE.messageIdAttr) return null
    return node.getAttribute(PAGE.messageIdAttr) || null
  }

  const pageMessageIdAttrs = () => (PAGE.messageIdAttr ? [PAGE.messageIdAttr] : [])

  /**
   * Identity for one assistant turn — and it must NEVER be empty.
   *
   * A site that gives every turn a stable id (ChatGPT) is the easy case. A site that does
   * not would be unusable rather than merely less safe: the scan below bails out on an
   * empty id, so no command would ever be detected, and the main process keys executions
   * by this value, so an empty id would also collapse every command into a single row.
   *
   * So when there is no attribute, the turn is identified by its CONTENT. That is sound
   * here precisely because the scan only runs after the reply has been quiet for
   * `REPLY_SETTLE_MS`: the text is final by then, so re-rendering the same reply hashes
   * the same and stays suppressed, while a genuinely new reply differs and fires.
   *
   * The cost is real and worth stating: two byte-identical replies inside one conversation
   * become indistinguishable and the second is skipped. That needs the same command AND
   * the same description twice — and the alternative, an empty key, loses every command
   * after the first instead of one duplicate.
   */
  const turnKeyOf = (node) => {
    const attribute = messageIdOf(node)
    if (attribute) return attribute
    const text = String(node.innerText || '')
    if (text === '') return ''
    // djb2: tiny, synchronous, and stable across reloads — unlike a counter, which would
    // hand the same reply a new identity every time the page re-rendered.
    let hash = 5381
    for (let i = 0; i < text.length; i += 1) {
      hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0
    }
    return `text:${(hash >>> 0).toString(16)}:${text.length}`
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
    const nodes = queryAllMessages()
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
    return collapse(readComposer(element)).startsWith(head)
  }

  /**
   * Select everything in the composer, so the next write REPLACES it.
   *
   * This used to collapse the selection to the start, on the assumption that
   * `execCommand('insertText')` would then insert there. It does not: in a ProseMirror
   * contenteditable the text landed at the END, after whatever the user had typed — observed as
   * "the prompt appears after my sentence". `hasPrefix()` then failed (the prompt was not at the
   * front), so the next keystroke composed again and appended a second copy, and the send never
   * went out.
   *
   * Selecting all removes the dependency on caret placement entirely: the composed string
   * already contains both the prompt and the user's text, so replacing the contents with it is
   * the correct operation no matter where the caret happened to be. It also makes the
   * contenteditable path mean the same thing as the textarea path, which has always been a
   * whole-value replace — one behaviour instead of two.
   */
  const selectAllIn = (element) => {
    const range = document.createRange()
    range.selectNodeContents(element)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
  }

  const insertText = (element, text) => writeComposer(element, text)

  /**
   * Clicking send is NOT proof that the message went out. ChatGPT ignores the
   * click while it is still finishing the previous turn, and the text then just
   * sits in the composer looking sent. The only trustworthy signal is that the
   * composer actually cleared — so verify, and retry until it does.
   *
   * `done` is only supplied for programmatic sends, so the caller can report the
   * real outcome instead of assuming success.
   */
  const submitWithRetry = (text, attempt, isRaw, done, deadline = 0) => {
    // Capture the newest assistant turn BEFORE clicking Send. ChatGPT can create
    // the placeholder for the NEW assistant turn synchronously (or within the
    // 150ms confirmation delay below). Reading lastAssistantId() only after the
    // composer clears can therefore mark the fresh reply as already handled and
    // make every later MutationObserver scan skip its command forever.
    const replyBaselineId = lastAssistantId()

    const finish = (ok) => {
      state.programmatic = false
      if (ok) {
        // Once a message actually goes out, the next assistant turn is ours.
        state.awaitingReplySince = Date.now()
        state.taskActive = true
        // Ignore only the assistant turn that existed BEFORE this send. Never
        // baseline the new placeholder/reply that may already have appeared.
        state.lastCommandMessageId = replyBaselineId
        // The send landed, so the new turn is about to render below the fold.
        scheduleScrollToBottom()
      }
      report(
        ok
          ? isRaw
            ? { event: 'sent-raw', text: text.slice(0, 200) }
            : { event: 'sent', text: userTextOf(text).slice(0, 400) }
          : { event: 'send-failed', text: text.slice(0, 200) }
      )
      if (done) done(ok ? 'ok' : 'stuck')
    }

    if (deadline > 0 && Date.now() >= deadline) {
      finish(false)
      return
    }

    const button = findSendButton()

    if (!button || button.disabled) {
      const element = getComposer()
      if (!button && element && (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT')) {
        pressEnter(element)
      } else {
        // The send button only enables once the editor has committed the edit,
        // and it can disappear entirely while a reply is streaming.
        if (deadline > 0 ? Date.now() < deadline : attempt < MAX_SEND_ATTEMPTS) {
          setTimeout(() => submitWithRetry(text, attempt + 1, isRaw, done, deadline), 80)
        } else {
          finish(false)
        }
        return
      }
    } else {
      pressButton(button)
    }

    setTimeout(() => {
      const element = getComposer()
      if (!element || collapse(readComposer(element)) === '') {
        finish(true)
        return
      }
      if (deadline > 0 ? Date.now() < deadline : attempt < MAX_SEND_ATTEMPTS) {
        submitWithRetry(text, attempt + 1, isRaw, done, deadline)
      } else {
        finish(false)
      }
    }, 150)
  }

  /**
   * Press a control the way a user would, whichever kind of element it is.
   *
   * `.click()` is enough for a real `<button>` (ChatGPT). DeepSeek's send control is a
   * `<div role="button">` owned by a component library, and those frequently act on
   * pointerdown/pointerup rather than on `click` — in which case `.click()` does nothing
   * at all and the send silently never happens.
   *
   * So the full sequence is dispatched, and the caller still verifies by watching the
   * composer clear. The verification is what makes this safe: a duplicate dispatch that the
   * framework ignores is harmless, while a missing one is the difference between working
   * and not.
   */
  const pressButton = (element) => {
    if (!element) return
    const base = { bubbles: true, cancelable: true, view: window }
    try {
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
        const Ctor = type.startsWith('pointer') && typeof PointerEvent === 'function'
          ? PointerEvent
          : MouseEvent
        element.dispatchEvent(new Ctor(type, { ...base, button: 0, buttons: 1 }))
      }
      if (typeof element.click === 'function') element.click()
      else element.dispatchEvent(new MouseEvent('click', base))
    } catch (_) {
      /* the composer check below is the real verdict */
    }
  }

  /** @returns true when the event was consumed and the send was taken over. */
  /**
   * Marks where the injected prompt ends and the user's own words begin.
   *
   * A splitter that instead guessed the boundary from the prompt's LAST 【…】 section
   * looked reasonable and was wrong in three ways, all caught by tests: a greedy match
   * swallowed the prompt's tail, a user message containing its own 【…】 (for example
   * 「把【已完成】加到文档里」) was cut in half, and a message with no 【 at all could not
   * be split. The boundary is only knowable where the text is COMPOSED, so it is recorded
   * there rather than re-derived later.
   *
   * The characters are control codes: they cannot be typed into ChatGPT's composer and
   * do not survive a copy-paste, so a real message cannot contain one by accident.
   */
  const USER_TEXT_SENTINEL = '\u0000\u0001'

  /**
   * True once composing this draft has failed.
   *
   * Cleared on the next successful injection. Without it, an injection that cannot take
   * (a composer whose write path this site does not accept) is retried on every keystroke:
   * the reported counter climbs into the thousands, the composer appears to be "constantly
   * injected", and the user's own message never leaves.
   */
  let draftRejected = false

  /**
   * Recover what the USER typed from the text that was actually submitted.
   *
   * `submitWithRetry` is handed the composed string — the injected system prompt with
   * the user's words appended after the sentinel — and that composed string is what must
   * go to ChatGPT. Everything downstream that means "what the user asked for" (the goal
   * shown in the UI) needs the user's part only: reporting the whole prompt would put the
   * entire system prompt on screen.
   *
   * Falls back to the full text when no sentinel is present, which is the honest answer
   * for a message that carried no prompt (terminal mode off) or an empty submit.
   */
  const userTextOf = (composed) => {
    const text = String(composed || '')
    const at = text.lastIndexOf(USER_TEXT_SENTINEL)
    if (at === -1) return text
    return text.slice(at + USER_TEXT_SENTINEL.length)
  }

  const intercept = (event) => {
    // Our own sends must pass through untouched: no prefix, no interception.
    if (state.programmatic) return false
    if (!state.enabled || !state.prefix) return false
    // This draft already failed to compose. Attempting again on every keystroke is how the
    // injected counter ran away; the user's text sends as-is instead.
    if (draftRejected) return false

    const element = getComposer()
    if (!element) return false
    // Already injected for this draft: let the site send it normally.
    if (hasPrefix(element)) return false

    event.preventDefault()
    event.stopImmediatePropagation()

    const text = collapse(readComposer(element))

    /*
     * ONE write, carrying everything.
     *
     * This used to be two — the prompt first, then the sentinel and the user's text — which
     * works on a contenteditable composer because `execCommand` INSERTS at the caret. A
     * textarea write is a whole-value REPLACE, so the second call deleted the prompt that the
     * first had just written: the message went out with no system prompt and the app could
     * never tell.
     *
     * Composing first and writing once makes both mechanisms behave the same way.
     */
    const composed = state.prefix + USER_TEXT_SENTINEL + text
    const wrote = insertText(element, composed)

    /*
     * Verify, rather than assume.
     *
     * A REPLACE that silently did not take leaves the composer holding something other than
     * what we composed. Submitting then would send the wrong text — and `hasPrefix` would keep
     * failing, so every later keystroke would inject again. That is exactly how the injected
     * counter reached four figures while nothing was actually sent.
     */
    const verified = wrote && collapse(readComposer(element)) === collapse(composed)

    if (!verified) {
      /*
       * The injection did not take. Two rules, both learned the hard way:
       *
       *  1. NEVER trap the user's message. Fall back to sending their text as-is, without the
       *     system prompt: a degraded terminal turn is recoverable, a composer that eats what
       *     you type is not.
       *  2. Do not try again on the same draft. Interception is re-entered on every keystroke,
       *     and an injection that failed once fails every time — retrying is what produced the
       *     runaway counter and the appearance of the prompt being "constantly injected".
       */
      draftRejected = true
      report({ event: 'inject-failed' })
      submitWithRetry(text, 0, false)
      return true
    }

    draftRejected = false
    state.injectedCount += 1
    /*
     * The prefix is reported alongside the count, not just the fact of injection.
     *
     * The prompt is stored PER VIEW in the main process, so "this page was configured with the
     * wrong (generic fallback) prompt" is a real failure mode — and from the outside it looks
     * exactly like terminal mode being off. Sending the length and the opening words makes the
     * question answerable from the log instead of by reading the composer and guessing.
     */
    report({
      event: 'injected',
      count: state.injectedCount,
      prefixLength: state.prefix.length,
      /*
       * A LONG head, because the opening of the prompt is boilerplate that both the probed
       * prompt and the generic fallback share — the machine-specific lines come later. A short
       * prefix would report "MATCH" while the page was in fact describing the wrong machine.
       */
      prefixHead: collapse(state.prefix).slice(0, 220)
    })
    setTimeout(() => submitWithRetry(composed, 0, false), 60)
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
      if (!PAGE.sendButtonSelectors.some((selector) => target.closest(selector))) return
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
  const normalizeTimeoutSeconds = (value, command) => {
    if (!String(command || '').trim()) return 0
    const seconds = Number(value)
    if (!Number.isFinite(seconds)) return 120
    return Math.min(Math.max(Math.floor(seconds), 1), 1800)
  }

  const lenientCommand = (candidate) => {
    const command = readJsonishString(candidate, 'command')
    if (command === null) return null
    const description = readJsonishString(candidate, 'description')
    const timeoutMatch = candidate.match(/"timeout_seconds"\s*:\s*(\d+)/)
    return {
      command: command.trim(),
      description: (description ?? '').trim(),
      timeoutSeconds: normalizeTimeoutSeconds(timeoutMatch?.[1], command)
    }
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
        description: typeof parsed.description === 'string' ? parsed.description.trim() : '',
        timeoutSeconds: normalizeTimeoutSeconds(parsed.timeout_seconds, parsed.command)
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
    const nodes = queryAllAssistant()
    if (nodes.length === 0) return

    const node = nodes[nodes.length - 1]

    /*
     * Only assistant turns count, and this is checked FIRST.
     *
     * The turn selector is "one element per turn, either role" — it has to be, because a
     * role is not always marked. The USER's own message is not a reply, and on a site whose
     * turns are plain divs it is otherwise indistinguishable: the app would try to parse the
     * user's own words as a command, and would consume the awaiting flag with them.
     *
     * Before the turn key, so a user turn never becomes `lastAssistantId` and never spends a
     * content hash.
     */
    if (!isAssistantTurn(node)) return

    /*
     * `turnKeyOf`, never a raw attribute read.
     *
     * This used to be `messageIdOf(node) || ''` followed by `if (!messageId) return` —
     * which on a site without the attribute means the function returns immediately,
     * forever: no command is ever detected, and nothing anywhere reports a problem. That
     * is the exact failure this guard exists to prevent now.
     */
    const messageId = turnKeyOf(node)
    if (!messageId || messageId === state.lastCommandMessageId) return

    /*
     * The narrowed answer text, never the whole turn: on DeepSeek the turn's text starts
     * with its reasoning and search citations, and that reasoning contains `ds-markdown`
     * blocks with braces and quoted JSON of its own — perfectly capable of parsing as a
     * command the model never issued to us.
     */
    const text = readReplyText(node)
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
        const completed = text.trimStart().startsWith('【任务完成】')
        state.lastCommandMessageId = messageId
        state.awaitingReplySince = 0
        if (completed) state.taskActive = false
        report({
          event: 'task-finished',
          messageId,
          completed
        })
      }

      return
    }

    // "Have we sent anything in this page view?" — NOT consumed here.
    //
    // Consuming it on the first report is what made the flag misfire: any earlier
    // quiet period (ChatGPT renders the assistant turn before its text arrives)
    // ate the flag, and the real reply then looked like restored history. It is
    // only reset when history is actually being loaded, i.e. by armBaseline().
    // A parseable command is not necessarily a finished reply. ChatGPT can pause
    // long enough for REPLY_SETTLE_MS while it is still streaming; executing here
    // would let the shell finish before the current assistant turn is done, so the
    // raw result gets inserted into a composer that ChatGPT still refuses to send.
    // The stop button disappearing mutates the DOM and schedules another check.
    if (findStopButton()) return

    const live = state.awaitingReplySince !== 0
    state.lastCommandMessageId = messageId

    report({
      event: 'command',
      messageId,
      command: parsed.command,
      description: parsed.description,
      timeoutSeconds: parsed.timeoutSeconds,
      live
    })
  }

  /**
   * The turn key of the newest ASSISTANT turn currently in the DOM.
   *
   * `turnKeyOf` for the same reason as above: this value becomes
   * `state.lastCommandMessageId`, and a null there would disable the suppression that
   * stops a re-rendered old reply from looking fresh.
   *
   * Scans backwards past any user turn: on a site with unmarked roles the newest element
   * matching the turn selector is often the USER's message, and baselining against that
   * would leave the real reply looking like something we had already handled.
   */
  const lastAssistantId = () => {
    const nodes = queryAllAssistant()
    for (let i = nodes.length - 1; i >= 0; i -= 1) {
      if (isAssistantTurn(nodes[i])) return turnKeyOf(nodes[i])
    }
    return null
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
    state.taskActive = true
    checkForCommand()
    return true
  }

  // Block ChatGPT sidebar conversation links while the current task is active.
  document.addEventListener(
    'click',
    (event) => {
      if (!state.taskActive) return
      const target = event.target
      if (!(target instanceof Element)) return
      const anchor = target.closest('a[href]')
      if (!anchor) return
      const href = anchor.getAttribute('href') || ''
      if (!href.startsWith('/c/') && !/^https:\/\/chatgpt\.com\/c\//i.test(href)) return
      event.preventDefault()
      event.stopImmediatePropagation()
    },
    true
  )

  const observer = new MutationObserver(scheduleCheck)
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    // ChatGPT may create a turn node before assigning data-message-id. Without
    // observing that attribute, a fully rendered reply can remain invisible to
    // the scanner if no later text mutation happens.
    attributes: true,
    attributeFilter: pageMessageIdAttrs()
  })

  /* ------------------------------------------------------------------ *
   * Public surface used by the main process
   * ------------------------------------------------------------------ */

  window[STATE_KEY] = {
    configure(config) {
      if (!config) return { ...state }
      if (typeof config.enabled === 'boolean') state.enabled = config.enabled
      if (typeof config.prefix === 'string') state.prefix = config.prefix
      /*
       * The site's selectors arrive with the config, because this script is injected as
       * source and cannot import anything: the main process is the only place that knows
       * which platform this page is. Merged rather than replaced so a partial descriptor
       * keeps ChatGPT's defaults instead of matching nothing at all.
       */
      if (config.page && typeof config.page === 'object') {
        // `composerKind` is accepted for documentation but deliberately not used: the
        // read/write path decides from the ELEMENT (see readComposer), so a site that
        // changes its composer still works without a descriptor update.
        const { composerKind: _kind, ...selectors } = config.page
        PAGE = { ...PAGE, ...selectors }
      }
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

    /** Manually terminate the current task, including an in-progress model reply. */
    endTask() {
      if (settleTimer) {
        clearTimeout(settleTimer)
        settleTimer = null
      }
      const stop = findStopButton()
      if (stop && typeof stop.click === 'function') stop.click()
      state.awaitingReplySince = 0
      state.taskActive = false
      state.lastCommandMessageId = lastAssistantId()
      state.lastUnparsedMessageId = null
      return true
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
      if (collapse(readComposer(element)) !== '') return Promise.resolve('busy')

      const payload = normalizeLineEndings(text)

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

        submitWithRetry(payload, 0, true, done, Date.now() + SEND_TIMEOUT_MS - 100)
      })
    },

    checkNow,
    armBaseline,
    status: () => ({ ...state })
  }

  report({ event: 'installed' })
})()
