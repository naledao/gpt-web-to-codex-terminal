# tools/diag — user-driven diagnostics

Small, throwaway probes for problems that only reproduce against live third-party
pages inside the user's real session. Per `AGENTS.md`, **the user runs and drives
them; the agent reads the log file.**

## google-login-probe.js

**The question this run answers:** with the embedded identity patched on the wire
(User-Agent *and* the `Sec-CH-UA` client-hint brand list), does Google's OAuth flow
run to completion — or is it still cut off at `/signin/rejected`?

If it completes → the login window is buildable as a feature.
If it is still rejected → spoofing is a dead end and the app needs the
cookie-import route instead.

### What earlier runs established (do not re-litigate)

| Finding | Evidence |
| --- | --- |
| Google renders the sign-in form fine in the embedded view; the refusal lands **one step later**, when the flow is handed to OAuth | phase 1 of the previous run: `blocked=false` on the form page, then `/signin/rejected` |
| The UA string is **not** the tell: this Electron's stock UA carries no `Electron` token, and `setUserAgent` does reach the wire | verified with `onBeforeSendHeaders` |
| The visible tell is the client-hint brand list: the page reports `["Not?A_Brand","Chromium"]` with **no `"Google Chrome"`** | `SNAPSHOT brands=` / `uaData=` in the previous run |
| Electron 44 has no `setUserAgentMetadata`, so `Sec-CH-UA` can only be rewritten in `onBeforeSendHeaders` | `electron.d.ts` has no such symbol |
| A session has **one** `onBeforeSendHeaders` slot — a second registration replaces the first | observed directly |

### Run it (from the repo root, PowerShell)

```powershell
node_modules\electron\dist\electron.exe tools\diag\google-login-probe.js
```

A window titled **“Google 登录诊断”** opens on chatgpt.com.

1. Click **使用 Google 账号继续 / Continue with Google**.
2. **Drive it to the end**: enter the account, click 下一步, do the second factor if
   asked. Do not stop at the sign-in form — a form that renders proves nothing here.
3. Close the window. The verdict is written at that moment.

The probe uses the app's real `persist:chatgpt` partition, so if the login succeeds,
**the app itself ends up logged in**.

### Reading the log

| Line | Meaning |
| --- | --- |
| `STAGE -> …` | furthest point reached: `form` < `challenge` < `rejected` / `error-return` < `completed` |
| `FINAL STAGE:` + `VERDICT:` | the decision, written when the window closes |
| `HDR-IN` / `HDR-OUT` | the headers a Google request carried **before** and **after** the rewrite — proves the patch is live |
| `NET <status> …` | Google/OpenAI responses that are not plain 200s, and every XHR |
| `TICK(...) brands=` / `highEntropy=` | what the page believes about its own identity |
| `BEFORE/AFTER AUTH COOKIES` | `__Secure-next-auth.session-token` / `oai-sc`, **names and lengths only** |

Log file (newest = the run you just did):

```powershell
Get-ChildItem "$env:TEMP\gpt-login-diag" | Sort-Object LastWriteTime -Descending |
  Select-Object -First 3 Name,Length,LastWriteTime
```

### Rules

- It never types, never submits a form, never reads a credential, never uploads.
- Cookies are logged as `name(len=N)`; values are never written.
- The identity rewrite covers **Google-owned hosts only**, and only on that
  partition's session while the probe runs. The real app is untouched.
- Nothing here claims success from "the form appeared" — that is the mistake the
  second version of this probe made, and it cost a run.

### Overrides (environment variables)

| Variable | Effect |
| --- | --- |
| `PROBE_USER_DATA` | different userData dir (different partition jar) |
| `PROBE_LOG_DIR` | different log directory |
| `PROBE_PARTITION` | different session partition |

## email-login-probe.js

**The run that decides whether the email/OTP route works** — currently the only route
that can sign in inside the embedded view, since Google answers
`/v3/signin/rejected` no matter how the client presents itself.

It answers two open questions in one run:

1. `auth.openai.com/log-in` rendered the email form on one attempt and
   **“你的会话已结束”, with no form at all**, on a later one. Which one you get, and
   what the page says about itself, is logged.
2. Whether the steps **after** the email address stay inside the app's navigation
   allowlist. A hop that leaves it is logged `APP-WOULD-BLOCK` — in the real app that
   hop goes to the system browser and the flow dies there.

**Run (from the repo root, PowerShell):**

```powershell
node_modules\electron\dist\electron.exe tools\diag\email-login-probe.js
```

A window titled **“邮箱登录探针”** opens on the OpenAI sign-in page.

1. Type your own email and continue, then finish the code/password step if one appears.
2. **Leave the result on screen for ~15 seconds** so a snapshot lands.
3. Close the window — the verdict is written at that moment.

The probe uses the app's real `persist:chatgpt` partition, so a successful login also
logs the app in. Log: `%TEMP%\gpt-login-diag\email-login-<timestamp>.log`

### Reading the log

| Line | Meaning |
| --- | --- |
| `START/NAV/IN-PAGE APP-ALLOWS` | hop stays inside the embed allowlist |
| `START/NAV/IN-PAGE APP-WOULD-BLOCK` | **the real app would push this hop to the system browser** — flow dies here |
| `INITIAL` / `AFTER-NAV` / `TICK` | URL, title, which fields exist (`email=/code=/password=/phone=`), visible text |
| `sessionEnded=true` | the “你的会话已结束” dead end — a page state, not an allowlist problem |
| `cloudflare=true` | a Cloudflare interstitial, not a policy refusal |
| `WINDOW-OPEN REQUEST` | a popup was requested; denied and recorded, never launched |
| `BEFORE/AFTER COOKIES` | cookie **names and lengths only** |
| `VERDICT:` | the summary, written when the window closes |

The allowlist is duplicated in the probe on purpose, so it can judge hops the way the
real app would. **Keep it in sync** when `ALLOWED_NAVIGATION` changes.

## clear-embed-cookies.mjs

Signs the embedded view out by removing the ChatGPT/OpenAI **login** cookies from the
app's `persist:chatgpt` partition.

**Run (from the repo root, with the app fully closed):**

```powershell
node --experimental-sqlite tools\diag\clear-embed-cookies.mjs
```

```
[clear] removing 7 login cookie(s):
          .auth.openai.com  auth-session-minimized  (602 bytes)
          .chatgpt.com  __Secure-next-auth.session-token  (3919 bytes)
          ...
[clear] deleted rows: 7
[clear] remaining cookies for chatgpt/openai: 29
```

- **Why a script:** the jar is a SQLite file that the running app holds under an
  exclusive lock, and Electron's cookie API only works from inside the app. This edits
  the file directly — after writing a timestamped backup beside it.
- **What it removes:** the login/session families only (`__Secure-next-auth.*`,
  `auth-session-minimized*`, `oai-login-csrf*`, `oai-sc`, a bare `session`, …).
- **What it keeps on purpose:** `cf_clearance`, `__cf_bm`, `__cflb`, `_cfuvid` and
  `oai-did`. Those are bot-management and anonymous-device state rather than
  credentials — deleting them only makes the next page load solve a Cloudflare
  challenge again.
- **Never prints values**, only names, domains and lengths.
- `--experimental-sqlite` is required on system Node 22.12. The app itself does not need
  it: it runs inside Electron 44, whose Node has the module unflagged.

> A cookie list is never evidence about login state. One run of this removed a valid
> `__Secure-next-auth.session-token` **and** left `oai-sc` behind, so neither "the
> session cookie is gone" nor "auth cookies are present" tells you anything on its own —
> the import path therefore verifies by probing the page, not by reading the jar.

## deepseek-probe.js

Records what the embed needs to know about `chat.deepseek.com` before an adapter can be
written: composer structure, send/stop buttons, which element holds one assistant turn,
whether a stable per-message id exists, and the conversation URL shape.

Selectors cannot be guessed here. A selector list that matches nothing fails SILENTLY —
no error, no log — so a wrong guess looks like a feature that was never built.

**Run (from the repo root):**

```powershell
node_modules\electron\dist\electron.exe tools\diag\deepseek-probe.js
```

A window opens on chat.deepseek.com. **Send one message** (anything that gets a text
reply), leave it on screen ~15 seconds, close the window. The probe only reads the DOM —
it never types, clicks, or sends.

Log: `%TEMP%\gpt-login-diag\deepseek-<timestamp>.log`

### What to look for in the log

| Line | Meaning |
| --- | --- |
| `composer=` | tag + attributes of the input. A `textarea` means the write path must use the native-setter approach, not `execCommand` |
| `sendButton=` | the send control, and whether it carries a stable attribute |
| `stopButton=` | whether a stop-generating button exists — its disappearance is the only reliable "reply finished" signal |
| `data-* histogram` | every `data-` attribute on the page, counted; the per-turn attribute is usually visible here |
| `idLike=` | elements with id-ish attributes. A stable per-message id is what makes execution idempotent across reloads |
| `message containers:` | candidate thread containers with child tag/class and text length |
| `sidebar links` | conversation links, for the "sync conversations" feature |

## analyse-net-log.mjs

**The question this answers:** Chromium keeps printing

```
handshake failed; returned -1, SSL error code 1, net_error -100
```

every 2–4 seconds from the same process, and the message **names no host**. Two platforms
are embedded at once (`chatgpt.com`, `chat.deepseek.com`), so the line alone cannot be
acted on — it does not even say whether the failure is in the embed, in an OAuth hop, or
in an update check.

The net log does have the answer — but **not in the place it looks like**. See "Why it does not
read the event-type table" below.

### Run it

Record a run with the net log on (see the README's "Recording a run to a file"), reproduce
the problem, then:

```powershell
node tools\diag\analyse-net-log.mjs "$env:APPDATA\GPT Web to Codex Terminal\logs\netlog-<timestamp>.json"
```

The app prints the exact path at startup when `DSH_NET_LOG=1` is set.

**The app does not have to be closed first.** The `constants` block (the event-type table) is
written **last, when Chromium closes the log**, so a running app's file contains no type names
at all — but host attribution does not need them. Analysing a live file is therefore fine, and
usually better: you see the failure while it is still happening.

Output:

```
events: 7020   destinations seen: 197   failures: 86
note: the event-type table is still being written (the app is running, or was killed),
      so rows are labelled by numeric type. Host attribution is unaffected — it is
      structural, not table-driven.

failures by host:

  hif-dliq.deepseek.com   (18 failures over 46.5s)   net_error -100
      events: type117, type134, type2
      repeating every ~2.7s
```

A full per-failure list is also written to `%TEMP%\net-log-failures-<timestamp>.txt`.

### Why it does not read the event-type table

The obvious design — parse `constants.logEventTypes`, then match on names — **produces a silent
wrong answer on any file from a running app**, which is the normal case: the block is an
unterminated JSON object until the log is closed, `JSON.parse` throws, and the first version of
this script fell back to placeholder type names and reported

```
events: 6289   url requests: 0   failures: 0
```

against a file that was in fact full of failures. A diagnostic that reports "nothing wrong"
because it could not read its own input is worse than no diagnostic at all.

So the host is recovered **structurally**: a connection's destination rides on the
`HTTP_STREAM_JOB` event as `params.destination` (a full URL), and every event of that
connection names its owning source by `source.id`. Matching any event with a negative
`params.net_error` against that map attributes each failure to a host without decoding a
single type id.

Rows reading `(no destination recorded for this connection)` are printed rather than dropped —
those are DNS/socket-level failures with no URL yet, and silently hiding them would repeat
exactly the mistake above.

### Notes

- **`net_error -100` is `ERR_CONNECTION_CLOSED`**, and `SSL error code 1` means the TLS
  handshake was cut off mid-flight. It is not a certificate problem (that would be
  `-200`–`-299`). The usual cause is the peer — or a proxy — closing the tunnel, which is why
  the *host* matters: it says whether everything is failing or one destination is.
- **One host failing while the rest work is not a proxy misconfiguration.** In the run above,
  `chat.deepseek.com` and `chatgpt.com` both completed TLS through the same proxy while
  `hif-dliq.deepseek.com` was reset every time — including when dialled **directly, with no
  proxy in the path**. Read the other rows before touching the proxy settings.
- **It reads the file and prints the summary; it never writes into the repo.**
- **Delete the log afterwards.** With `net-log-capture-mode=IncludeSensitive` it holds full
  URLs, and some of them carry tokens.

## Cleanup

Delete `%TEMP%\gpt-login-diag` when the investigation is over — the logs name the
sites visited and the cookie names in the session.
