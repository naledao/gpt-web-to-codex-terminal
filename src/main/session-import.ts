import { session } from 'electron'
import { EMBED_PARTITION, SESSION_COOKIE_NAME } from '../shared/types'
import type { EmbedAuthState, SessionImportDraft, SessionImportResult } from '../shared/types'

/**
 * Moving a browser's ChatGPT login into the embedded partition.
 *
 * WHY THIS EXISTS
 * ---------------
 * Some accounts have no sign-in route that works inside an embedded browser: an
 * account created with Google has no password, and asking for a sign-in link by
 * email makes OpenAI redirect straight back to Google
 * (`/api/accounts/authorize/continue` -> `accounts.google.com/o/oauth2/v2/auth`,
 * observed), which Google then refuses with `/v3/signin/rejected` on a non-browser
 * client. The system browser cannot close the loop either — its cookies live in a
 * different jar.
 *
 * What DOES move is the session token itself. It is a bearer credential: whoever
 * presents it over HTTPS on the right domain is signed in. So the user copies it out
 * of their browser once and this module writes it into `persist:chatgpt`.
 *
 * WHY THE USER MUST COPY IT BY HAND
 * ---------------------------------
 * Chrome and Edge both seal their cookie database with App-Bound Encryption, whose
 * key is bound to the browser's own process. Nothing outside that process can
 * decrypt it — by design. So there is no "read it automatically" version of this
 * feature, and any code claiming otherwise is lying.
 *
 * WHAT IS DELIBERATELY NOT DONE HERE
 * ----------------------------------
 * The value is never logged, never written to disk, and never echoed back to the
 * renderer. It arrives as an argument, is written to the cookie jar, and is gone
 * when the call returns.
 */

/**
 * Host the cookie is written for. The leading dot covers the `www` subdomain too.
 *
 * NOTE: a `__Host-` cookie must NOT carry a Domain attribute — that prefix means
 * "this exact host, no subdomains" and Chromium rejects the write outright if one is
 * supplied. `cookieAttributes()` is what keeps that straight.
 */
const COOKIE_HOST = 'https://chatgpt.com/'
const COOKIE_DOMAIN = '.chatgpt.com'

/**
 * A session token is a JWT-ish blob; anything wildly outside this is a paste error.
 *
 * Two limits on purpose. A SINGLE cookie cannot exceed ~4 KB — that is the browser
 * limit that forces NextAuth to split in the first place, so a longer "single" value
 * means the paste grabbed something else. The ASSEMBLED token is allowed more room,
 * because that is exactly what a split token is.
 */
const MIN_TOKEN_LENGTH = 40
const MAX_COOKIE_LENGTH = 4096
const MAX_ASSEMBLED_LENGTH = 16384

/**
 * Names a session token may travel under.
 *
 * NextAuth (and its successor Auth.js) key the cookie name to whether the site runs
 * over https, which is why the `__Secure-` / `__Host-` forms are the ones to expect.
 */
const SESSION_COOKIE_NAMES = [
  SESSION_COOKIE_NAME,
  '__Secure-authjs.session-token',
  '__Host-authjs.session-token',
  '__Host-next-auth.session-token',
  'next-auth.session-token',
  'authjs.session-token'
]

/**
 * `__Secure-next-auth.session-token.0` -> `{ base: '__Secure-next-auth.session-token',
 * chunk: 0 }`.
 *
 * NextAuth splits a session cookie that exceeds the ~4 KB browser cap into numbered
 * chunks. The split is a byte-wise slice of ONE string with no re-encoding, so
 * concatenating the chunks in numeric order reconstructs the original token — which is
 * what `parsePastedCookie` does.
 */
const CHUNK_SUFFIX_RE = /^(.*?)\.(\d+)$/

function isSessionCookieName(name: string): boolean {
  return SESSION_COOKIE_NAMES.includes(name) || SESSION_COOKIE_NAMES.includes(name.replace(CHUNK_SUFFIX_RE, '$1'))
}

/**
 * Runs in the embedded page and answers one question: does this look signed in?
 *
 * Structural, NOT textual. The page always contains the words "Log in" somewhere,
 * and a logged-out page can still render the word "ChatGPT" — so text matching
 * reports exactly the wrong answer. What differs is the chrome: the signed-in app
 * has a composer to type into and a conversation sidebar; the landing page has a
 * "log in" / "sign up" call to action instead.
 */
const SIGNED_IN_PROBE = `(() => {
  const composer = document.querySelector(
    '#prompt-textarea, div[contenteditable="true"], textarea[data-id], form textarea'
  )
  const sidebar = document.querySelector(
    'nav[aria-label], [data-testid="sidebar"], a[data-sidebar-item="true"], a[href^="/c/"]'
  )
  const account = document.querySelector(
    '[data-testid="profile-button"], [aria-label*="account" i], [aria-label*="账户"], [aria-label*="帳戶"]'
  )
  const loginCta = [...document.querySelectorAll('a, button')].some((el) =>
    /^(log ?in|sign ?up|登录|注册|免费注册|立即开始)$/i.test((el.innerText || '').trim())
  )

  return Boolean(composer) && Boolean(sidebar || account) && !loginCta
})()`

/**
 * Normalize a cookie name, tolerating whatever the renderer actually sent.
 *
 * Typed `unknown` on purpose: this is a process boundary, so the declared type is a
 * promise the wire does not have to keep. Anything that is not a string is refused
 * rather than coerced.
 */
function sanitizeName(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  // Cookie names are tokens; refuse anything that could smuggle an attribute in.
  return raw.trim().replace(/[^A-Za-z0-9._-]/g, '')
}

function stripWrappingQuotes(text: string): string {
  const first = text[0]
  const last = text[text.length - 1]
  if (text.length >= 2 && (first === '"' || first === "'") && last === first) {
    return text.slice(1, -1)
  }
  return text
}

/** One cookie lifted out of whatever the user pasted. */
export interface ParsedCookie {
  name: string
  value: string
}

/**
 * Read a pasted cookie header OR a lone value.
 *
 * `s` is the length of a COOKIE HEADER, not of a cookie — a single one can legitimately
 * be ~4 KB, and a split token arrives as two of those. So the "is this a lone value"
 * decision is made from the SHAPE of the first token, never from the total size.
 */
export function parseCookiePairs(raw: string): ParsedCookie[] {
  const pairs: ParsedCookie[] = []

  for (const part of raw.split(/[;\n\r]+/)) {
    const trimmed = part.trim()
    if (trimmed === '') continue

    const eq = trimmed.indexOf('=')
    if (eq <= 0) {
      // No name at all: the caller's name field decides. Note that a bare base64/JWE
      // token contains no `=` except padding, which never appears this early.
      if (pairs.length === 0 && raw.trim() === trimmed) pairs.push({ name: '', value: trimmed })
      continue
    }

    const name = sanitizeName(trimmed.slice(0, eq))
    const value = stripWrappingQuotes(trimmed.slice(eq + 1).trim())
    if (name === '' || value === '') continue
    pairs.push({ name, value })
  }

  return pairs
}

/** What was pasted, assembled into something writable. */
interface AssembledSession {
  /** Cookie name to write. A lone value takes the caller's requested name. */
  name: string
  /** Final value: chunks joined in numeric order, or a single cookie's value. */
  value: string
  /** Names actually recognised in the paste. Used verbatim in messages. */
  names: string[]
}

/**
 * Assemble what was pasted into something writable.
 *
 * Exported for tests: it is the one piece of this module that is pure logic, and the
 * chunk-joining rule (and the "you only pasted half of it" message) is exactly what a
 * quiet failure would look like from the user's side.
 */
export function assembleSession(
  draft: SessionImportDraft,
  requestedName: string
): { assembled: AssembledSession } | { error: string } {
  const raw = typeof draft.value === 'string' ? draft.value.trim() : ''
  if (raw === '') return { error: '没有内容可导入：cookie 值是空的。' }

  const pairs = parseCookiePairs(raw)
  if (pairs.length === 0) {
    return { error: '这段内容里没有解析出任何 cookie。请把整行 cookie 原样粘进来。' }
  }

  // Several distinct cookies pasted together: take the session token and leave the
  // rest alone. This is the common case, because copying the whole `cookie:` request
  // header is far easier than picking one row out of DevTools.
  const sessionPairs = pairs.filter((pair) => pair.name !== '' && isSessionCookieName(pair.name))
  const wanted = sessionPairs.length > 0 ? sessionPairs : pairs
  const names = [...new Set(wanted.map((pair) => pair.name).filter((name) => name !== ''))]

  // A lone value: the caller's name field wins.
  const named = wanted.filter((pair) => pair.name !== '')
  if (named.length === 0) {
    const value = wanted.length === 1 ? wanted[0].value : ''
    if (value.length < MIN_TOKEN_LENGTH) {
      return {
        error: `这段值只有 ${value.length} 个字符，会话令牌通常长得多。多半是复制到了名字或半截内容。`
      }
    }
    if (value.length > MAX_ASSEMBLED_LENGTH) {
      return { error: `这段值有 ${value.length} 个字符，远超单个 cookie 的上限，可能把整行都当成值了。` }
    }
    return { assembled: { name: requestedName, value, names: [] } }
  }

  /*
   * Compare CHUNK-STRIPPED names, not raw ones.
   *
   * A split token arrives as `<name>.0` and `<name>.1`; comparing raw names reads those
   * as two different cookies and rejects the very paste this feature exists to accept —
   * which is exactly what the first version of this code did.
   */
  const distinctNames = [
    ...new Set(named.map((pair) => pair.name.replace(CHUNK_SUFFIX_RE, '$1')))
  ]
  if (distinctNames.length > 1) {
    return {
      error:
        `这段内容包含多个不同的 cookie：${distinctNames.join('、')}。` +
        '请只粘贴会话令牌那一行（名字里带 session-token 的那个）。'
    }
  }

  const base = distinctNames[0]
  const chunks = named
    .map((pair) => {
      const match = CHUNK_SUFFIX_RE.exec(pair.name)
      return match ? { index: Number(match[2]), value: pair.value, name: pair.name } : null
    })
    .filter((entry): entry is { index: number; value: string; name: string } => entry !== null)

  if (chunks.length === 0) {
    const value = named[0].value
    if (value.length < MIN_TOKEN_LENGTH) {
      return { error: `${base} 的值只有 ${value.length} 个字符，看起来不完整。` }
    }
    if (value.length > MAX_COOKIE_LENGTH) {
      return {
        error:
          `${base} 的值有 ${value.length} 个字符，超过单个 cookie 的上限（约 4 KB）。` +
          '它很可能是被分块的 —— 请把 .0 / .1 那几行一起粘进来。'
      }
    }
    return { assembled: { name: base, value, names } }
  }

  // A chunked name mixed with a non-chunked one would have been caught above; this
  // guards the remaining case of chunks that do not all belong to one base name.
  const stray = chunks.filter((chunk) => !chunk.name.startsWith(`${base}.`))
  if (stray.length > 0 || chunks.length !== named.length) {
    return {
      error:
        `分块的名字对不上：${named.map((pair) => pair.name).join('、')}。` +
        '请把同一个会话令牌的所有分块一起粘进来。'
    }
  }

  // Split token: every chunk after the first must be present, or the halves do not
  // join back into the token the server can decrypt.
  const sorted = [...chunks].sort((a, b) => a.index - b.index)
  const missing: number[] = []
  for (let i = 0; i < sorted.length; i += 1) {
    if (sorted[i].index !== i) missing.push(i)
  }

  const joined = sorted.map((chunk) => chunk.value).join('')

  if (missing.length > 0) {
    return {
      error:
        `这个会话令牌被分成了 ${sorted.length + missing.length} 块，但只粘进来了 ` +
        `${sorted.map((chunk) => chunk.name).join('、')}；` +
        `缺少 ${missing.map((index) => `${base}.${index}`).join('、')}。` +
        '请把同一行的所有分块一起粘进来（浏览器 Cookie 列表里 .0 和 .1 是相邻的两行）。'
    }
  }

  /*
   * A lone `.0` is ambiguous — NextAuth only splits when it must, so one chunk can be a
   * complete token — but the browser's ~4 KB cookie cap settles it: a value that size
   * could not have been sent as a single cookie, so the rest is missing from the paste.
   *
   * Anything smaller is attempted as-is. Guessing "incomplete" there would block a
   * legitimate paste, and a wrong token fails safely anyway: the page simply stays
   * signed out and the user is told so.
   */
  if (sorted.length === 1 && sorted[0].index === 0 && joined.length > MAX_COOKIE_LENGTH) {
    return {
      error:
        `只粘进来了 ${base}.0（${joined.length} 个字符，超过单个 cookie 的上限），` +
        `看起来还有 ${base}.1 没有粘。请把分块一起复制过来。`
    }
  }

  if (joined.length > MAX_ASSEMBLED_LENGTH) {
    return { error: `拼接后有 ${joined.length} 个字符，太长了，不像是会话令牌。` }
  }

  return { assembled: { name: base, value: joined, names } }
}

/**
 * Cookie attributes for a name.
 *
 * `__Host-` cookies must not carry a Domain: the prefix means "this exact host, no
 * subdomains", and Chromium refuses the write if one is present. A bare `.chatgpt.com`
 * domain is used for everything else so the cookie also covers `www`.
 */
function cookieAttributes(name: string): Electron.CookiesSetDetails {
  return {
    url: COOKIE_HOST,
    name,
    path: '/',
    // `__Secure-` / `__Host-` names are only accepted with this flag set.
    secure: true,
    httpOnly: true,
    // A session cookie, matching how ChatGPT hands it out: it dies with the browser
    // rather than pretending to have an expiry we do not know.
    expirationDate: undefined,
    ...(name.startsWith('__Host-') ? {} : { domain: COOKIE_DOMAIN })
  }
}

/**
 * True when the embed looks signed in.
 *
 * Never throws: a navigation during the call is normal, and "cannot tell" must not
 * be reported as "signed in".
 */
export async function isEmbedSignedIn(
  contents: Electron.WebContents | null,
  timeoutMs = 20000
): Promise<boolean> {
  if (!contents || contents.isDestroyed()) return false

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const url = contents.getURL()
    // Only the app itself can answer this; on a Google or auth page the question is
    // meaningless.
    if (/^https:\/\/chatgpt\.com\//.test(url) && !/\/auth\//.test(url)) {
      try {
        if (await contents.executeJavaScript(SIGNED_IN_PROBE)) return true
      } catch {
        // Mid-navigation: try again until the deadline.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return false
}

/** Cookie names held for OpenAI properties. Names only — never values. */
export async function embedAuthState(
  contents: Electron.WebContents | null
): Promise<EmbedAuthState> {
  const cookies = await session.fromPartition(EMBED_PARTITION).cookies.get({})
  const names = [
    ...new Set(
      cookies
        // `domain` is optional in Electron's typings; a cookie without one is not
        // ours to report.
        .filter((cookie) => /chatgpt\.com$|openai\.com$/.test(cookie.domain ?? ''))
        .map((cookie) => `${cookie.domain ?? '?'} ${cookie.name}`)
    )
  ]
  return { signedIn: await isEmbedSignedIn(contents, 5000), cookieNames: names.sort() }
}

/**
 * Write the pasted token into the embed's jar, reload, and report what happened.
 *
 * `reloadAndWait` is injected rather than reached for here so this module never has
 * to know how the view is built.
 */
export async function importSessionToken(
  draft: SessionImportDraft,
  contents: Electron.WebContents | null,
  reloadAndWait: () => Promise<void>
): Promise<SessionImportResult> {
  const requestedName = sanitizeName(draft.name) || SESSION_COOKIE_NAME

  const parsed = assembleSession(draft, requestedName)
  if ('error' in parsed) {
    return { ok: false, message: parsed.error, signedIn: false }
  }

  const { name, value, names } = parsed.assembled
  // Say which name was used. When the user pasted the whole cookie header, the field
  // above is not what decided it, so staying silent would make the result unreadable.
  const usedNote = names.length > 0 ? `${name}（粘贴内容里识别到：${names.join('、')}）` : name

  if (!isSessionCookieName(name)) {
    // Not fatal — ChatGPT has renamed this cookie before — but say so, because a
    // plausible-but-wrong name is the most likely way this quietly fails.
    console.warn(`[session] importing a non-standard cookie name: ${name}`)
  }

  const ses = session.fromPartition(EMBED_PARTITION)
  try {
    await ses.cookies.set({ ...cookieAttributes(name), value })
  } catch (error) {
    return {
      ok: false,
      message: `写入 cookie 失败（名称 ${usedNote}）：${(error as Error).message}`,
      signedIn: false
    }
  }

  await reloadAndWait()

  const signedIn = await isEmbedSignedIn(contents, 25000)
  if (signedIn) {
    return {
      ok: true,
      message: `已导入 ${usedNote}，页面已进入登录状态。`,
      signedIn
    }
  }

  return {
    ok: true,
    message:
      `cookie 已写入（名称 ${usedNote}，共 ${value.length} 个字符），但页面看起来仍未登录。` +
      '常见原因：令牌已过期（在别处点了「登出所有设备」也会让它立刻失效）、复制的不完整，' +
      '或者账号还需要别的前缀 cookie。回浏览器刷新一次 ChatGPT 页面再复制一份通常能解决。',
    signedIn
  }
}
