import { BrowserWindow, WebContentsView, shell } from 'electron'
import type {
  AppTheme,
  EmbedBounds,
  EmbedCommand,
  NacosViewState
} from '../shared/types'

/**
 * Hosts the user's own Nacos console in a native `WebContentsView` layered on top of the
 * React renderer.
 *
 * WHY A NATIVE VIEW rather than an `<iframe>`: the Nacos console is a normal web app that
 * sends `X-Frame-Options`/CSP headers refusing to be framed, so it can only be embedded
 * out-of-process. This is the same reason the chat page uses one; the mechanism is shared,
 * the purpose is not.
 *
 * WHY THIS IS SO MUCH SIMPLER THAN THE CHAT EMBED. Nothing here scrapes, intercepts or
 * drives the page. The user asked for "my Nacos console, inside the app" — the address is
 * their own server, the UI is the server's, and the app contributes nothing but a window
 * to put it in. So there is no injected script, no conversation tracking and no bot-check
 * detection: only the address bar's state and a loading indicator.
 *
 * IMPORTANT: like every native view this paints ABOVE the renderer, so the renderer must
 * keep the measured slot clear and hide the view when a dialog covers it.
 */

/** What the view reports back to the window that owns it. */
interface NacosViewHandlers {
  onState(state: NacosViewState): void
}

/**
 * Accept a bare host as well as a full URL.
 *
 * A Nacos address is typed from memory — "192.168.1.9:8848" or "nacos.corp.com/nacos" — and
 * refusing it because it lacks a scheme would be pedantry, not safety. `http://` is the
 * default because a local Nacos almost never has a certificate; an explicit `https://` is
 * kept as typed.
 */
export function normalizeNacosUrl(input: string): string | null {
  const trimmed = input.trim()
  if (trimmed === '') return null

  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`

  try {
    const parsed = new URL(withScheme)
    // Only the two web schemes: `file://` would turn an address bar into a disk reader.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    if (parsed.hostname === '') return null
    return parsed.toString()
  } catch {
    return null
  }
}

export class NacosView {
  private view: WebContentsView | null = null
  private bounds: EmbedBounds = { x: 0, y: 0, width: 0, height: 0 }
  private visible = false
  private theme: AppTheme = 'light'
  private url = ''
  private title = ''
  private loading = false
  private error = ''

  constructor(private readonly handlers: NacosViewHandlers) {}

  /** Create the view and add it to the window. Safe to call more than once. */
  attach(parent: BrowserWindow): void {
    if (this.view && !this.view.webContents.isDestroyed()) return

    const view = new WebContentsView({
      webPreferences: {
        // The console runs in its own cookie jar so its login never mixes with the
        // app's own session, or with the chat embed's.
        partition: 'persist:nacos-console',
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        spellcheck: false
      }
    })

    this.view = view
    view.setBackgroundColor(this.theme === 'dark' ? '#141922' : '#ffffff')
    parent.contentView.addChildView(view)

    const contents = view.webContents

    // A console link that opens a new window (a doc link, a log download) belongs in the
    // real browser, not in a second unmanaged view.
    contents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url).catch(() => undefined)
      return { action: 'deny' }
    })

    contents.on('did-start-loading', () => {
      this.loading = true
      this.error = ''
      this.publish()
    })

    contents.on('did-stop-loading', () => {
      this.loading = false
      this.publish()
    })

    contents.on('did-navigate', (_event, url) => {
      this.url = url
      this.publish()
    })

    contents.on('did-navigate-in-page', (_event, url) => {
      this.url = url
      this.publish()
    })

    contents.on('page-title-updated', (_event, title) => {
      this.title = title
      this.publish()
    })

    /**
     * Name the failure instead of leaving a blank white rectangle.
     *
     * A wrong port or an unreachable host is the most likely outcome of typing an address
     * from memory, and Chromium's own error page is thin on detail — reporting
     * `did-fail-load` here is what lets the panel say *why* it is empty.
     */
    contents.on('did-fail-load', (_event, code, description, validatedUrl, isMainFrame) => {
      if (!isMainFrame) return
      // -3 is ABORTED, which Chromium emits for every superseded navigation; not an error.
      if (code === -3) return
      this.loading = false
      this.error = description === '' ? `加载失败（${code}）` : `${description}（${code}）`
      if (validatedUrl !== '') this.url = validatedUrl
      this.publish()
    })

    this.applyBounds()
  }

  /** Point the view at a URL, creating the page on first use. */
  async open(parent: BrowserWindow, rawUrl: string): Promise<void> {
    const url = normalizeNacosUrl(rawUrl)
    if (url === null) {
      this.error = '请输入有效的 Nacos 地址，例如 http://127.0.0.1:8848/nacos'
      this.publish()
      return
    }

    this.attach(parent)
    const view = this.view
    if (!view || view.webContents.isDestroyed()) return

    this.url = url
    this.error = ''
    this.loading = true
    this.publish()
    await view.webContents.loadURL(url)
  }

  setBounds(bounds: EmbedBounds): void {
    this.bounds = bounds
    this.applyBounds()
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    this.applyBounds()
  }

  setTheme(theme: AppTheme): void {
    this.theme = theme
    const view = this.view
    if (view && !view.webContents.isDestroyed()) {
      view.setBackgroundColor(theme === 'dark' ? '#141922' : '#ffffff')
    }
  }

  command(command: EmbedCommand): void {
    const contents = this.liveContents()
    if (!contents) return

    if (command === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack()
    else if (command === 'forward' && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward()
    else if (command === 'reload') contents.reload()
    else if (command === 'stop') contents.stop()
    else if (command === 'home' && this.url !== '') void contents.loadURL(this.url)
  }

  getState(): NacosViewState {
    const contents = this.liveContents()
    return {
      active: this.view !== null,
      url: this.url,
      title: this.title,
      isLoading: this.loading,
      canGoBack: contents ? contents.navigationHistory.canGoBack() : false,
      canGoForward: contents ? contents.navigationHistory.canGoForward() : false,
      error: this.error
    }
  }

  /** Take the view down and forget where it was pointed. */
  destroy(parent: BrowserWindow): void {
    const view = this.view
    if (!view) return

    this.view = null
    this.visible = false
    if (!parent.isDestroyed()) parent.contentView.removeChildView(view)
    if (!view.webContents.isDestroyed()) view.webContents.close()

    this.url = ''
    this.title = ''
    this.loading = false
    this.error = ''
  }

  private liveContents(): Electron.WebContents | null {
    const view = this.view
    if (!view || view.webContents.isDestroyed()) return null
    return view.webContents
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

  private publish(): void {
    this.handlers.onState(this.getState())
  }
}