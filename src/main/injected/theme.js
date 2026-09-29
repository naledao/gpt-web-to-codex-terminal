/*
 * Theme sync for the embedded chat page.
 *
 * Injected into the page's MAIN WORLD by src/main/embed.ts, the same way
 * send-interceptor.js is. Plain browser JavaScript on purpose: it does not run in the
 * app's process, has no access to `window.api`, and must not be type-checked against the
 * Node/Electron libs. It is bundled as a string via Vite's `?raw` import.
 *
 * THE PROBLEM IT SOLVES
 * ---------------------
 * The app has ONE theme setting, and the page inside it is a third-party site with a theme
 * of its own. Two mechanisms carry the setting across, and they cover different moments:
 *
 *   1. `nativeTheme.themeSource`, set in the main process. It makes this renderer answer
 *      `prefers-color-scheme` with whatever the app is set to. Measured on DeepSeek: the
 *      page receives it, but only READS it when it boots — so this is what makes a page that
 *      loads from now on come up in the app's theme.
 *   2. THIS SCRIPT. For the page that is ALREADY open when the user flips the app's theme,
 *      and for a site whose appearance is pinned to an explicit value. It replays the DOM
 *      state the site's own theme switch produces.
 *
 * WHAT IT APPLIES, AND WHY THAT IS NOT A GUESS
 * --------------------------------------------
 * The mutations come from the platform's descriptor, and every one of them was READ OFF THE
 * LIVE PAGE by a probe (`tools/diag/deepseek-theme-probe.js`) while the user switched the
 * site's own theme. Nothing here tries a convention to see whether it sticks: a hook that
 * matches nothing changes nothing, silently, and the page then looks exactly like a page
 * whose theme sync was never built.
 *
 * They are applied as ONE SET. DeepSeek's dark mode is three coordinated changes (body gains
 * `dark`, loses `light`, gains `data-ds-dark-theme`), and applying them one at a time until
 * something appeared to work would leave the document in a state the site never produces.
 *
 * WHAT IT VERIFIES
 * ----------------
 * Measured after the fact anyway, because a probe can be right on the day it was written and
 * wrong six months later: if the page did not actually move to the wanted scheme, the whole
 * set is reverted and the log says so (`applied=none`). That report is the only signal this
 * app has that the page is themed at all — nothing else reads a colour or a class, so a page
 * that ignored the theme and a page that followed it are identical everywhere else.
 *
 * WHAT IT REFUSES TO DO
 * ---------------------
 * It touches nothing outside the declared mutations and declared storage keys, and it does
 * nothing at all when it cannot tell what the page currently looks like — guessing in that
 * state is how a half-restyled page happens, which is worse than a light one.
 */
;(() => {
  const STATE_KEY = '__cmdTerminalTheme'
  const LOG_TAG = '[cmd-terminal] '

  /*
   * Re-injection must not stack a second observer.
   *
   * This source is executed on every page load AND on every theme change, but it returns
   * early once installed; the injection always calls `configure()` afterwards, which is what
   * pushes the new value into the instance that is already there.
   */
  if (window[STATE_KEY]) return

  /** How long the page is given to react to the mutations before its colours are read. */
  const SETTLE_MS = 200
  /**
   * Reading the page's colours fails while it is still painting, and on a cold load that can
   * last a while. Retried a few times, then abandoned — a page we cannot read is a page we
   * do not touch.
   */
  const MAX_RETRIES = 5
  const RETRY_MS = 1200
  /** Put an applied set back this many times before calling the page contested. */
  const MAX_REASSERTS = 8

  const state = {
    desired: 'light',
    /** The document state the site's own dark mode puts it in. Empty means "do not touch". */
    dark: [],
    /** …and its light mode. */
    light: [],
    /** localStorage entries the platform declares. Written only when declared. */
    storage: [],
    /** The set currently applied, so a page that strips it can be put back. */
    applied: null,
    observer: null,
    retries: 0,
    reasserts: 0,
    contestedReported: false,
    lastResult: 'init'
  }

  const report = (payload) => {
    try {
      console.log(LOG_TAG + JSON.stringify(payload))
    } catch (_) {
      /* never break the page because reporting failed */
    }
  }

  const nextFrame = () =>
    new Promise((resolve) => {
      requestAnimationFrame(() => setTimeout(resolve, SETTLE_MS))
    })

  const isMutation = (value) =>
    Boolean(value) &&
    typeof value === 'object' &&
    (value.target === 'html' || value.target === 'body') &&
    (value.kind === 'class' || value.kind === 'attr') &&
    typeof value.name === 'string' &&
    value.name !== ''

  const isStorageRule = (value) =>
    Boolean(value) &&
    typeof value === 'object' &&
    typeof value.key === 'string' &&
    value.key !== '' &&
    typeof value.dark === 'string' &&
    typeof value.light === 'string'

  const targetOf = (mutation) => (mutation.target === 'body' ? document.body : document.documentElement)

  /** How one mutation is named in the log, so a report can be read without the descriptor. */
  const idOf = (mutation) => {
    if (mutation.kind === 'class') {
      return mutation.target + '/class:' + mutation.name + '=' + (mutation.present === true)
    }
    return mutation.target + '/attr:' + mutation.name + '=' + JSON.stringify(String(mutation.value || ''))
  }

  const setOf = (theme) => (theme === 'dark' ? state.dark : state.light)

  const TRANSPARENT = ['', 'transparent', 'rgba(0, 0, 0, 0)']

  /**
   * An opaque colour from a computed style value, or null.
   *
   * `rgba(0, 0, 0, 0)` is what a computed background is when nothing set one, and a fully
   * transparent layer tells us nothing about how the page looks — which is why this returns
   * null rather than black. Reading it as black would make every transparent page look dark.
   */
  const toRgb = (value) => {
    const text = String(value || '').trim().toLowerCase()
    if (TRANSPARENT.indexOf(text) !== -1) return null

    const match = /^rgba?\(([^)]+)\)$/.exec(text)
    if (!match) return null

    const parts = match[1]
      .split(/[,\s/]+/)
      .filter((part) => part !== '')
      .map(Number)
    if (parts.length < 3 || parts.slice(0, 3).some((part) => !Number.isFinite(part))) return null
    if (parts.length > 3 && Number.isFinite(parts[3]) && parts[3] === 0) return null

    return parts.slice(0, 3)
  }

  const luminanceOf = (rgb) => (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255

  const labelOf = (node) => {
    const tag = String(node.tagName || '').toLowerCase()
    const id = node.id ? '#' + node.id : ''
    return tag + id
  }

  /*
   * What the page LOOKS like right now, and the measurement that decided it.
   *
   * Read from computed colours rather than from the hooks, because the hooks are precisely
   * what is being tested: a page is dark when it is painted dark, whatever its classes say.
   * `evidence` names the element and the value, so a surprising verdict in the log can be
   * argued with instead of believed.
   *
   * Body and html come first because they carry the page-level surface on every site this
   * app embeds; the SPA containers follow, for a page that paints its background deeper.
   */
  const readScheme = () => {
    const roots = []
    for (const selector of ['body', 'html', 'main', '[role="main"]', '#root', '#app']) {
      const found = document.querySelector(selector)
      if (found && roots.indexOf(found) === -1) roots.push(found)
    }

    for (const node of roots) {
      const raw = getComputedStyle(node).backgroundColor
      const rgb = toRgb(raw)
      if (!rgb) continue
      return {
        scheme: luminanceOf(rgb) < 0.45 ? 'dark' : 'light',
        evidence: labelOf(node) + ' background-color ' + String(raw)
      }
    }

    /*
     * No opaque layer anywhere. Text colour is the weaker signal but it is the only one
     * left: dark themes paint light text, light themes paint dark text.
     */
    for (const node of roots) {
      const raw = getComputedStyle(node).color
      const rgb = toRgb(raw)
      if (!rgb) continue
      return {
        scheme: luminanceOf(rgb) > 0.55 ? 'dark' : 'light',
        evidence: labelOf(node) + ' color ' + String(raw)
      }
    }

    return { scheme: 'unknown', evidence: 'no opaque background or text colour found' }
  }

  const writeMutation = (mutation) => {
    const el = targetOf(mutation)
    if (!el) return

    if (mutation.kind === 'class') {
      el.classList.toggle(mutation.name, mutation.present === true)
      return
    }

    const value = String(mutation.value || '')
    if (value === '') el.removeAttribute(mutation.name)
    else el.setAttribute(mutation.name, value)
  }

  /** Whether every mutation of a set is currently in place. */
  const holdsSet = (list) =>
    list.every((mutation) => {
      const el = targetOf(mutation)
      if (!el) return true

      if (mutation.kind === 'class') {
        return el.classList.contains(mutation.name) === (mutation.present === true)
      }
      return String(el.getAttribute(mutation.name) || '') === String(mutation.value || '')
    })

  /** Everything needed to undo a set: what each target looked like before it was applied. */
  const snapshotSet = (list) =>
    list.map((mutation) => {
      const el = targetOf(mutation)
      if (!el) return null
      return mutation.kind === 'class'
        ? { isClass: true, present: el.classList.contains(mutation.name) }
        : { isClass: false, value: el.getAttribute(mutation.name) }
    })

  const restoreSet = (list, snapshots) => {
    list.forEach((mutation, index) => {
      const snapshot = snapshots[index]
      const el = targetOf(mutation)
      if (!el || !snapshot) return

      if (snapshot.isClass) {
        el.classList.toggle(mutation.name, snapshot.present === true)
        return
      }
      if (snapshot.value === null || snapshot.value === undefined) el.removeAttribute(mutation.name)
      else el.setAttribute(mutation.name, snapshot.value)
    })
  }

  /**
   * Put an applied set back when the page strips it.
   *
   * A site that owns its own theme re-renders from its own state, and that state still says
   * light because the site never agreed to anything — so the set survives exactly until the
   * next render. This is bounded on purpose: a page that keeps removing it is reported as
   * contested and then left alone, because a fight with the page is not a fix.
   */
  const watch = () => {
    const applied = state.applied
    if (state.observer || !applied) return

    const nodes = []
    const filter = ['class']
    for (const mutation of applied.mutations) {
      const el = targetOf(mutation)
      if (el && nodes.indexOf(el) === -1) nodes.push(el)
      if (mutation.kind === 'attr' && filter.indexOf(mutation.name) === -1) filter.push(mutation.name)
    }
    if (nodes.length === 0) return

    state.observer = new MutationObserver(() => {
      const current = state.applied
      if (!current) return
      if (holdsSet(current.mutations)) return

      if (state.reasserts >= MAX_REASSERTS) {
        if (state.contestedReported) return
        state.contestedReported = true
        report({
          event: 'theme',
          want: state.desired,
          applied: 'contested',
          mutation: idOf(current.mutations[0]),
          reason: 'the page removed the applied state ' + state.reasserts + ' times'
        })
        return
      }

      state.reasserts += 1
      for (const mutation of current.mutations) writeMutation(mutation)
    })

    for (const node of nodes) {
      state.observer.observe(node, { attributes: true, attributeFilter: filter })
    }
  }

  /*
   * The theme-ish entries the SITE itself keeps.
   *
   * REPORTED, and written only when the platform declares them: a key that has not been
   * measured is a key this app has no business setting — and for DeepSeek the key IS measured
   * and still not written, because it is the site's own preference and changing it would
   * follow the user into their real browser. See `DEEPSEEK_THEME` in shared/platforms.ts.
   *
   * It stays in the report because it is what tells a reader which preference the site booted
   * from, which is the first question when the page comes up in the wrong theme.
   */
  const THEME_KEY = /theme|appearance|scheme|color-?mode|dark-?mode/i
  const THEME_VALUE = /^(dark|light|system|auto|night|day|dim|true|false)$/i

  const storageHints = () => {
    const hints = []
    /** Keys looked at before giving up. A page with hundreds must not cost a scan per load. */
    const MAX_SCAN = 200

    for (const name of ['localStorage', 'sessionStorage']) {
      try {
        const area = window[name]
        if (!area) continue

        const limit = Math.min(area.length, MAX_SCAN)
        for (let index = 0; index < limit && hints.length < 12; index += 1) {
          const key = area.key(index) || ''
          const value = String(area.getItem(key) || '')
          if (!THEME_KEY.test(key) && !THEME_VALUE.test(value.trim())) continue
          hints.push(name + ':' + key + '=' + value.slice(0, 48))
        }
      } catch (_) {
        /* a blocked or absent storage area is not worth reporting */
      }
    }

    return hints
  }

  /**
   * What this page believes the operating system's preference is.
   *
   * The other half of the sync, and the reason it is reported SEPARATELY from the measured
   * scheme: `nativeTheme.themeSource` in the main process is what is supposed to make this
   * answer the app's theme, so
   *
   *   query=dark page=light  -> the media query arrived and the page is not acting on it
   *                             (DeepSeek: it only reads it at boot)
   *   query=light want=dark  -> the media query itself never arrived, a different bug in a
   *                             different process
   *
   * Without it those two failures look identical from the outside.
   */
  const schemeQuery = () => {
    try {
      if (!window.matchMedia) return 'unknown'
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    } catch (_) {
      return 'unknown'
    }
  }

  /**
   * Declare which scheme this page is painted in.
   *
   * `color-scheme` is what makes the browser's own furniture follow — form controls,
   * scrollbars, the CSS system colours — on a page whose stylesheet may not set it. It is
   * only ever set once the page has been MEASURED to be in that scheme: it is a statement
   * about the page, and declaring `dark` over a page that stayed light would just put a dark
   * scrollbar on a white page.
   */
  const declareScheme = (want) => {
    try {
      document.documentElement.style.colorScheme = want
    } catch (_) {
      /* not fatal, and not worth a report */
    }
  }

  const writeDeclaredStorage = (dark) => {
    const written = []

    for (const rule of state.storage) {
      try {
        window.localStorage.setItem(rule.key, dark ? rule.dark : rule.light)
        written.push(rule.key)
      } catch (_) {
        /* storage can be blocked; the mutations may still work */
      }
    }

    return written
  }

  /** Everything the wanted theme implies, applied once. */
  const apply = async (reason) => {
    const want = state.desired
    const storageWritten = writeDeclaredStorage(want === 'dark')

    // A theme change makes whatever was applied for the previous one the wrong direction.
    if (state.applied && state.applied.theme !== want) {
      restoreSet(state.applied.mutations, state.applied.snapshots)
      state.applied = null
      if (state.observer) {
        state.observer.disconnect()
        state.observer = null
      }
      state.reasserts = 0
      state.contestedReported = false
    }

    const before = readScheme()

    /*
     * The page is already where it was asked to be.
     *
     * On DeepSeek this is what a FRESH LOAD looks like while the site's own preference is
     * "system": the page read `prefers-color-scheme` when it booted, the app had already set
     * it with `nativeTheme.themeSource`, and there is nothing left to do. The report says so
     * rather than staying silent — silence here is indistinguishable from the script never
     * having run, which is the exact ambiguity this file exists to remove.
     */
    if (before.scheme === want) {
      state.retries = 0
      state.lastResult = 'agrees'
      declareScheme(want)
      report({
        event: 'theme',
        want,
        page: before.scheme,
        applied: 'agrees',
        mutation: state.applied ? idOf(state.applied.mutations[0]) : null,
        evidence: before.evidence,
        query: schemeQuery(),
        storageKeys: storageWritten,
        hints: storageHints(),
        reason
      })
      return
    }

    if (before.scheme === 'unknown') {
      state.retries += 1
      const giveUp = state.retries > MAX_RETRIES
      state.lastResult = giveUp ? 'unknown-given-up' : 'unknown-retrying'
      report({
        event: 'theme',
        want,
        page: 'unknown',
        applied: 'unknown',
        evidence: before.evidence,
        query: schemeQuery(),
        retry: state.retries,
        reason
      })
      if (!giveUp) setTimeout(() => void schedule('retry'), RETRY_MS)
      return
    }

    state.retries = 0

    const mutations = setOf(want)

    /*
     * Nothing declared for this platform yet. Not a failure — it is the state of a page
     * whose theme rules have not been measured, and the report is what decides whether it
     * ever needs any: it names the scheme the page is in, the scheme the app asked for, and
     * the storage keys the site keeps its own preference under.
     */
    if (mutations.length === 0) {
      state.lastResult = 'none'
      report({
        event: 'theme',
        want,
        page: before.scheme,
        applied: 'none',
        mutation: null,
        declared: 0,
        evidence: before.evidence,
        query: schemeQuery(),
        storageKeys: storageWritten,
        hints: storageHints(),
        reason
      })
      return
    }

    const snapshots = snapshotSet(mutations)
    for (const mutation of mutations) writeMutation(mutation)
    await nextFrame()

    const after = readScheme()

    if (after.scheme !== want) {
      /*
       * The declared state did not move the page. Reverted on the spot: leaving a
       * half-applied theme on screen is worse than leaving the page alone, and a report that
       * says "applied" while the page is unchanged is worse than both.
       */
      restoreSet(mutations, snapshots)
      await nextFrame()
      state.lastResult = 'none'
      report({
        event: 'theme',
        want,
        page: before.scheme,
        applied: 'none',
        mutation: null,
        declared: mutations.length,
        tried: mutations.map(idOf),
        evidence: before.evidence + ' -> ' + after.evidence,
        query: schemeQuery(),
        storageKeys: storageWritten,
        hints: storageHints(),
        reason
      })
      return
    }

    state.applied = { theme: want, mutations, snapshots }
    watch()
    declareScheme(want)
    state.lastResult = 'moved'
    report({
      event: 'theme',
      want,
      page: before.scheme,
      applied: 'ok',
      mutation: idOf(mutations[0]),
      mutations: mutations.map(idOf),
      evidence: before.evidence + ' -> ' + after.evidence,
      query: schemeQuery(),
      storageKeys: storageWritten,
      hints: storageHints(),
      reason
    })
  }

  /*
   * Serialised, because a theme change can arrive while a measurement is still running — and
   * two of them interleaving would measure each other's mutations.
   */
  let queue = Promise.resolve()
  const schedule = (reason) => {
    queue = queue
      .then(() => apply(reason))
      .catch((error) => {
        state.lastResult = 'error'
        report({ event: 'theme', applied: 'error', reason: String((error && error.message) || error) })
      })
    return queue
  }

  /* ------------------------------------------------------------------ *
   * Public surface used by the main process
   * ------------------------------------------------------------------ */

  window[STATE_KEY] = {
    configure(config) {
      if (config && typeof config === 'object') {
        if (config.theme === 'dark' || config.theme === 'light') state.desired = config.theme
        if (Array.isArray(config.dark)) state.dark = config.dark.filter(isMutation)
        if (Array.isArray(config.light)) state.light = config.light.filter(isMutation)
        if (Array.isArray(config.storage)) state.storage = config.storage.filter(isStorageRule)
      }

      /*
       * A configure call is a FRESH instruction, so the unreadable-page budget restarts with
       * it. That budget exists to stop the self-scheduled retry chain from polling forever on
       * a page whose colours can never be read; it must not be spent by the page lifecycle —
       * `dom-ready` and `did-finish-load` both configure, and on a slow load they can easily
       * arrive while the page is still unpainted.
       */
      state.retries = 0
      void schedule('configure')

      return {
        desired: state.desired,
        dark: state.dark.length,
        light: state.light.length,
        lastResult: state.lastResult
      }
    },

    /** Re-run without changing anything; answers "is the page still themed?". */
    reapply() {
      void schedule('reapply')
    },

    status() {
      const now = readScheme()
      return {
        desired: state.desired,
        page: now.scheme,
        evidence: now.evidence,
        query: schemeQuery(),
        applied: state.applied ? state.applied.theme : null,
        appliedHolds: state.applied ? holdsSet(state.applied.mutations) : null,
        lastResult: state.lastResult,
        hints: storageHints()
      }
    }
  }

  void schedule('install')
})()
