import { isConversationId } from './types'
import type { EnvironmentKind } from './types'

/**
 * What the app needs to know about a chat website to drive it.
 *
 * WHY THIS EXISTS
 * ---------------
 * Everything here used to be a literal in `embed.ts` / `send-interceptor.js`
 * (`chatgpt.com`, `/c/<uuid>`, `#prompt-textarea`, `data-message-author-role`). Those
 * literals are the whole reason a second site could not be added: the interceptor is
 * mostly platform-INDEPENDENT logic — brace-balanced JSON extraction, the three-stage
 * fallback parser, the settle-timer that avoids reading half a streamed reply — wrapped
 * around a handful of site-specific DOM touches. This splits those apart.
 *
 * Two descriptors because there are two worlds, and conflating them is how a value ends
 * up somewhere it cannot run:
 *
 *   - `ChatPlatform`  — main process only: URLs, navigation policy, id shape.
 *   - `PageAdapter`   — injected into the PAGE. It cannot reference anything from Node,
 *                       so every field must be a literal, a string, or a source snippet
 *                       evaluated inside the page.
 */

/**
 * How text is written into a composer and read back.
 *
 * Not a style preference — the wrong one silently does nothing:
 *
 *   - `contenteditable` — ChatGPT. ProseMirror owns the document, so assigning
 *     `innerHTML` is overwritten; only `document.execCommand('insertText')` goes through
 *     the editing pipeline it listens to. Text is read via `innerText`.
 *   - `textarea` — DeepSeek. A plain `<textarea>` with a React-controlled value, where
 *     `execCommand` does nothing useful and the value must be set through the native
 *     setter plus a dispatched `input` event, or React's state never updates and the send
 *     button stays disabled. Text is read via `.value`.
 */
export type ComposerKind = 'contenteditable' | 'textarea'

/**
 * Selectors and DOM behaviour for one chat site's page.
 *
 * Selectors are LISTS. A site that renames a test id should degrade to the next entry
 * rather than silently stop matching — a silent non-match is the failure mode that costs
 * a whole debugging round, because the app looks like it simply stopped working.
 */
export interface PageAdapter {
  /** Which composer mechanism this site uses. */
  composerKind: ComposerKind
  composerSelectors: string[]
  sendButtonSelectors: string[]
  /**
   * Stop-generating button. Its disappearance is the only trustworthy signal that a
   * streamed reply has finished, so a site without one degrades to the settle timer.
   */
  stopButtonSelectors: string[]
  /** One element per assistant turn. */
  assistantSelectors: string[]
  /**
   * The element holding ONLY the assistant's answer, inside a turn.
   *
   * A turn's own text is not the answer. DeepSeek's turn carries its reasoning
   * ("已思考（用时 4 秒）" plus the whole think block) and search citations ("搜索到 22 个
   * 网页", then page titles) — and that reasoning contains `ds-markdown` blocks of its own.
   * Parsing the turn would hand all of it to the JSON extractor, which is the same class of
   * mistake as reading Markdown-rendered text: the app would be parsing words the model
   * never addressed to it.
   *
   * First match wins; empty means the turn's own text is the answer, which is the right
   * behaviour on a site that marks nothing at all. Neither platform ships empty today.
   */
  assistantReplySelectors: string[]
  /** One element per turn of either role — used to locate the scroll container. */
  messageSelectors: string[]
  /**
   * Attribute holding a stable per-message id.
   *
   * This is the idempotency key: an executed command is stored under it, so a reload that
   * re-renders every old message cannot re-run anything. Empty string means "no stable id
   * on this site", which is a real limitation to surface rather than paper over.
   */
  messageIdAttr: string
}

/** Everything the main process needs to embed and drive one chat site. */
export interface ChatPlatform {
  id: 'chatgpt' | 'deepseek' | 'claude' | 'gemini'
  /** Shown in the UI. */
  label: string
  /** Loaded when the view has no conversation to restore. */
  homeUrl: string
  /**
   * Electron session partition.
   *
   * One per site: the cookie jars must never mix, and a partition is also what carries
   * the proxy settings and login state independently.
   */
  partition: string
  /**
   * Hosts the embedded view is allowed to navigate to itself. Anything else is handed to
   * the system browser — which is also the OAuth escape hatch (providers refuse embedded
   * sign-in).
   */
  allowedOriginPattern: RegExp
  /**
   * Cookie-domain suffixes that belong to this platform's session.
   *
   * Explicit rather than derived from `allowedOriginPattern`: picking hostnames out of a
   * regex source with another regex is the kind of cleverness that breaks silently the
   * first time someone edits the pattern. This is also what the settings dialog uses to
   * report which session cookies the embedded jar actually holds.
   */
  cookieDomainSuffixes: string[]
  /**
   * Extract the conversation id from a URL PATH, or null.
   *
   * Path, not full URL: the two sites differ only in the path shape (`/c/<uuid>` versus
   * `/a/chat/s/<uuid>`), and passing the path keeps each pattern small enough to read.
   */
  conversationIdFromPath: (pathname: string) => string | null
  /** Build the URL for a stored conversation id. */
  conversationUrl: (id: string) => string
  /**
   * Source of a page script that returns `[{ id, title }]` for the sidebar's
   * conversations. Empty disables the feature for this platform.
   */
  sidebarScript: string
  /**
   * Hosts this site uses that are unreachable from this machine and that the app does not
   * need, so Chromium stops dialling them.
   *
   * WHY THIS IS HERE AND NOT A STRAY SWITCH
   * ---------------------------------------
   * `hif-dliq.deepseek.com/query` — a background beacon the page fires on a timer. It has
   * **only AAAA records and no A record at all** (measured: it CNAMEs to a Huawei Cloud WAF
   * name with IPv6 addresses only), so on a machine with no IPv6 route every attempt ends in
   * `ERR_CONNECTION_CLOSED` and Chromium logs it as
   *
   *   handshake failed; returned -1, SSL error code 1, net_error -100
   *
   * every few seconds, **naming no host**, which is what made it expensive to diagnose. The
   * page itself is completely unaffected (verified: no error text in the DOM, sidebar and
   * message list normal while the beacon failed) — this is log noise, not a fault.
   *
   * Nothing the app can do makes that host reachable: the peer offers no IPv4 and the machine
   * has no IPv6. What it CAN do is stop asking. `--host-resolver-rules=MAP <host> ~NOTFOUND`
   * makes the lookup fail immediately instead of opening a doomed connection every few
   * seconds.
   *
   * REMOVE THE ENTRY when DeepSeek publishes an A record for it, or when the machine gets
   * IPv6 — at that point the beacon would start working and this would be suppressing real
   * traffic. That is also why it lives on the platform descriptor rather than beside the
   * `appendSwitch` call: it is a fact about the SITE, and it should be deleted by whoever
   * next edits the site's descriptor.
   */
  unresolvableHosts: string[]
  /** Injected-page descriptor, as JSON-serialisable data. */
  page: PageAdapter
}

/**
 * The id-shape rule lives in `types.ts`, and this re-exports it rather than keeping a second
 * copy.
 *
 * There WERE two definitions, identical, in two files. That is the kind of duplication that
 * survives right up until one of them is changed — and this one had to change: Gemini's ids are
 * 16 hex characters, not UUIDs, and the copy that mattered was the OTHER one, because
 * `purgeInvalidIds` imports from `types.ts`. Widening only this copy would have looked correct
 * and deleted every Gemini conversation at the next launch.
 */
export { isConversationId } from './types'

/**
 * Sidebar scrapers for both sites, kept here so the descriptor can stay data.
 *
 * Both are written to be tolerant: the class names on these sites are hashed and change
 * without notice, so they match on `href` SHAPE (the one thing the router must keep
 * stable, because it is what the address bar shows) and take the label from either the
 * aria-label or the text.
 */
const SIDEBAR_SCRIPT_BY_DEFAULT = (linkSelector: string, pathPrefix: string): string => `(() => {
  const found = []
  const seen = new Set()
  const anchors = document.querySelectorAll(${JSON.stringify(linkSelector)})

  for (const anchor of anchors) {
    const href = anchor.getAttribute('href') || ''
    if (!href.startsWith(${JSON.stringify(pathPrefix)})) continue

    const id = href.slice(${pathPrefix.length}).split(/[?#]/)[0]
    if (id === '' || seen.has(id)) continue

    const title = ((anchor.getAttribute('aria-label') || '') || (anchor.textContent || '')).trim()
    if (title === '') continue

    seen.add(id)
    found.push({ id, title })
  }

  return found
})()`

/**
 * The injected-page descriptor for ChatGPT — SECOND GENERATION of the markup.
 *
 * Measured 2026-09-26 with `tools/diag/chatgpt-dom-probe.js` (two runs). Everything below
 * was read off the live DOM; nothing here is a guess, and the one thing that could NOT be
 * measured is called out as such in its own comment.
 *
 * WHAT CHANGED. The `data-*-message*` family the app was written against is gone:
 *
 *   `#prompt-textarea`            MISS count=0  → the composer is now a bare `div.ProseMirror`
 *   `[data-message-author-role]`  MISS count=0  → the role is the SUFFIX of a unit key
 *   `data-message-id`             MISS count=0  → ids moved to a message wrapper
 *   `data-testid`                 count=1, page-wide (a header context menu)
 *
 * The first two going to zero is what broke the automation, and it broke it SILENTLY —
 * exactly the failure the file header warns about. The composer survived on the loose
 * fallback, but `queryAllAssistant()` returned an empty list, so `checkForCommand` exited
 * on its first line and no reply was ever parsed again.
 *
 * THE NEW SHAPE, innermost first, for a single assistant turn:
 *
 *   span.inline-markdown
 *   └ div.MarkdownRoot-*         [data-markdown-text-style="assistant-message"]
 *     └ div.group.flex.min-w-0…  [data-chatgpt-selection-message-id="0e8f9694-…"]
 *       └ div                    [data-content-search-unit-key="fallback-turn-0:2:assistant"]
 *                                [data-chatgpt-search-unit-key] [data-chatgpt-search-message-ids]
 *         └ div.block-*
 *           └ div.flex.flex-col… [data-content-search-turn-key="fallback-turn-0"]
 *             └ div              [data-turn-key="7d69faae-…"]  ← the USER message id of the turn
 *
 * TWO SHAPES COULD SERVE as "one assistant turn", and picking both would be a bug rather
 * than belt-and-braces:
 *
 *   - `[data-content-search-unit-key$=":assistant"]` is the only element whose ROLE is
 *     readable from its own attributes — but it carries no usable id. Its
 *     `data-chatgpt-search-message-ids` is a space-separated list with a repeated entry
 *     (`"0e8f9694-… 0e8f9694-…"`), which is not an identity.
 *   - `[data-chatgpt-selection-message-id]` carries the real per-message id, which is the
 *     idempotency key the whole once-per-command guarantee rests on.
 *
 * They nest, so they are two DIFFERENT elements for the SAME turn. `queryAll` de-duplicates
 * by element, not by turn, so listing both would hand one turn two nodes — and since only
 * the id-bearing one yields a real key, the other would fall through to the content hash.
 * One turn, two keys, one command executed twice.
 *
 * So the turn is the ID-BEARING element, and the role test comes from
 * `assistantReplySelectors` instead. That is the same split DeepSeek already uses, and it
 * stays correct whether or not the id attribute also appears on user messages: if it does,
 * the reply marker rejects them; if it does not, they were never in the list.
 */
export const CHATGPT_PAGE: PageAdapter = {
  composerKind: 'contenteditable',
  /*
   * The live selector FIRST, because `queryFirst` returns the first match in list order and
   * the historical one is now dead weight. `[data-composer-markdown]` is the attribute the
   * probe found on the single composer (count=1); `[role="textbox"]` is the structural
   * restatement of the same element without depending on a ChatGPT-specific name;
   * `#prompt-textarea` and the loose `div[contenteditable="true"]` stay last so an older or
   * not-yet-migrated render still resolves.
   */
  composerSelectors: [
    'div[contenteditable="true"][data-composer-markdown]',
    'div[contenteditable="true"][role="textbox"]',
    '#prompt-textarea',
    'div[contenteditable="true"]'
  ],
  /*
   * MEASURED, finally, and the answer was not any of the three that stood here.
   *
   * A live `send-recovery` report — which now carries a toolbar snapshot precisely because
   * this question had gone unanswered twice — shows the composer's primary slot as:
   *
   *   <button aria-label="发送" class="cursor-interaction size-token-button-composer …">
   *
   * with `"testid":""` and `disabled:false`, while `composerLeft` confirms our text was
   * sitting in the box. So the button was present and enabled the whole time: this was
   * purely a wrong selector, not the render-latency theory that was the other candidate.
   *
   * Two consequences worth stating, because both were live bugs:
   *
   *   - Every programmatic send in two sessions went through the structural recovery instead
   *     of a click, because this list never matched. That also means the page-level CLICK
   *     interceptor never matched, so a message sent by clicking the button went out WITHOUT
   *     the system prompt. It looked fine only because the prompt from the first message is
   *     already in the conversation — which is why "but clicking still works" was not the
   *     proof it appeared to be.
   *   - `[data-testid="send-button"]` is dead: not one of the composer's buttons carries a
   *     test id. It stays last as a fallback for an older render.
   *
   * The label follows the STOP button's shape (`停止`, not `停止生成`) — the same shortening
   * that cost `结束任务` the ability to stop anything at all.
   *
   * Scoped entry first, for the same reason as the stop button: `queryFirst` searches the
   * whole document, and `data-composer-footer-responsive` is the footer the probe walked up to.
   */
  sendButtonSelectors: [
    '[data-composer-footer-responsive] button[aria-label="发送"]',
    'button[aria-label="发送"]',
    '[data-testid="send-button"]',
    'button[aria-label="Send message"]',
    'button[aria-label="发送消息"]'
  ],
  /*
   * MEASURED, from a live `end-task` report taken while a reply was streaming:
   *
   *   <button aria-label="停止"
   *           class="cursor-interaction size-token-button-composer flex items-center
   *                  justify-center rounded-ful…">
   *
   * Not one of the four below matched it — the Chinese label is `停止`, not `停止生成`, and
   * the button carries no test id. The consequence was not cosmetic: `结束任务` could not stop
   * ChatGPT generating at all, because clicking this button is the ONLY thing in the app that
   * can. It was reporting `true` while doing nothing.
   *
   * It is not only end-task that depends on this. `findStopButton()` also gates "do not parse a
   * reply while it is still streaming", decides when a reply has settled, and keeps the send
   * recovery from clicking what would be the Stop button. All four were degraded.
   *
   * The scoped entry comes first on purpose. The unscoped one is what was actually measured,
   * but `queryFirst` searches the WHOLE document, and a false positive here is uniquely bad: a
   * stop button that is "always found" makes `checkForCommand` bail on its first line forever,
   * which is silent death for the automation. `data-composer-footer-responsive` is the footer
   * the probe walked up to, so scoping to it should hit; the unscoped entry is the fallback.
   */
  stopButtonSelectors: [
    '[data-composer-footer-responsive] button[aria-label="停止"]',
    'button[aria-label="停止"]',
    '[data-testid="stop-button"]',
    'button[aria-label="Stop generating"]',
    'button[aria-label="Stop streaming"]',
    'button[aria-label="停止生成"]'
  ],
  /*
   * The id-bearing message wrapper. Only ONE entry: the previous
   * `[data-message-author-role="assistant"]` is measured dead, and keeping it here would
   * re-introduce the two-nodes-per-turn hazard described above the moment ChatGPT restores
   * the attribute on an ancestor element. Add it back only with a probe run that shows both
   * attributes on the SAME element.
   */
  assistantSelectors: ['[data-chatgpt-selection-message-id]'],
  /*
   * NEW, and the reason the role can move out of the turn selector: the answer lives in a
   * marked markdown root, so `readReplyText` returns the reply and nothing else, and
   * `isAssistantTurn` gets a structural role test that does not depend on which element the
   * id happens to sit on.
   */
  assistantReplySelectors: ['[data-markdown-text-style="assistant-message"]'],
  /*
   * BOTH roles, for locating the scroll container only (`findScroller` takes the last match
   * and walks up). Overlap between these two is harmless here in a way it is not for
   * `assistantSelectors`: nothing keys identity off this list.
   */
  messageSelectors: ['[data-content-search-unit-key]', '[data-chatgpt-selection-message-id]'],
  messageIdAttr: 'data-chatgpt-selection-message-id'
}

export const CHATGPT_PLATFORM: ChatPlatform = {
  id: 'chatgpt',
  label: 'ChatGPT',
  homeUrl: 'https://chatgpt.com/',
  partition: 'persist:chatgpt',
  allowedOriginPattern:
    /^https:\/\/([a-z0-9-]+\.)*(chatgpt\.com|openai\.com|oaistatic\.com|oaiusercontent\.com)(\/|$)/i,
  cookieDomainSuffixes: ['chatgpt.com', 'openai.com'],
  conversationIdFromPath: (pathname) => {
    const match = /^\/c\/([^/?#]+)/.exec(pathname)
    if (!match) return null
    const id = decodeURIComponent(match[1])
    return isConversationId(id) ? id : null
  },
  conversationUrl: (id) => `https://chatgpt.com/c/${id}`,
  sidebarScript: SIDEBAR_SCRIPT_BY_DEFAULT(
    'a[data-sidebar-item][href^="/c/"], a[href^="/c/"]',
    '/c/'
  ),
  // Nothing known to be unreachable: ChatGPT's hosts all resolve over IPv4.
  unresolvableHosts: [],
  page: CHATGPT_PAGE
}

/**
 * The injected-page descriptor for DeepSeek.
 *
 * Measured off the live page (tools/diag/deepseek-probe.js), not guessed. What the runs
 * established about the thread:
 *
 *   div.ds-virtual-list-visible-items                        ← the message list
 *   └ div[data-virtual-list-item-key="N"]                    ← ONE TURN, either role
 *     └ div.ds-message
 *       ├ div.ds-think-content                                (assistant only: reasoning)
 *       └ div.ds-markdown.ds-assistant-message-main-content   (the answer)
 *
 * Two consequences drive the values below:
 *
 *  - The per-turn wrapper carries the only stable per-item attribute, so that is what the
 *    turn selectors point at.
 *  - A turn's text is NOT the answer: it starts with 已思考（用时 4 秒）, then search
 *    citations, and the reasoning contains `ds-markdown` blocks of its own. The reply is
 *    therefore read from `.ds-assistant-message-main-content` — a SEMANTIC class, which is
 *    why it can be trusted where the hashed ones (`_9663006`, `_4f9bf79`) cannot.
 */
export const DEEPSEEK_PAGE: PageAdapter = {
  composerKind: 'textarea',
  composerSelectors: ['textarea[placeholder]', 'textarea'],
  /*
   * From the earlier DOM capture, where the composer was empty and the control read
   * `ds-button ds-button--primary ds-button--filled ds-button--circle … ds-button--disabled`.
   * The disabled modifier is dropped once there is text, so it is not part of the match.
   * Narrowed by shape (circle + primary) because the page has dozens of `ds-button`
   * elements, and a bare class match would hit a sidebar row.
   */
  sendButtonSelectors: [
    '.ds-button--primary.ds-button--circle:not(.ds-button--disabled)',
    '.ds-button--primary.ds-button--filled',
    'button[type="submit"]'
  ],
  /*
   * EMPTY, and it has to STAY empty — a measured conclusion, not an omission.
   *
   * A live `end-task` snapshot taken while a reply was streaming shows the composer holding two
   * controls, the second of them:
   *
   *   <div role="button" class="ds-button ds-button--primary ds-button--filled ds-button--circle
   *                              ds-button--m ds-button--icon-relative-m _52c986b">
   *
   * which is byte for byte what `sendButtonSelectors[0]` matches once the composer holds text,
   * with no `ds-button--disabled` to separate the two states. Send and stop differ only in the
   * icon INSIDE the button, and no CSS selector can see an icon.
   *
   * Putting that selector here anyway is the tempting move and the wrong one: it would also match
   * an IDLE page, and `checkForCommand` returns on its first line whenever `findStopButton()` is
   * truthy. DeepSeek would stop detecting commands entirely — silently, looking exactly like the
   * model having stopped cooperating.
   *
   * So 结束任务 stops DeepSeek STRUCTURALLY instead: `clickPrimaryWhileWaiting` in
   * send-interceptor.js clicks the composer's primary action, gated on a reply being pending and
   * the composer being empty. The empty composer is the discriminator CSS cannot express — with
   * nothing typed, a live primary action cannot be a send.
   */
  stopButtonSelectors: [],
  // Turns of either role; the role is decided by the reply selector, not by a class.
  assistantSelectors: ['[data-virtual-list-item-key]'],
  assistantReplySelectors: ['.ds-assistant-message-main-content'],
  messageSelectors: ['[data-virtual-list-item-key]'],
  /*
   * EMPTY on purpose. `data-virtual-list-item-key` exists but holds "1", "2", … — a
   * position in a virtualised list, so it changes meaning as rows are recycled and is not
   * an identity. Declaring it here would let two different replies share a key and silently
   * suppress the second; leaving it empty routes both sides through the content hash, which
   * is exactly what `turnKeyOf` and `executionKeyOf` were built for.
   */
  messageIdAttr: ''
}

export const DEEPSEEK_PLATFORM: ChatPlatform = {
  id: 'deepseek',
  label: 'DeepSeek',
  homeUrl: 'https://chat.deepseek.com/',
  partition: 'persist:deepseek',
  allowedOriginPattern: /^https:\/\/([a-z0-9-]+\.)*(deepseek\.com)(\/|$)/i,
  cookieDomainSuffixes: ['deepseek.com'],
  conversationIdFromPath: (pathname) => {
    const match = /^\/a\/chat\/s\/([^/?#]+)/.exec(pathname)
    if (!match) return null
    const id = decodeURIComponent(match[1])
    return isConversationId(id) ? id : null
  },
  conversationUrl: (id) => `https://chat.deepseek.com/a/chat/s/${id}`,
  sidebarScript: SIDEBAR_SCRIPT_BY_DEFAULT('a[href^="/a/chat/s/"]', '/a/chat/s/'),
  /*
   * Measured with DSH_NET_LOG=1: this host produced 24 `net_error -100` failures over 149
   * seconds, i.e. one doomed TLS handshake every ~6.5 seconds, while every other host the
   * page uses completed normally. It has AAAA records only, and this machine has no IPv6
   * default route — so it can never connect. See the field's own comment for when to delete
   * this.
   */
  unresolvableHosts: ['hif-dliq.deepseek.com'],
  page: DEEPSEEK_PAGE
}

/**
 * The injected-page descriptor for Claude — measured 2026-09-29 with
 * `tools/diag/claude-dom-probe.js`.
 *
 * Every value below came back as a direct HIT in that run, which is worth stating because it is
 * unusual: Claude marks its chat up with `data-testid`, so the probe's `data-testid VALUES` table
 * named the role markers outright rather than requiring them to be inferred from shape.
 *
 * THE DESKTOP UI IS IN ENGLISH. `Send message`, `Stop response`, `Write your prompt to Claude`.
 * The conversation titles are whatever the user wrote, but the CONTROLS are not localised — so
 * nothing here keys off Chinese text, and the two selectors that matter most are test ids.
 *
 * WHAT THE PAGE LOOKS LIKE:
 *
 *   div[data-testid="chat-input"]        contenteditable, class "tiptap ProseMirror"
 *                                        role=textbox, data-doc-empty while empty
 *   └ (toolbar, walked up to)
 *     button[data-testid="chat-input-send"]    aria-label="Send message"
 *     button[aria-label="Stop response"]       only while a reply is streaming
 *     button[data-testid="chat-input-attach"]  aria-label="Add files, connectors, and more"
 *     button[aria-label="Dictate"] / "Use voice mode" / "Microphone"
 *
 *   [data-testid="transcript-list"]      the thread
 *   ├ [data-testid="user-message"]       one per user turn
 *   ├ [data-testid="assistant-message"]  one per assistant turn, carries data-is-streaming
 *   └ [data-testid="last-message-sentinel"]   a zero-height marker at the end
 *   [data-autoscroll-container="true"]   the scroll container, as an explicit hook
 *
 * TWO TRAPS THIS SITE SETS, both measured:
 *
 *  1. The assistant turn's `innerText` starts with `"Claude responded: "`, from a
 *     `<span class="sr-only" role="status" aria-live="polite">` inside it. Tailwind's `sr-only`
 *     uses `clip`, not `display:none`, so `innerText` INCLUDES screen-reader text. The answer is
 *     therefore read from the narrower `font-claude-response` container — the same narrowing
 *     DeepSeek needs, for the same class of reason.
 *
 *  2. The composer's toolbar reports MORE controls than it has while a reply streams: the run
 *     caught counts of 5, 6 and 8, with `Dictate`/`Microphone`/`Use voice mode` appearing twice.
 *     So the toolbar container spans more than one composer-ish row, and anything that counts
 *     controls there must tolerate duplicates rather than assume one of each.
 */
export const CLAUDE_PAGE: PageAdapter = {
  composerKind: 'contenteditable',
  /*
   * The test id first, then the two structural restatements of the same element. It is TipTap
   * (a ProseMirror wrapper), so the contenteditable write path is the same one ChatGPT needs —
   * `execCommand('insertText')`, not an HTML assignment.
   */
  composerSelectors: [
    'div[contenteditable="true"][data-testid="chat-input"]',
    'div.ProseMirror[contenteditable="true"]',
    'div[contenteditable="true"]'
  ],
  /*
   * The test id is preferred over the label on purpose: `Send message` is a translation, the id
   * is not. Both were HITs; the label is kept as the fallback for a build that drops the id.
   */
  sendButtonSelectors: ['button[data-testid="chat-input-send"]', 'button[aria-label="Send message"]'],
  /*
   * MEASURED IN BOTH STATES, which is the only reason this list is trustworthy: `count=1` on the
   * tick where a reply was streaming, and every entry a MISS on ticks where nothing was. So it
   * is present only while generating, exactly like ChatGPT's — which means it can be used both to
   * stop generation and to answer "is this reply finished yet?", the question DeepSeek cannot
   * answer at all.
   *
   * It carries no test id, so the aria label is the only handle there is.
   */
  stopButtonSelectors: ['button[aria-label="Stop response"]'],
  assistantSelectors: ['[data-testid="assistant-message"]'],
  /*
   * Not the turn itself. See trap 1 above: the turn's text carries a screen-reader prefix, and
   * `font-claude-response` is where the answer actually lives.
   */
  assistantReplySelectors: ['[class*="font-claude-response"]'],
  messageSelectors: ['[data-testid="user-message"]', '[data-testid="assistant-message"]'],
  /*
   * EMPTY, and this is a finding rather than an omission — the same conclusion DeepSeek's entry
   * records, reached the same way. The only id-ish attributes on a page full of turns were
   * `data-row-key` (the sidebar's rows), plus `data-rs-index` and `data-index`, which are
   * POSITIONS in a virtualised list and change meaning as rows are recycled. An index is not an
   * identity, so both sides fall through to the content hash in `turnKeyOf` — which is what that
   * function exists for.
   */
  messageIdAttr: ''
}

export const CLAUDE_PLATFORM: ChatPlatform = {
  id: 'claude',
  label: 'Claude',
  homeUrl: 'https://claude.ai/new',
  partition: 'persist:claude',
  /*
   * anthropic.com is included for the same reason openai.com is on ChatGPT's: the session's
   * own supporting hosts (static assets, auth endpoints) live there, and handing them to the
   * system browser would break the page.
   */
  allowedOriginPattern: /^https:\/\/([a-z0-9-]+\.)*(claude\.ai|anthropic\.com)(\/|$)/i,
  cookieDomainSuffixes: ['claude.ai', 'anthropic.com'],
  /*
   * `/chat/<uuid>`, measured from the navigation log: the probe walked
   * `/new` → Cloudflare → `/logout?involuntary=1` → `/login` → `/chat/fa4e73a6-92b9-4b7b-832c-2de7b09e48bd`.
   * Validated by shape like the other two, so a placeholder route can never reach the database.
   */
  conversationIdFromPath: (pathname) => {
    const match = /^\/chat\/([^/?#]+)/.exec(pathname)
    if (!match) return null
    const id = decodeURIComponent(match[1])
    return isConversationId(id) ? id : null
  },
  conversationUrl: (id) => `https://claude.ai/chat/${id}`,
  /*
   * Same shape as the other two sites, and the probe confirmed the links carry the title as
   * their text (8 of them, each `/chat/<uuid>` with the conversation's name).
   */
  sidebarScript: SIDEBAR_SCRIPT_BY_DEFAULT('a[href^="/chat/"]', '/chat/'),
  // Nothing measured as unreachable. Claude's Cloudflare is a different problem — see the
  // identity patch in src/main/embed.ts, which is what gets the page loaded at all.
  unresolvableHosts: [],
  page: CLAUDE_PAGE
}

/**
 * The injected-page descriptor for Gemini — measured 2026-09-29 with
 * `tools/diag/gemini-dom-probe.js`.
 *
 * Every value below came back as a direct HIT, and the two transient ones were caught by
 * shortening the probe's tick to 5s after a 15s tick stepped straight over the whole reply.
 *
 * THE THING TO KNOW FIRST: **Gemini cannot be signed into from inside the embed.** Google answers
 * 无法登录 / "此浏览器或应用可能不安全" to a first-party sign-in in an embedded view — the third
 * time this wall has come up here, after third-party OAuth and Apple. And unlike ChatGPT, the
 * sign-in CANNOT be handed to the system browser either, because the site itself is a Google
 * host. The session has to be imported from a real browser; `tools/diag/gemini-cookie-probe.js`
 * proves that works, including the part that is easy to get wrong (cookies must be written with
 * an expiry, or Chromium never persists them).
 *
 * WHAT THE PAGE LOOKS LIKE:
 *
 *   div.ql-editor[contenteditable="true"]     the composer. **Quill, not ProseMirror** —
 *                                             class "ql-editor textarea new-input-ui"
 *   └ (toolbar, walked up to)
 *     button[aria-label="上传和工具"]
 *     button[data-testid="bard-mode-menu-button"]      the model picker ("Flash")
 *     button[aria-label="语音输入 (^⇧D)"]
 *     button[aria-label="发送"]                        ONLY while the composer holds text
 *     button[aria-label="停止回答"]                    ONLY while a reply is generating
 *
 *   message-content        one per assistant turn, and it carries the id
 *   user-query             one per user turn
 *   model-response         the outer per-turn wrapper, both roles
 *   thinking-overlay       the reasoning panel — OUTSIDE message-content, which is why the
 *                          answer can be read without also reading the model's thinking
 *
 * TWO THINGS WORTH STATING PLAINLY:
 *
 *  1. The three toolbar states were each observed on several ticks, which is the only reason the
 *     buttons can be told apart: an empty composer shows THREE controls ending in 语音输入, a
 *     composer with text shows FOUR ending in 发送, and a generating reply shows FOUR ending in
 *     停止回答. A send button that is simply absent is not the same as one that failed to match —
 *     and the app's send confirmation depends on that difference.
 *
 *  2. **Neither the send nor the stop button has a test id** — the `data-testid` is empty on both.
 *     The aria labels are localised, so `发送` becomes `Send message` in an English UI. ChatGPT
 *     ends up in the same position for its stop button, and the structural `toolbar-last`
 *     recovery in submitWithRetry is what covers it.
 */
export const GEMINI_PAGE: PageAdapter = {
  composerKind: 'contenteditable',
  composerSelectors: [
    'div.ql-editor[contenteditable="true"]',
    'rich-textarea div[contenteditable="true"]',
    'div[contenteditable="true"]'
  ],
  /*
   * The Chinese label first because that is the UI this was measured in, with the English one as
   * the fallback. A bare `button[aria-label="发送"]` search is document-wide, which is why the
   * structural last-control fallback exists rather than being relied on alone.
   */
  sendButtonSelectors: ['button[aria-label="发送"]', 'button[aria-label="Send message"]'],
  /*
   * Present only while generating — confirmed on four separate ticks. That matters beyond being
   * able to stop a reply: it is the signal that says "this reply is not finished yet", which
   * DeepSeek cannot answer at all and has to guess at with a settle timer.
   */
  stopButtonSelectors: ['button[aria-label="停止回答"]', 'button[aria-label="Stop response"]'],
  assistantSelectors: ['message-content'],
  /*
   * EMPTY, and measured rather than assumed: the thinking panel is a SIBLING overlay
   * (`thinking-overlay`), not a descendant, so a turn's own text IS the answer. Narrowing here
   * would be cargo-culting DeepSeek's rule onto a site that does not need it.
   *
   * Recorded as a caveat: inline citations ARE inside the turn — `sources-carousel-inline`,
   * `source-inline-chip`, `source-footnote`. They are small chips and footnote markers rather
   * than prose, so they have not been seen to interfere with extracting the JSON block, but a
   * reply that quotes a URL containing braces is the case to watch.
   */
  assistantReplySelectors: [],
  /*
   * Both roles, for locating the scroll container and for the newest-turn scan. `message-content`
   * is listed too: it is the element the id sits on, and `queryAll` de-duplicates by element, so
   * the three entries do not double-count a turn.
   */
  messageSelectors: ['model-response', 'user-query', 'message-content'],
  /*
   * `id`, because the assistant turn's own id attribute looks like
   * `message-content-id-r_4d72620b39f3e23f` — a real per-message identity, verified on two turns.
   * It is an HTML `id` rather than a `data-` attribute, which `messageIdOf` reads the same way;
   * the cost is that the MutationObserver's attribute filter now watches `id`, which changes more
   * often elsewhere on an Angular page and so re-arms the settle timer more than it needs to.
   */
  messageIdAttr: 'id'
}

export const GEMINI_PLATFORM: ChatPlatform = {
  id: 'gemini',
  label: 'Gemini',
  homeUrl: 'https://gemini.google.com/app',
  partition: 'persist:gemini',
  /*
   * Google hosts, and that is a deliberate departure from how the other platforms treat Google.
   * For ChatGPT, excluding accounts.google.com is what sends third-party OAuth to the system
   * browser; here the site IS a Google host, so there is nothing to hand off — and the probe
   * confirmed the sign-in hop stays inside the embed and is then refused. The allowlist only has
   * to keep the page's own assets loading.
   */
  allowedOriginPattern:
    /^https:\/\/([a-z0-9-]+\.)*(gemini\.google\.com|google\.com|googleusercontent\.com|gstatic\.com)(\/|$)/i,
  cookieDomainSuffixes: ['google.com'],
  /*
   * `/app/<16 hex>` — measured, ten samples, never a UUID. `isConversationId` accepts both
   * shapes; see the rule in `types.ts` for why widening it was not optional.
   */
  conversationIdFromPath: (pathname) => {
    const match = /^\/app\/([^/?#]+)/.exec(pathname)
    if (!match) return null
    const id = decodeURIComponent(match[1])
    return isConversationId(id) ? id : null
  },
  conversationUrl: (id) => `https://gemini.google.com/app/${id}`,
  sidebarScript: SIDEBAR_SCRIPT_BY_DEFAULT('a[href^="/app/"]', '/app/'),
  // Nothing measured as unreachable.
  unresolvableHosts: [],
  page: GEMINI_PAGE
}

export const CHAT_PLATFORMS: ChatPlatform[] = [
  CHATGPT_PLATFORM,
  DEEPSEEK_PLATFORM,
  CLAUDE_PLATFORM,
  GEMINI_PLATFORM
]

/**
 * The platform a new session starts on.
 *
 * A session is created for a PURPOSE (this machine, or a host over SSH); which model it talks
 * to is a choice made inside the chat and can change later. So creation always uses this and no
 * call site passes a platform id — a "default" that every caller overrode anyway would only be
 * a way to create the wrong site's session by forgetting to pass one.
 */
export const DEFAULT_PLATFORM_ID: ChatPlatform['id'] = CHATGPT_PLATFORM.id

export function platformById(id: string): ChatPlatform | null {
  return CHAT_PLATFORMS.find((platform) => platform.id === id) ?? null
}

/**
 * The prompt describes the machine the terminal drives, so it is per-SESSION, not
 * per-platform — but the two sites' prompts differ in one respect worth stating: the
 * command protocol is the same, because the app is what parses it.
 */
export type PromptDialect = EnvironmentKind
