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
   * First match wins; empty means the turn's own text is the answer (ChatGPT).
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
  id: 'chatgpt' | 'deepseek'
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
 * A conversation id, as both sites use it: `/c/<uuid>` on ChatGPT,
 * `/a/chat/s/<uuid>` on DeepSeek.
 *
 * Validated by SHAPE rather than "whatever is in the path" — both sites serve placeholder
 * routes that look like conversations and are not, and those must never reach the
 * database.
 */
export function isConversationId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

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
 * The injected-page descriptor for ChatGPT.
 *
 * Every value here was read off the live page. They are unchanged from the literals they
 * replace — this refactor must not alter ChatGPT behaviour.
 */
export const CHATGPT_PAGE: PageAdapter = {
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
  // ChatGPT's turn text IS the answer; nothing to narrow.
  assistantReplySelectors: [],
  messageSelectors: ['[data-message-author-role]'],
  messageIdAttr: 'data-message-id'
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
   * No stop button was found in either run: both snapshots reported null, and a
   * label-based filter never matched. Left empty rather than filled with a guess — the
   * settle timer covers reply-completion without it.
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

export const CHAT_PLATFORMS: ChatPlatform[] = [CHATGPT_PLATFORM, DEEPSEEK_PLATFORM]

export function platformById(id: string): ChatPlatform | null {
  return CHAT_PLATFORMS.find((platform) => platform.id === id) ?? null
}

/**
 * The prompt describes the machine the terminal drives, so it is per-SESSION, not
 * per-platform — but the two sites' prompts differ in one respect worth stating: the
 * command protocol is the same, because the app is what parses it.
 */
export type PromptDialect = EnvironmentKind
