import { BrowserWindow, WebContentsView, shell } from 'electron'
import interceptorSource from './injected/send-interceptor.js?raw'
import {
  CHATGPT_ORIGIN,
  EMBED_HOME_URL,
  EMBED_PARTITION,
  FALLBACK_ENVIRONMENT,
  buildTerminalPrefix,
  conversationIdFromUrl,
  isConversationId
} from '../shared/types'
import type {
  EmbedBounds,
  EmbedCommand,
  EmbedState,
  ExternalAuthNotice,
  ExternalAuthProvider,
  InterceptorPageEvent,
  InterceptorStatus,
  ParsedCommand,
  ScrapedConversation
} from '../shared/types'

/**
 * Hosts chatgpt.com in a native `WebContentsView` layered on top of the React
 * renderer.
 *
 * Why not an `<iframe>`: chatgpt.com refuses to be framed (`X-Frame-Options` /
 * CSP `frame-ancestors`), so the page can only be embedded out-of-process.
 *
 * Why a dedicated partition: the embedded page gets its own cookie jar, so
 * third-party content can never touch the app's own session.
 *
 * IMPORTANT: a native view is not a DOM node. It always paints *above* the
 * renderer, so React must keep the measured slot clear of overlapping UI.
 */
const ALLOWED_NAVIGATION =
  /^https:\/\/([a-z0-9-]+\.)*(chatgpt\.com|openai\.com|oaistatic\.com|oaiusercontent\.com)(\/|$)/i

/** Tag the injected page script prefixes its console reports with. */
const INTERCEPTOR_LOG_TAG = '[cmd-terminal] '

/**
 * A stock Electron UA advertises `Electron/44.4.3`; Cloudflare's bot rules on
 * chatgpt.com reject that, so present a plain Chrome user agent instead.
 */
function chromeLikeUserAgent(): string {
  const platformToken =
    process.platform === 'win32'
      ? 'Windows NT 10.0; Win64; x64'
      : process.platform === 'darwin'
        ? 'Macintosh; Intel Mac OS X 10_15_7'
        : 'X11; Linux x86_64'

  return (
    `Mozilla/5.0 (${platformToken}) AppleWebKit/537.36 (KHTML, like Gecko) ` +
    `Chrome/${process.versions.chrome} Safari/537.36`
  )
}

function normalizeUrl(input: string): string | null {
  const trimmed = input.trim()
  if (trimmed === '') return null
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    return new URL(candidate).toString()
  } catch {
    return null
  }
}

/**
 * Keep authentication providers out of the embedded user-agent.
 *
 * OAuth commonly reaches the provider through a server-side redirect rather
 * than a user navigation, so this policy is shared by `will-navigate`,
 * `will-redirect`, and the main-frame branch of `will-frame-navigate`.
 */
function isAllowedNavigation(url: string): boolean {
  return ALLOWED_NAVIGATION.test(url)
}

function externalAuthProvider(url: string): ExternalAuthProvider | null {
  try {
    const hostname = new URL(url).hostname.toLowerCase()
    if (hostname === 'accounts.google.com') return 'google'
    if (hostname === 'appleid.apple.com') return 'apple'
  } catch {
    // Invalid URLs are handled by the normal external-navigation path.
  }
  return null
}

/**
 * Runs inside the embedded page (main world).
 *
 * Each sidebar entry is rendered as:
 *   <li class="list-none">
 *     <a data-sidebar-item="true" aria-label="歌曲名称介绍"
 *        href="/c/6ab11ffa-64b8-83e8-9247-c19ae00ad95e">…</a>
 *   </li>
 *
 * The aria-label carries the conversation name; textContent is the fallback for
 * the unordered history list, which renders the label differently.
 *
 * Only the raw path segment is extracted here — validating it is left to
 * `isConversationId()` in shared/types so the rule lives in exactly one place.
 * Written without regex-literal escapes so it survives a TS template literal.
 */
const SCRAPE_SIDEBAR_SCRIPT = `(() => {
  const found = []
  const seen = new Set()
  const anchors = document.querySelectorAll('a[data-sidebar-item][href^="/c/"], a[href^="/c/"]')

  for (const anchor of anchors) {
    const href = anchor.getAttribute('href') || ''
    if (!href.startsWith('/c/')) continue

    const id = href.slice(3).split(/[?#]/)[0]
    if (id === '' || seen.has(id)) continue

    const title = ((anchor.getAttribute('aria-label') || '') || (anchor.textContent || '')).trim()
    if (title === '') continue

    seen.add(id)
    found.push({ id, title })
  }

  return found
})()`

interface ScrapeResult {
  id: string
  title: string
}

/** Callbacks the embed raises towards the main process. */
export interface EmbedHandlers {
  onState(state: EmbedState): void
  /** A third-party OAuth provider was opened in the system browser. */
  onExternalAuth(notice: ExternalAuthNotice): void
  /** A conversation the page just navigated to (auto-saved). */
  onConversation(conversation: ScrapedConversation): void
  /** Results of a background sidebar scrape. */
  onSynced(conversations: ScrapedConversation[]): void
  /** Terminal-mode interceptor changed state. */
  onInterceptor(status: InterceptorStatus): void
  /** The model's reply contained a command. */
  onCommand(command: ParsedCommand): void
  /**
   * A reply looked like it carried a command but could not be parsed.
   *
   * Surfaced on purpose: dropping it silently is indistinguishable from the app
   * being broken, which is exactly how the unescaped-quote bug stayed hidden.
   */
  onParseFailed(text: string): void
}

export class ChatGptEmbed {
  private view: WebContentsView | null = null
  private bounds: EmbedBounds = { x: 0, y: 0, width: 0, height: 0 }
  private visible = true
  /** Dedupe key of the last conversation handed to the store. */
  private lastCaptured = ''
  private lastSyncAt = 0

  /**
   * Terminal mode is ON by default: every outgoing message gets the system
   * prompt prepended inside the composer before it is submitted.
   */
  private interceptor: InterceptorStatus = {
    enabled: true,
    installed: false,
    injectedCount: 0,
    lastSentText: null,
    taskStartedAt: null,
    taskFinishedAt: null,
    // A safe default until main has probed the machine and calls
    // setPromptPrefix(); see buildTerminalPrompt().
    prefix: buildTerminalPrefix(FALLBACK_ENVIRONMENT)
  }

  /**
   * Replace the injected prompt.
   *
   * The prompt describes the machine, which is only known after a startup probe,
   * so it cannot be a compile-time constant. Re-installs into a live page so the
   * change takes effect on the next send rather than the next reload.
   */
  setPromptPrefix(prefix: string): void {
    if (this.interceptor.prefix === prefix) return
    this.interceptor.prefix = prefix
    if (this.liveContents()) void this.installInterceptor()
  }

  /**
   * When true, a page that (re)loads starts with its restored history suppressed.
   * Main keeps this in sync with the execution mode.
   */
  private armBaselineOnInstall = false

  constructor(private readonly handlers: EmbedHandlers) {}

  /** Create the view and add it to the window. Safe to call more than once. */
  attach(parent: BrowserWindow): void {
    if (this.view && !this.view.webContents.isDestroyed()) return

    const view = new WebContentsView({
      webPreferences: {
        partition: EMBED_PARTITION,
        // Untrusted third-party content: no bridge, no Node, sandboxed.
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
        // ChatGPT reply detection must keep running while the app is minimized.
        backgroundThrottling: false
      }
    })

    this.view = view
    view.setBackgroundColor('#141922')
    parent.contentView.addChildView(view)

    const contents = view.webContents
    contents.setUserAgent(process.env.EMBED_USER_AGENT ?? chromeLikeUserAgent())

    // Keep the view pinned to OpenAI properties; everything else is external.
    // This is also what makes third-party OAuth (accounts.google.com) open in
    // the system browser, since Google blocks embedded sign-in. OAuth flows
    // often arrive as a 30x redirect, so `will-navigate` alone is not enough.
    const openExternalUrl = (url: string): void => {
      const provider = externalAuthProvider(url)
      if (provider) this.handlers.onExternalAuth({ provider, openedAt: Date.now() })

      try {
        const parsed = new URL(url)
        console.info(`[embed] opening external navigation: ${parsed.origin}${parsed.pathname}`)
      } catch {
        console.info('[embed] opening external navigation')
      }

      void shell.openExternal(url).catch((error) => {
        console.warn('[embed] external navigation failed:', (error as Error).message)
      })
    }

    // Anything the page tries to open in a new window goes to the real browser.
    contents.setWindowOpenHandler(({ url }) => {
      openExternalUrl(url)
      return { action: 'deny' }
    })

    const openExternalNavigation = (event: Electron.Event, url: string): void => {
      if (isAllowedNavigation(url)) return

      event.preventDefault()
      openExternalUrl(url)
    }

    contents.on('will-navigate', (event, url) => {
      openExternalNavigation(event, url)
    })

    contents.on('will-redirect', (event, url) => {
      openExternalNavigation(event, url)
    })

    contents.on('will-frame-navigate', (details) => {
      if (details.isMainFrame) {
        openExternalNavigation(details, details.url)
      } else if (!isAllowedNavigation(details.url)) {
        // Do not let an embedded third-party frame start an OAuth flow. It has
        // no usable route back to the app and Google will reject the webview.
        details.preventDefault()
      }
    })

    // The injected script reports through console.log, because the page has no
    // preload and therefore no IPC bridge. This is a one-way, parse-only channel.
    contents.on('console-message', (details) => {
      this.handlePageReport(details.message)
    })

    // Re-inject on every full page load; client-side route changes keep the
    // document-level listeners installed by the previous run.
    contents.on('did-finish-load', () => {
      void this.installInterceptor()
    })

    // NOTE: `did-navigate-in-page` is the one that fires for ChatGPT's
    // client-side route changes (`/` -> `/c/<uuid>` without a page load).
    contents.on('did-start-loading', () => this.publishState())
    contents.on('did-stop-loading', () => {
      this.publishState()
      this.captureCurrentConversation()
      this.autoSync()
    })
    contents.on('did-navigate', () => {
      this.publishState()
      this.captureCurrentConversation()
    })
    contents.on('did-navigate-in-page', () => {
      this.publishState()
      this.captureCurrentConversation()
    })
    contents.on('page-title-updated', () => {
      this.publishState()
      this.captureCurrentConversation()
    })
    contents.on('render-process-gone', () => this.publishState())

    void contents.loadURL(EMBED_HOME_URL)
    this.applyBounds()
  }

  setBounds(bounds: EmbedBounds): void {
    this.bounds = bounds
    this.applyBounds()
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    this.applyBounds()
  }

  /**
   * Reload the page.
   *
   * Needed after the proxy changes: connections already established keep using the
   * old route, so the page has to be fetched again through the new one.
   */
  reload(): void {
    this.liveContents()?.reload()
  }

  /**
   * Reload and resolve once the new document has finished loading.
   *
   * Needed after a session import: the cookie has to be in the jar before the page
   * asks who the user is, so the caller cannot simply fire `reload()` and check
   * immediately — it would inspect the OLD document and report a signed-out page for
   * a session that is actually valid.
   *
   * Resolves on timeout rather than rejecting: a page that never finishes loading
   * must not leave the settings dialog stuck, and the caller re-checks anyway.
   */
  async reloadAndWait(timeoutMs = 25000): Promise<void> {
    const contents = this.liveContents()
    if (!contents) return

    await new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        contents.removeListener('did-finish-load', finish)
        contents.removeListener('did-fail-load', finish)
        resolve()
      }
      const timer = setTimeout(finish, timeoutMs)

      contents.once('did-finish-load', finish)
      contents.once('did-fail-load', finish)
      contents.reload()
    })
  }

  /**
   * Point the view at a URL and resolve once it has loaded.
   *
   * Same contract as reloadAndWait, for the same reason.
   */
  async loadAndWait(url: string, timeoutMs = 25000): Promise<void> {
    const contents = this.liveContents()
    if (!contents) return

    await new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        contents.removeListener('did-finish-load', finish)
        contents.removeListener('did-fail-load', finish)
        resolve()
      }
      const timer = setTimeout(finish, timeoutMs)

      contents.once('did-finish-load', finish)
      contents.once('did-fail-load', finish)
      void contents.loadURL(url).catch(finish)
    })
  }

  command(command: EmbedCommand): void {
    const contents = this.liveContents()
    if (!contents) return

    const history = contents.navigationHistory
    switch (command) {
      case 'back':
        if (history.canGoBack()) history.goBack()
        break
      case 'forward':
        if (history.canGoForward()) history.goForward()
        break
      case 'reload':
        contents.reload()
        break
      case 'stop':
        contents.stop()
        break
      case 'home':
        void contents.loadURL(EMBED_HOME_URL)
        break
    }
  }

  navigate(input: string): void {
    const contents = this.liveContents()
    const url = normalizeUrl(input)
    if (!contents || !url) return
    void contents.loadURL(url)
  }

  getInterceptorStatus(): InterceptorStatus {
    return { ...this.interceptor }
  }

  /**
   * The live web contents, or null when the view is gone.
   *
   * Public because session import has to evaluate a probe inside the page, and
   * duplicating the "is it still alive" check at every call site is how one of them
   * eventually gets it wrong.
   */
  contents(): Electron.WebContents | null {
    return this.liveContents()
  }

  /** Keep the injected script's baseline policy in sync with the execution mode. */
  setBaselinePolicy(armOnInstall: boolean): void {
    this.armBaselineOnInstall = armOnInstall
  }

  /**
   * Turn terminal mode on/off. Always re-pushes the config into the live page so
   * the change takes effect immediately, without waiting for a reload.
   */
  setInterceptorEnabled(enabled: boolean): InterceptorStatus {
    this.interceptor.enabled = enabled
    void this.installInterceptor()
    const status = this.getInterceptorStatus()
    this.handlers.onInterceptor(status)
    return status
  }

  /**
   * Inject the send interceptor into the page and push the current config.
   *
   * `executeJavaScript` is not subject to the page's CSP nonce (it does not go
   * through a script tag), and it runs in the main world — which is what the
   * page's own React handlers use, so our capture-phase listeners see the same
   * events they do.
   */
  async installInterceptor(): Promise<void> {
    const contents = this.liveContents()
    if (!contents) return

    const config = JSON.stringify({
      enabled: this.interceptor.enabled,
      prefix: this.interceptor.prefix,
      // A full page (re)load must also suppress whatever it restores from
      // history, otherwise an old reply would look like a fresh command.
      armBaseline: this.armBaselineOnInstall
    })

    try {
      await contents.executeJavaScript(
        `${interceptorSource}\n;` +
          `window.__cmdTerminalInterceptor && window.__cmdTerminalInterceptor.configure(${config});true`
      )
    } catch (error) {
      // A navigation during injection is normal; did-finish-load will retry.
      console.warn('[embed] interceptor injection failed:', (error as Error).message)
    }
  }

  /**
   * Push command output into the composer and submit it, deliberately WITHOUT
   * the system prompt: the prompt is already established by the first message of
   * the conversation, and re-sending it every round would bloat the context.
   *
   * `busy` means the user is typing — we must never clobber their draft.
   * `stuck` means the text went in but ChatGPT never accepted the submit.
   */
  async sendRaw(
    text: string
  ): Promise<'ok' | 'busy' | 'stuck' | 'no-composer' | 'insert-failed'> {
    const contents = this.liveContents()
    if (!contents) return 'no-composer'

    try {
      const outcome = (await contents.executeJavaScript(
        `window.__cmdTerminalInterceptor
           ? window.__cmdTerminalInterceptor.sendRaw(${JSON.stringify(text)})
           : 'no-composer'`
      )) as unknown

      if (
        outcome === 'ok' ||
        outcome === 'busy' ||
        outcome === 'stuck' ||
        outcome === 'insert-failed'
      ) {
        return outcome
      }
      return 'no-composer'
    } catch (error) {
      console.warn('[embed] sendRaw failed:', (error as Error).message)
      return 'no-composer'
    }
  }

  /**
   * Tell the page to treat everything currently rendered — and whatever renders
   * next — as pre-existing.
   *
   * Called whenever the app moves to another conversation while auto mode is on,
   * and when auto mode is switched on. Without it, opening an old conversation
   * whose last reply contains a command would execute that command immediately.
   */
  async armCommandBaseline(): Promise<boolean> {
    const contents = this.liveContents()
    if (!contents) return false

    try {
      await contents.executeJavaScript(
        `window.__cmdTerminalInterceptor
           ? window.__cmdTerminalInterceptor.armBaseline()
           : false`
      )
      return true
    } catch {
      return false
    }
  }

  /** Re-scan the last reply immediately, bypassing the settle delay. */
  async checkForCommandNow(): Promise<boolean> {
    const contents = this.liveContents()
    if (!contents) return false
    try {
      await contents.executeJavaScript(
        `window.__cmdTerminalInterceptor && window.__cmdTerminalInterceptor.checkNow(); true`
      )
      return true
    } catch {
      return false
    }
  }

  /**
   * Read the page's own sidebar markup and return every conversation it lists.
   *
   * `executeJavaScript` resolves in the page's main world. It is awaited — and
   * its result validated — because the page can navigate away mid-call, in which
   * case the promise resolves against a destroyed context.
   */
  async scrapeConversations(): Promise<ScrapedConversation[]> {
    const contents = this.liveContents()
    if (!contents) return []

    try {
      const raw = (await contents.executeJavaScript(SCRAPE_SIDEBAR_SCRIPT)) as unknown
      if (!Array.isArray(raw)) return []

      return (raw as ScrapeResult[])
        .filter((item) => item && typeof item.id === 'string' && typeof item.title === 'string')
        // Placeholder routes such as /c/WEB are linked in the UI but are not
        // conversations, so they must never reach the database.
        .filter((item) => isConversationId(item.id))
        .map((item) => ({
          id: item.id,
          title: item.title.trim(),
          url: `${CHATGPT_ORIGIN}/c/${item.id}`
        }))
        .filter((item) => item.title !== '')
    } catch (error) {
      // A navigation during the call is normal, not worth crashing over.
      console.warn('[embed] sidebar scrape failed:', (error as Error).message)
      return []
    }
  }

  /**
   * Current snapshot of the embedded view.
   *
   * The renderer pulls this once on mount: the first batch of embed events
   * (did-start-loading / did-navigate) fires while the window is still being
   * created, i.e. before React has subscribed, so push-only updates would leave
   * the UI stuck on its initial "loading" state.
   */
  getState(): EmbedState {
    const contents = this.liveContents()
    if (!contents) {
      return {
        url: '',
        title: '',
        isLoading: false,
        canGoBack: false,
        canGoForward: false,
        conversationId: null
      }
    }

    const url = contents.getURL()
    return {
      url,
      title: contents.getTitle(),
      isLoading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      conversationId: conversationIdFromUrl(url)
    }
  }

  /** Remove the view from the window and release its web contents. */
  destroy(parent: BrowserWindow): void {
    const view = this.view
    if (!view) return

    this.view = null
    if (!parent.isDestroyed()) parent.contentView.removeChildView(view)
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }

  /**
   * Parse a console line emitted by the injected script.
   *
   * The count is accumulated HERE rather than taken from the page, because the
   * page's own counter resets on every full reload.
   */
  private handlePageReport(message: string): void {
    if (typeof message !== 'string' || !message.startsWith(INTERCEPTOR_LOG_TAG)) return

    let payload: InterceptorPageEvent
    try {
      payload = JSON.parse(message.slice(INTERCEPTOR_LOG_TAG.length)) as InterceptorPageEvent
    } catch {
      return
    }

    switch (payload.event) {
      case 'installed':
      case 'configured':
        this.interceptor.installed = true
        break
      case 'injected':
        this.interceptor.injectedCount += 1
        break
      case 'sent':
        this.interceptor.lastSentText = payload.text ?? null
        this.interceptor.taskStartedAt = Date.now()
        this.interceptor.taskFinishedAt = null
        break
      case 'task-finished':
        if (this.interceptor.taskStartedAt !== null && this.interceptor.taskFinishedAt === null) {
          this.interceptor.taskFinishedAt = Date.now()
        }
        break
      case 'command':
        if (payload.messageId && typeof payload.command === 'string') {
          this.handlers.onCommand({
            messageId: payload.messageId,
            command: payload.command,
            description: payload.description ?? '',
            live: payload.live === true
          })
        }
        break
      case 'parse-failed':
        this.handlers.onParseFailed(payload.text ?? '')
        break
      case 'send-failed':
      case 'inject-failed':
        console.warn(`[embed] interceptor reported ${payload.event}`)
        break
      default:
        break
    }

    this.handlers.onInterceptor(this.getInterceptorStatus())
  }

  private liveContents(): Electron.WebContents | null {
    const view = this.view
    if (!view || view.webContents.isDestroyed()) return null
    return view.webContents
  }

  /**
   * Persist the conversation currently on screen, if the URL is one.
   * Deduped so the many navigation/title events do not cause repeated writes.
   */
  private captureCurrentConversation(): void {
    const contents = this.liveContents()
    if (!contents) return

    const url = contents.getURL()
    const id = conversationIdFromUrl(url)
    if (!id) return

    // "ChatGPT" is the shell's generic title, not a conversation name. Storing
    // it as blank lets the sidebar scrape fill in the real one later.
    const rawTitle = contents.getTitle()
    const title = rawTitle === 'ChatGPT' || rawTitle.startsWith('ChatGPT:') ? '' : rawTitle

    const key = `${id}\u0000${title}`
    if (key === this.lastCaptured) return
    this.lastCaptured = key

    this.handlers.onConversation({ id, url: `${CHATGPT_ORIGIN}/c/${id}`, title })
  }

  /**
   * Best-effort refresh of the stored list from the sidebar, so the panel fills
   * itself without the user pressing anything. Throttled: did-stop-loading can
   * fire repeatedly during ChatGPT's client-side routing.
   */
  private autoSync(): void {
    const now = Date.now()
    if (now - this.lastSyncAt < 15000) return
    this.lastSyncAt = now

    void this.scrapeConversations().then((conversations) => {
      if (conversations.length > 0) this.handlers.onSynced(conversations)
    })
  }

  private applyBounds(): void {
    const view = this.view
    if (!view || view.webContents.isDestroyed()) return

    const { x, y, width, height } = this.bounds
    // A zero-sized or hidden slot must not keep a native rectangle on screen.
    if (!this.visible || width < 1 || height < 1) {
      view.setVisible(false)
      return
    }

    view.setVisible(true)
    view.setBounds({
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height)
    })
  }

  private publishState(): void {
    if (!this.liveContents()) return
    this.handlers.onState(this.getState())
  }
}
