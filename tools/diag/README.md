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

## Cleanup

Delete `%TEMP%\gpt-login-diag` when the investigation is over — the logs name the
sites visited and the cookie names in the session.
