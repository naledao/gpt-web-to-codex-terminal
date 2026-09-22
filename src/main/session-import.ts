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

/** Host the cookie is written for. The leading dot covers the `www` subdomain too. */
const COOKIE_HOST = 'https://chatgpt.com/'
const COOKIE_DOMAIN = '.chatgpt.com'

/** A session token is a JWT-ish blob; anything wildly outside this is a paste error. */
const MIN_TOKEN_LENGTH = 40
const MAX_TOKEN_LENGTH = 8192

/**
 * Names a session token may travel under.
 *
 * NextAuth (and its successor Auth.js) key the cookie name to whether the site runs
 * over https, which is why the `__Secure-` forms are the ones to expect here.
 */
const SESSION_COOKIE_NAMES = [
  SESSION_COOKIE_NAME,
  '__Secure-authjs.session-token',
  'next-auth.session-token',
  'authjs.session-token'
]

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
  const name = sanitizeName(draft.name) || SESSION_COOKIE_NAME
  const value = typeof draft.value === 'string' ? draft.value.trim() : ''

  if (value === '') {
    return { ok: false, message: '没有内容可导入：cookie 值是空的。', signedIn: false }
  }
  if (value.length < MIN_TOKEN_LENGTH) {
    return {
      ok: false,
      message: `这段值只有 ${value.length} 个字符，会话令牌通常长得多。多半是复制到了名字或半截内容。`,
      signedIn: false
    }
  }
  if (value.length > MAX_TOKEN_LENGTH) {
    return {
      ok: false,
      message: `这段值有 ${value.length} 个字符，太长，不像是单个 cookie。请只复制 cookie 的 Value 一列。`,
      signedIn: false
    }
  }
  if (!SESSION_COOKIE_NAMES.includes(name)) {
    // Not fatal — ChatGPT has renamed this cookie before — but say so, because a
    // plausible-but-wrong name is the most likely way this quietly fails.
    console.warn(`[session] importing a non-standard cookie name: ${name}`)
  }

  const ses = session.fromPartition(EMBED_PARTITION)
  try {
    await ses.cookies.set({
      url: COOKIE_HOST,
      name,
      value,
      domain: COOKIE_DOMAIN,
      path: '/',
      // `__Secure-` names are only accepted with this flag set.
      secure: true,
      httpOnly: true,
      // A session cookie, matching how ChatGPT hands it out: it dies with the
      // browser rather than pretending to have an expiry we do not know.
      expirationDate: undefined
    })
  } catch (error) {
    return {
      ok: false,
      message: `写入 cookie 失败：${(error as Error).message}`,
      signedIn: false
    }
  }

  await reloadAndWait()

  const signedIn = await isEmbedSignedIn(contents, 25000)
  if (signedIn) {
    return {
      ok: true,
      message: `已导入（cookie 名 ${name}），页面已进入登录状态。`,
      signedIn
    }
  }

  return {
    ok: true,
    message:
      `cookie 已写入（名称 ${name}），但页面看起来仍未登录。` +
      '常见原因：令牌已过期、复制的不完整，或者账号还需要别的前缀 cookie。' +
      '可以回浏览器刷新一次 ChatGPT 页面，重新复制一份再试。',
    signedIn
  }
}
