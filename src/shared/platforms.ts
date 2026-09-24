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
  page: CHATGPT_PAGE
}

/**
 * The injected-page descriptor for DeepSeek.
 *
 * ⚠ NOT FILLED IN YET — deliberately empty, not guessed.
 *
 * The values must come off the live page (that is what `tools/diag/deepseek-probe.js`
 * is for). Writing plausible-looking selectors here would be worse than leaving them
 * blank: a selector list that matches nothing fails SILENTLY — no error, no log, the app
 * just never fires — which is the most expensive kind of wrong, because it looks like the
 * feature was never built rather than like a bad guess.
 *
 * What is already known and therefore filled in: the site is `chat.deepseek.com`, its
 * conversation URLs are `/a/chat/s/<uuid>`, and its composer is a real `<textarea>`
 * (`<textarea ... placeholder="给 DeepSeek 发送消息 " rows="2">`) rather than
 * ProseMirror's contenteditable — so the write path has to be the native-setter one.
 */
export const DEEPSEEK_PAGE: PageAdapter = {
  composerKind: 'textarea',
  composerSelectors: [],
  sendButtonSelectors: [],
  stopButtonSelectors: [],
  assistantSelectors: [],
  messageSelectors: [],
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
