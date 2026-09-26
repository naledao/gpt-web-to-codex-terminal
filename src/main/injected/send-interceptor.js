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
 * ProseMirror contenteditable div — it carried `#prompt-textarea` until the markup
 * changed, and what replaced that id is recorded in `src/shared/platforms.ts`. Writing to
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
    composerSelectors: [
      'div[contenteditable="true"][data-composer-markdown]',
      'div[contenteditable="true"][role="textbox"]',
      '#prompt-textarea',
      'div[contenteditable="true"]'
    ],
    sendButtonSelectors: [
      '[data-composer-footer-responsive] button[aria-label="发送"]',
      'button[aria-label="发送"]',
      '[data-testid="send-button"]',
      'button[aria-label="Send message"]',
      'button[aria-label="发送消息"]'
    ],
    stopButtonSelectors: [
      '[data-composer-footer-responsive] button[aria-label="停止"]',
      'button[aria-label="停止"]',
      '[data-testid="stop-button"]',
      'button[aria-label="Stop generating"]',
      'button[aria-label="Stop streaming"]',
      'button[aria-label="停止生成"]'
    ],
    assistantSelectors: ['[data-chatgpt-selection-message-id]'],
    assistantReplySelectors: ['[data-markdown-text-style="assistant-message"]'],
    messageSelectors: ['[data-content-search-unit-key]', '[data-chatgpt-selection-message-id]'],
    messageIdAttr: 'data-chatgpt-selection-message-id'
  }

  /**
   * How long the reply text must stop changing before we treat it as final.
   * The reply streams token by token; parsing mid-stream would read half a JSON
   * object, and a half-parsed command could be a DIFFERENT, still-valid command
   * (e.g. `{"command":"dir"}` before the real payload arrives).
   */
  const REPLY_SETTLE_MS = 800

  /*
   * How a send is bounded: in TIME, never in retries.
   *
   * It used to be a retry count (`MAX_SEND_ATTEMPTS = 20`), which was a duration only by
   * accident — 20 × the old 150ms confirmation delay ≈ 3s. Once the confirmation became a
   * poll that can legitimately last seconds, the same count ranged from three seconds to a
   * minute depending on whether the page was answering, and "20 attempts" stopped meaning
   * anything a reader could predict. The budget is now stated as the thing it always meant.
   *
   * Two budgets, and the difference matters — see the block in `submitWithRetry` that reads
   * them. `grace` is "stop waiting for the measured button"; `budget`/`timeout` is "stop
   * trying at all".
   */
  /**
   * How long to keep waiting for the SELECTOR-matched send button to render.
   *
   * ChatGPT rebuilds the composer footer after text is written, so the button can honestly be
   * absent for a moment and this window exists for that. It must stay short: when the selector
   * is simply wrong, every millisecond spent here is the user watching their text sit in the
   * box, and the structural fallback would have worked immediately.
   */
  const SEND_BUTTON_GRACE_MS = 700
  /** Total budget for a user-initiated send (~700ms grace + two 3s confirmations). */
  const SEND_ATTEMPT_BUDGET_MS = 8_000
  /**
   * Hard ceiling so a caller awaiting sendRaw() can never hang forever.
   *
   * Comfortably above the worst case the branches can produce (grace + both recovery
   * confirmations ≈ 6.7s) — a ceiling that cuts a recovery action off mid-confirmation
   * reports 'stuck' for a send that actually went out, which is the failure this whole area
   * was rewritten for.
   */
  const SEND_TIMEOUT_MS = 10_000

  /*
   * How the "did the submit actually happen?" question is answered.
   *
   * The ONLY trustworthy signal is the composer clearing, and it is not instantaneous: ChatGPT
   * clears it through its own React/ProseMirror update, which lands some time after the event
   * we dispatched. This used to be a single sample 150ms after the action, and that is simply
   * too short — it produced the worst possible report. Observed: the message went out, the
   * model answered 【任务完成】, the composer was empty on screen, and the terminal still said
   * "结果已写入输入框但没能提交", telling the user to send by hand something that had already
   * been sent.
   *
   * So it polls. A send that worked is detected as soon as it clears — typically a few hundred
   * milliseconds — and only a send that really was ignored burns the whole window. That also
   * makes the retry loop SAFER, not just more accurate: re-dispatching after 150ms while the
   * page was still processing the previous action is how one send becomes several.
   */
  const SEND_CONFIRM_TIMEOUT_MS = 3000
  const SEND_CONFIRM_POLL_MS = 120

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

  const controlDisabled = (el) =>
    el.disabled === true || el.getAttribute('aria-disabled') === 'true'

  /**
   * The composer's own toolbar controls — the first ancestor holding more than one button.
   *
   * The SAME traversal as `tools/diag/chatgpt-dom-probe.js` uses for its
   * `composer toolbar buttons` section, deliberately: that section is what identified this
   * neighbourhood before, and a report from a real failure should be readable beside it.
   */
  /**
   * Everything that can act as a control.
   *
   * ONE definition, used for BOTH the walk up and the collection. They used to disagree — the
   * walk stopped at the first ancestor holding two `<button>`s while the collection also took
   * `[role="button"]` — and that is why the DeepSeek snapshot was useless: on that site the
   * composer's controls are all `<div role="button">`, so the walk never stopped near the
   * composer at all. It climbed to the first ancestor with real buttons and returned a slice of
   * the page: twelve feature chips, no primary action, exactly where the answer should have been.
   */
  const CONTROL_SELECTOR = 'button, [role="button"]'

  const composerToolbarControls = () => {
    const element = getComposer()
    if (!element) return []
    let node = element
    let hops = 0
    while (node && node !== document.body && hops < 10) {
      if (node.querySelectorAll(CONTROL_SELECTOR).length >= 2) break
      node = node.parentElement
      hops += 1
    }
    if (!node || node === document.body) return []
    return [...node.querySelectorAll(CONTROL_SELECTOR)]
  }

  const describeControl = (el) => ({
    tag: el.tagName.toLowerCase(),
    /*
     * `role` matters, and its absence made the first DeepSeek report unreadable: that site's
     * composer controls are all `<div role="button">`, so a snapshot that named only the tag
     * made twelve working controls look like decoration.
     */
    role: el.getAttribute('role') || '',
    testid: el.getAttribute('data-testid') || el.getAttribute('data-test-id') || '',
    aria: el.getAttribute('aria-label') || '',
    disabled: controlDisabled(el),
    /*
     * Visible text. On DeepSeek this is the ONLY thing that tells one control from another:
     * all twelve carry no aria label at all, and their class lists differ only in a modifier
     * that was being cut off.
     */
    text: collapse(el.innerText || '').slice(0, 24),
    /*
     * 200, not 90. At 90 the twelve DeepSeek controls came back indistinguishable — which is
     * precisely the information the snapshot exists to carry.
     */
    cls: (typeof el.className === 'string' ? el.className : '').slice(0, 200)
  })

  /**
   * The composer toolbar as a report payload: how many controls there are, and what they are.
   *
   * BOTH ENDS, not the first N. The control that matters is the composer's primary action — the
   * send button, or the stop button while a reply is streaming — and it sits at the END of the
   * row. The walk up to the first ancestor holding more than one button can overshoot on a site
   * whose composer is nested inside a panel full of chips, which is what DeepSeek does: its
   * snapshot came back as twelve feature buttons and no primary action at all, truncated exactly
   * where the answer would have been. `toolbarCount` says when the two windows left a gap.
   */
  const toolbarSnapshot = () => {
    const controls = composerToolbarControls()
    const seen = new Set()
    const picked = []
    for (const el of [...controls.slice(0, 8), ...controls.slice(-16)]) {
      if (seen.has(el)) continue
      seen.add(el)
      picked.push(el)
    }
    return { toolbarCount: controls.length, toolbar: picked.map(describeControl) }
  }

  /**
   * Everything that could explain "the text went in and the send never happened".
   *
   * Reported when a send is finally given up on. The alternative is what this cost the last
   * time: the app said only `stuck`, while the interceptor had already seen which of half a
   * dozen things was on screen and threw all of it away. The main process prints this with
   * `console.warn`, which `DSH_APP_LOG=1` mirrors into `<userData>/logs/`, so a failure
   * leaves something readable behind instead of a dead end.
   *
   * The toolbar inventory is the part that matters. It is the probe's own traversal, so a
   * failure NAMES the button the app failed to click — the replacement selector can then be
   * written from the report rather than guessed at.
   */
  const diagnoseSendFailure = (attempts, recoveryTried) => {
    const element = getComposer()
    const button = findSendButton()
    return {
      attempts,
      recoveryTried,
      composerKind: element ? element.tagName.toLowerCase() : null,
      composerLeft: collapse(readComposer(element)).slice(0, 80),
      sendButtonFound: button !== null,
      sendButtonDisabled: button ? controlDisabled(button) : null,
      sendButton: button ? describeControl(button) : null,
      stopButtonFound: findStopButton() !== null,
      ...toolbarSnapshot()
    }
  }

  /**
   * Actions tried, IN ORDER, once the selector-matched button cannot be used at all.
   *
   * INSURANCE, not the normal path.
   *
   * `sendButtonSelectors` currently match. Clicking the send button and pressing Enter both
   * still prepend the system prompt (user-tested, both routes), and a click can only reach
   * `intercept()` through the interceptor that matches on that list — so on today's page the
   * first branch of `submitWithRetry` wins and none of this runs.
   *
   * It exists because the same class of change has already happened TWICE in one generation:
   * `#prompt-textarea` and `[data-message-author-role]` both went to zero matches and the
   * automation died silently. When a send-button selector goes the same way, "the button was
   * not found" ends the send OUTRIGHT — the result sits in the composer and every later round
   * of the loop is lost with it, which is not a degradation worth accepting when a structural
   * click costs one line.
   *
   * Both are heuristics, and both are safe to be wrong: the caller verifies by watching the
   * composer CLEAR, so an action that does nothing costs one pass and the next one runs.
   *
   *   - `toolbar-last` — the last enabled control in the composer's toolbar. On ChatGPT that
   *     row is [attach][model][dictation][primary], and the primary slot holds the send button
   *     whenever there is something to send. Structural: needs no label, no test id, and no
   *     stable class name.
   *   - `enter` — how a real user sends, and the one path that needs no element at all.
   */
  const RECOVERY_ACTIONS = ['toolbar-last', 'enter']

  /** The last ENABLED control in the composer toolbar — ChatGPT's primary action slot. */
  const lastToolbarControl = () => {
    const controls = composerToolbarControls()
    for (let i = controls.length - 1; i >= 0; i -= 1) {
      if (!controlDisabled(controls[i])) return controls[i]
    }
    return null
  }

  const runRecovery = (action, element) => {
    if (action === 'enter') {
      pressEnter(element)
      return
    }
    /*
     * Only click when our text is STILL in the box.
     *
     * The primary slot only holds the send button while there is something to send. With an
     * empty composer ChatGPT puts the VOICE button there, and clicking that would start
     * dictation on the user's machine as a side effect of a failed send. If the text is gone
     * the send is already lost, so Enter — which does nothing at all in that state — is the
     * only safe move.
     */
    if (collapse(readComposer(element)) === '') {
      pressEnter(element)
      return
    }
    /*
     * Never click the primary slot while a reply is still generating: in that state the slot
     * holds the STOP button, and the one outcome worse than a result that does not send is a
     * result that silently cancels the model's answer on its way past.
     */
    if (findStopButton()) {
      pressEnter(element)
      return
    }
    const candidate = lastToolbarControl()
    if (candidate) pressButton(candidate)
    else pressEnter(element)
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
  const submitWithRetry = (
    text,
    attempt,
    isRaw,
    done,
    deadline = 0,
    recovery = 0,
    graceUntil = 0
  ) => {
    /** Which recovery action THIS pass used, so the report can name it. */
    let recoveryTried = null

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
          : {
              event: 'send-failed',
              text: text.slice(0, 200),
              ...diagnoseSendFailure(attempt, recoveryTried)
            }
      )
      if (done) done(ok ? 'ok' : 'stuck')
    }

    const button = findSendButton()
    const element = getComposer()
    // A textarea site has no send-button selector worth trusting, so Enter is its real
    // submit path rather than a fallback — which is why this one is not gated on anything.
    const textControl =
      element !== null && (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT')

    /*
     * TWO DIFFERENT INSTANTS, and conflating them is what made this feel slow.
     *
     *   - `graceUntil` — stop WAITING for the selector-matched button to render. Short.
     *   - `deadline`   — stop trying altogether. The ceiling for the whole send.
     *
     * The fallback used to hang off `deadline`, so on the command-result path the text sat in
     * the composer for the entire retry budget (~5s) before anything was clicked — reported as
     * "内容已经在框中好一会了，才发送出去". It was self-inflicted: the wait bought nothing,
     * because the selector it was waiting for was never going to match.
     *
     * The guard below is a TOTAL budget, and it is safe to enforce it here now that the
     * fallback no longer depends on reaching it. It could not be before: with the fallback
     * gated on "out of retries", a guard at the top fired at the same instant and made every
     * late branch unreachable, which is how a result got written into the composer and never
     * submitted at all.
     */
    if (Date.now() >= deadline) {
      finish(false)
      return
    }

    const fallbackDue =
      recovery < RECOVERY_ACTIONS.length && element !== null && Date.now() >= graceUntil

    if (button && !button.disabled) {
      pressButton(button)
    } else if (button === null && textControl) {
      pressEnter(element)
    } else if (button === null && fallbackDue) {
      /*
       * The selector never matched and the grace period is over — go structural NOW.
       *
       * ONE recovery action per pass, never two back to back: running them together would
       * risk sending the same text twice, because a click that clears the composer and a
       * synthetic Enter in the same tick can both be accepted by the page. The poll below
       * decides whether the next action is needed at all.
       *
       * Only for `button === null`, deliberately. A button that IS found but disabled means the
       * page is refusing to send — usually because it is still generating — and clicking the
       * primary slot in that state risks hitting Stop and cancelling the reply.
       */
      recoveryTried = RECOVERY_ACTIONS[recovery]
      /*
       * The full diagnosis rides along here, not only on `send-failed`.
       *
       * A run where every send succeeds THROUGH the recovery never reports `send-failed`, so
       * the one report carrying a toolbar snapshot never fired — and "which button is the send
       * button?" stayed unanswered while the app appeared to work. That is exactly what the
       * last session's log showed: six `send-recovery action=toolbar-last` lines and not one
       * snapshot of the toolbar that made them necessary.
       */
      report({
        event: 'send-recovery',
        action: recoveryTried,
        attempt,
        ...diagnoseSendFailure(attempt, recoveryTried)
      })
      runRecovery(recoveryTried, element)
    } else {
      // The send button only enables once the editor has committed the edit, and it can
      // disappear entirely while a reply is streaming. Both are worth waiting out.
      setTimeout(
        () => submitWithRetry(text, attempt + 1, isRaw, done, deadline, recovery, graceUntil),
        80
      )
      return
    }

    /*
     * Poll for the composer to clear instead of sampling it once at +150ms — see
     * SEND_CONFIRM_TIMEOUT_MS for the failure that came out of the single sample.
     */
    const confirmStartedAt = Date.now()
    const confirm = () => {
      const box = getComposer()
      if (!box || collapse(readComposer(box)) === '') {
        finish(true)
        return
      }
      if (Date.now() - confirmStartedAt < SEND_CONFIRM_TIMEOUT_MS) {
        setTimeout(confirm, SEND_CONFIRM_POLL_MS)
        return
      }
      /*
       * The window closed with the text still in the box, so whatever this pass did, it did not
       * take.
       *
       * If this pass ran a recovery action, the measured route is already abandoned: step to
       * the NEXT action, and only give up once there is none left. Anything else would re-run
       * the same action forever, since the condition that chose it (`fallbackDue`) stays true.
       */
      if (recoveryTried !== null) {
        if (recovery + 1 < RECOVERY_ACTIONS.length) {
          submitWithRetry(text, attempt, isRaw, done, deadline, recovery + 1, graceUntil)
        } else {
          finish(false)
        }
        return
      }
      if (Date.now() < deadline) {
        submitWithRetry(text, attempt + 1, isRaw, done, deadline, recovery, graceUntil)
        return
      }
      finish(false)
    }
    setTimeout(confirm, SEND_CONFIRM_POLL_MS)
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

    const text = collapse(readComposer(element))

    /*
     * An EMPTY draft is not a message, and this is not a nicety — it is the guard against the
     * app talking to the model on its own.
     *
     * Nothing above checks it: `hasPrefix` compares against a sentence that is not there, so an
     * empty composer fails that test, and everything below then composes the SYSTEM PROMPT with
     * an empty user tail and SENDS it — a whole message in the conversation containing nothing
     * the user wrote. Observed twice in one session, from a control the app clicked itself.
     *
     * Returning false here is also the CORRECT behaviour for the user: pressing Enter in an
     * empty composer should do nothing, which is what the site does once we stop stealing the
     * event.
     */
    if (text === '') return false

    event.preventDefault()
    event.stopImmediatePropagation()

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
      submitWithRetry(
        text,
        0,
        false,
        null,
        Date.now() + SEND_ATTEMPT_BUDGET_MS,
        0,
        Date.now() + SEND_BUTTON_GRACE_MS
      )
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
    setTimeout(
      () =>
        submitWithRetry(
          composed,
          0,
          false,
          null,
          Date.now() + SEND_ATTEMPT_BUDGET_MS,
          0,
          Date.now() + SEND_BUTTON_GRACE_MS
        ),
      60
    )
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
   * One line explaining why a settled reply produced no command — at most once per reason.
   *
   * WHY THIS EXISTS. Every early return in `checkForCommand` below is silent, and between them
   * they cover the whole distance from "the reply is on screen" to "a command ran". So when a
   * model answers with a perfectly good JSON block and nothing happens, there is nothing
   * anywhere to read: not in the app log, not in the terminal, not in the UI. That is not a
   * hypothetical — it is why this was added, after a DeepSeek reply sat there unexecuted with
   * only three `injected` lines in the log to show for the session.
   *
   * Deduped by (turn, reason) rather than throttled by time: the settle timer re-runs on every
   * mutation, so an undeduped note would bury the log, while a time throttle would hide the
   * ONE transition that matters — the same turn moving from "no command yet" to "handled".
   */
  let lastScanNote = ''
  const noteScan = (messageId, reason, extra) => {
    const key = `${messageId}\u0000${reason}`
    if (key === lastScanNote) return
    lastScanNote = key
    report({ event: 'scan', reason, messageId, ...extra })
  }

  /**
   * Runs after the reply has been quiet for REPLY_SETTLE_MS. Only the LAST
   * assistant message is considered, and each message id is reported at most
   * once — the main process does the durable deduplication against SQLite.
   */
  const checkForCommand = () => {
    const nodes = queryAllAssistant()
    if (nodes.length === 0) {
      noteScan('', 'no-turns', { selectors: PAGE.assistantSelectors })
      return
    }

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
    if (!isAssistantTurn(node)) {
      /*
       * Usually correct — the newest turn is the user's own message. But it is ALSO exactly
       * what a reply marker that stopped matching looks like, and the two are indistinguishable
       * from the outside without this note. Its `tag`/`cls` say which one it was.
       */
      noteScan(turnKeyOf(node), 'not-assistant-turn', {
        tag: node.tagName.toLowerCase(),
        cls: String(node.className || '').slice(0, 120),
        wanted: PAGE.assistantReplySelectors
      })
      return
    }

    /*
     * `turnKeyOf`, never a raw attribute read.
     *
     * This used to be `messageIdOf(node) || ''` followed by `if (!messageId) return` —
     * which on a site without the attribute means the function returns immediately,
     * forever: no command is ever detected, and nothing anywhere reports a problem. That
     * is the exact failure this guard exists to prevent now.
     */
    const messageId = turnKeyOf(node)
    if (!messageId) {
      // `turnKeyOf` only returns '' for a turn that renders no text at all, so this is a
      // placeholder rather than a reply — worth one line, because it is also what an empty
      // identity would look like if that function ever regressed.
      noteScan('', 'no-key', { cls: String(node.className || '').slice(0, 120) })
      return
    }
    if (messageId === state.lastCommandMessageId) {
      /*
       * Already dealt with — routinely correct, since the observer re-runs on every mutation.
       *
       * But it is ALSO what this turn looks like after the branch below has marked it handled
       * EARLY, while the model was merely pausing mid-reply. That mistake is invisible from
       * here and total: the real command in the same turn can never be parsed afterwards,
       * because this guard returns first, every time, silently. One note per turn is what makes
       * the two cases tellable apart.
       */
      noteScan(messageId, 'already-handled')
      return
    }

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

      /*
       * The catch-all, and the one that would have answered the question this was written for.
       *
       * A site with NO stop button cannot tell "still streaming, just quiet" from "finished" —
       * `findStopButton()` above is the only thing that could, and on DeepSeek it is always null
       * by design. So a pause longer than REPLY_SETTLE_MS mid-reply is taken as final, the turn
       * is marked handled, and the command that arrives afterwards is skipped forever by the
       * `already-handled` guard. The three fields below are what separate that from an ordinary
       * "the model wrote prose and meant nothing by it".
       */
      noteScan(messageId, 'no-command', {
        textHead: collapse(text).slice(0, 120),
        bracesBalanced: finished,
        awaitingReply: state.awaitingReplySince !== 0
      })

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
    if (findStopButton()) {
      // A command is on screen and the reply is still generating. Nothing is wrong; the stop
      // button disappearing mutates the DOM and schedules another check.
      noteScan(messageId, 'still-generating')
      return
    }

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

  /**
   * Last resort for 结束任务: click the composer's primary action, when nothing else found a
   * stop control.
   *
   * WHY THIS IS NOT A SELECTOR. DeepSeek gives its send and stop controls the SAME classes.
   * Measured while a reply was streaming: the primary control read
   *
   *   <div role="button" class="ds-button ds-button--primary ds-button--filled ds-button--circle
   *                              ds-button--m ds-button--icon-relative-m _52c986b">
   *
   * with no `ds-button--disabled` — byte for byte what DeepSeek's SEND selector matches once the
   * composer holds text. The two states are told apart by the icon inside, and no CSS selector
   * can see an icon.
   *
   * So adding that selector to `stopButtonSelectors` is not the fix; it is the trap. It would
   * match an idle page too, and `checkForCommand` returns on its first line whenever
   * `findStopButton()` is truthy — the automation would stop detecting commands entirely, and
   * the symptom would look like the model refusing to cooperate.
   *
   * The composer being EMPTY is the discriminator, and only code can apply it: with nothing
   * typed, the primary action cannot be a send, so if it is live it is the stop control. That is
   * why this lives in `endTask` — an explicit "stop everything" from the user — and not in the
   * selector list that gates command parsing.
   *
   * Two guards, both needed:
   *
   *   - `awaitingReplySince` — a stop control only exists while a reply is pending. Without this
   *     the click would land on whatever the primary slot holds when idle, which on ChatGPT is
   *     the VOICE button: ending a task would start dictation.
   *   - empty composer — otherwise the click could submit a half-written draft.
   */
  const clickPrimaryWhileWaiting = () => {
    if (state.awaitingReplySince === 0) return null
    const element = getComposer()
    if (!element || collapse(readComposer(element)) !== '') return null
    const candidate = lastToolbarControl()
    if (!candidate) return null

    /*
     * `programmatic` MUST be set around this click, and leaving it out was a real bug.
     *
     * The primary action also matches `sendButtonSelectors`, so the page-level CLICK interceptor
     * claims the click and runs `intercept()` — which composes the system prompt, reports
     * `injected`, and submits it as a message. Two consequences, both observed:
     *
     *   - a stray conversation turn containing the prompt and nothing the user wrote, and
     *   - `intercept` calls `preventDefault()` + `stopImmediatePropagation()`, so the site's own
     *     handler never sees the click and the reply is NOT stopped. The fallback could not have
     *     worked, whatever the button was.
     *
     * `programmatic` is exactly the "this event is ours, do not compose" flag `sendRaw` uses.
     * Reset on a timer rather than inline so it covers the whole dispatch, and so a throw can
     * never leave it stuck on — a permanently-true flag would stop the prompt being injected
     * for every later message.
     */
    state.programmatic = true
    try {
      pressButton(candidate)
    } finally {
      setTimeout(() => {
        state.programmatic = false
      }, 0)
    }
    return candidate
  }

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

      /*
       * Report what the stop button looked like BEFORE clicking it.
       *
       * `findStopButton()` is the only thing in this app that can stop ChatGPT generating, and
       * it is the one selector group nothing has ever observed: the DOM probe reported all four
       * as MISS, but no probe tick ever ran while a reply was streaming, so those MISSes proved
       * nothing. That left "does 结束任务 actually stop the model?" unanswerable from the
       * outside — the caller just received `true` either way, which is a claim, not a fact.
       *
       * The toolbar inventory is what makes it answerable. It is the probe's own traversal, so
       * when the composer's primary slot holds the stop button this names it — aria label, test
       * id, class and all — and the selector can be written from the log rather than guessed. Read
       * before the click, because clicking is precisely what removes it from the page.
       */
      const stop = findStopButton()
      /*
       * When no stop SELECTOR matched, try the composer's primary action instead.
       *
       * DeepSeek cannot have a stop selector at all — see `clickPrimaryWhileWaiting` — so on
       * that site this is the only thing that can stop a reply, and it is not a guess: it is
       * gated on a reply actually being pending and the composer being empty.
       */
      const primaryFallback = stop === null ? clickPrimaryWhileWaiting() : null

      report({
        event: 'end-task',
        stopButtonFound: stop !== null,
        stopButton: stop ? describeControl(stop) : null,
        // WHICH entry matched, so a working list can be pruned instead of left as a guess.
        matchedBy: stop
          ? PAGE.stopButtonSelectors.filter((selector) => {
              try {
                return stop.matches(selector)
              } catch (_) {
                return false
              }
            })
          : [],
        // What the structural fallback clicked, or null when it did not run.
        primaryFallback: primaryFallback ? describeControl(primaryFallback) : null,
        ...toolbarSnapshot(),
        awaitingReply: state.awaitingReplySince !== 0,
        taskActive: state.taskActive
      })

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

        /*
         * `SEND_TIMEOUT_MS` is the ceiling for EVERYTHING, and the two budgets passed here are
         * what keep the branches inside it: the grace period ends the wait for a measured
         * button, and the deadline stops the whole thing. The realistic worst case is
         * grace + two recovery confirmations ≈ 6.7s.
         */
        submitWithRetry(
          payload,
          0,
          true,
          done,
          Date.now() + SEND_TIMEOUT_MS,
          0,
          Date.now() + SEND_BUTTON_GRACE_MS
        )
      })
    },

    checkNow,
    armBaseline,
    status: () => ({ ...state })
  }

  report({ event: 'installed' })
})()
