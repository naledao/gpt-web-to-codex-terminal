# tools/diag — user-driven diagnostics

Small, throwaway probes for problems that only reproduce against live third-party
pages inside the user's real session. Per `AGENTS.md`, **the user runs and drives
them; the agent reads the log file.**

## ssh-terminal-check.cjs

The user runs `node tools/diag/ssh-terminal-check.cjs` for offline SSH terminal
regressions. It does not start Electron, a shell, or a network connection. Fake
channels exercise the actual SSH input and Ctrl+C methods, the command runner,
the interrupt IPC handler, and the React editor callbacks. Checks cover multiline
here-documents, blank lines, CRLF, advertised bracketed paste across split packets,
password non-disclosure, idle fallback, IME input and copying selected text.

Log: `%TEMP%\gpt-login-diag\ssh-terminal-check-<timestamp>.log`.

For live acceptance, the user starts the app with `npm run dev`, connects SSH and:

1. Pastes this harmless multiline command and presses Enter. Expect `first`, a
   blank line, and `last`, followed by the normal shell prompt:

   ```sh
   cat <<'EOF'
   first

   last
   EOF
   ```

2. Sends only `cat <<'EOF'`, waits for `>`, then clicks **中断**. Expect the normal
   shell prompt to return; `ls` must then list the directory. Repeat with Ctrl+C
   while focus is in the command editor and no text is selected.
3. Uses Shift+Enter to add a draft line; confirms Enter during Chinese IME
   composition does not submit, and Ctrl+C with selected draft text copies it.
4. Checks a model-issued running command still uses its existing interrupt path.

These offline checks do not establish live SSH behavior or visual correctness.

## attachments-probe.js / read-files-check.cjs

Attachment observation and offline checks for AI-selected file uploads. See
[AI file reading](../../docs/ai-file-reading.md) for the protocol and acceptance steps.

The user runs `node tools/diag/read-files-check.cjs` for offline checks. It never
starts Electron or accesses the network; fixtures and logs are created under `%TEMP%`.
It covers original file bytes (including text/source files), upload limits, SSH routing,
and both platforms' CDP file-selection path with a fake page. DeepSeek checks cover
custom disabled buttons, filename cards, old-row rerenders and recycled virtual rows.
They also cover numeric/opaque key mixtures, reasoning-only rows and the actual
command scanner after confirmation succeeds or expires. Release must preserve
command deduplication, allow only one next-command report, retain pre-submit drafts,
and avoid scheduling resumed scans for disabled terminal mode or restored history.
It also exercises the actual attachment scope/text extraction for file cards above
the toolbar, clickable cards and full filenames in labels, excluding editor text
and conversation history.
ChatGPT checks normalize nested selectable text to the user unit, inspect sibling
document/image cards and title/aria-label filenames, and exercise an extensionless
`hosts` attachment. They reject matching names in previous messages, assistant
claims and the composer by using the actual bounded attachment-root helpers.
The 2026-10-05 user-driven structure capture additionally established the full
`group/user-message` wrapper with `data-chatgpt-search-unit-key`: its attachment
card survives while the inner content-search text unit is removed/recreated.
Regression fixtures now exercise direct full-wrapper discovery without any text
unit, text hydration without duplicate messages, old-wrapper rerenders, wrapper
DOM reuse and the website's `hosts(1)` filename suffix. Full-wrapper keys are used
only during attachment acknowledgement; command selectors and persistent IDs stay
unchanged.
DeepSeek checks also cover extensionless UTF-8 text snapshots (including .gitconfig),
the .txt transport filename without byte changes, original ChatGPT names, SSH routing,
binary/non-UTF-8 rejection and the distinction between missing inputs and unsupported types.
The real injected picker is also
checked against the three-input layout observed in the attachment send log; these
checks do not verify the live website.

Normal application attachment sends also append a small phase log automatically to
`%TEMP%\gpt-login-diag\<platform>-file-send-<timestamp>-<pid>.log`, without `DSH_APP_LOG`.
The prefix is `chatgpt` or `deepseek`, and each platform has its own log file.
Look for `begin-result`, `page-diagnostics`, `cdp-start` / `cdp-done`, `upload-state`, `confirm-state`, `release-result`,
and the final `finish` stage/reason. Only structural state and upload metadata are
recorded; message text, file contents, image bytes and cookies are excluded.
Each attachment's `textNameAlias` flag records whether an extensionless UTF-8 text
snapshot used DeepSeek's .txt filename compatibility; it does not record source contents.
When filename recognition stalls, `page-diagnostics` additionally records composer
ancestor depths, the selected scope, control/image counts and filename-match counts
in text or labels. It never records the matching text or labels themselves.
Confirmation diagnostics include key presence, whether a key was already in the
baseline, baseline key count, numeric-baseline availability and user-turn count.
The keys themselves are not recorded. If the new user message appears but its
files are not recognized, `confirmation-diagnostics` records `userAttachmentAncestors`:
depth, selected scope, image/filename-match counts and boundaries at another message,
an assistant answer or the composer. It excludes text and label values.
`release-result` records the page release
call after the send finishes, including an unconfirmed submission; that outcome
does not trigger another submission, and future command scanning can continue.
The app sends only attachments. Read results/errors stay in the local execution record,
and the request token is used only for local correlation. Offline checks include an
attachment-only send with an empty composer and old-message rerender protection.

For live DOM evidence, close the app, then run:

```powershell
node_modules\electron\dist\electron.exe tools\diag\attachments-probe.js deepseek
```

Manually open the attachment menu, select a harmless image, wait for upload,
send it, and repeat with a PDF or text file. The probe does not select, upload,
or send files. It records changes in file inputs, preview counts, progress
semantics and send-button state. Cookies are logged as names and lengths only;
file contents, image bytes and conversation text are not logged.

Omit `deepseek` to observe ChatGPT; the old `chatgpt-attachments-probe.js` entry point
also still works. The probe loads the app's adapter instead of duplicating selectors.
It also records composer ancestor structure, numeric row positions, key type/length
and reasoning markers without opaque keys or turn text.

Log: `%TEMP%\gpt-login-diag\<platform>-attachments-<timestamp>.log`.
The proxy defaults to `http://127.0.0.1:7897`; `PROBE_PROXY`, `PROBE_USER_DATA` and
`PROBE_PARTITION` override the probe process only. Use application testing to
confirm the CDP upload path; an observed file input is not proof of a successful upload.

### Attachment-only messages missing from the turn selectors

When the website shows a sent card but the application still says "submission
unconfirmed", close the normal app and run this user-driven capture:

```powershell
node_modules\electron\dist\electron.exe tools\diag\attachments-probe.js --file-name hosts
```

Open the conversation that already contains the failed `hosts` / `hosts(1)` card,
wait ten seconds, then optionally upload and send the harmless sample whose absolute
path the probe prints. Wait for the reply to finish, wait ten more seconds, and close
the probe window. The sample is created with an exclusive filename under `%TEMP%`;
it has no extension for ChatGPT, matching the observed `hosts` case. DeepSeek's
sample has a `.txt` suffix. The probe never chooses, uploads or sends it.

`--file-name` can be repeated for existing attachment names. The capture uses a
filename match to find the visible card independently of the application's turn
selectors, including website-added suffixes such as `(1)`. Native file selections
are observed by one capture-phase change listener before the page clears FileList.

The new `messageStructure` snapshot records selector hit counts, matching leaf
elements, their ancestors and a bounded nearby DOM tree. Each element includes its
tag, classes, attribute **names and lengths**, role markers, key aliases, matching
filename indices and counts. No message text, file contents, href/src values,
title/aria-label values, or raw message identifiers are returned. Node and key aliases
are stable during one page load, so the log can distinguish a new message from a
rerender and show whether its card ever acquires the app's expected message marker.
`attachment-structure.cjs` contains this browser-only read function; the observer
serializes it into the inspected page and never runs it against a browser by itself.

This diagnostic is an evidence-gathering step, not a website compatibility verdict.
The agent writes it and reads the user's log; only the user runs and drives Electron.

## task-prompt-check.cjs

Task-scoped prompt injection: the first confirmed user send in a task carries the
full prompt. Follow-up messages, question answers and command output reuse it.
Only explicit `【任务完成】`, manual task termination or a real conversation change
resets the prompt; ordinary explanatory replies do not end the task.

The user runs the offline regressions:

```powershell
node tools/diag/task-prompt-check.cjs
```

This script never starts Electron or accesses a real page, cookies or the network.
It loads the actual interceptor functions into an in-memory editor and uses a
deterministic timer queue. It covers both textarea and contenteditable submission,
failed prefix writes and prepared-draft retries, multiline follow-ups, image-only
messages, live command tracking, clarification pauses, completion/manual termination,
configuration/mode changes, reload restoration and stale task callbacks. It also
transpiles the real main-process embed methods with Electron stubbed out, checking
that successful sends are restored after reload and late confirmations stay ignored.
Question checks connect those real embed methods to the actual injected answer path:
SSH environment/prompt updates and terminal-mode toggles retain an open question,
answers and live follow-up questions still work with terminal mode off, failed drafts remain retryable, and
environment updates retain an in-flight reply. Explicit task termination and
replaced question IDs still invalidate old answers.
Local-cancellation checks exercise the real page/main/IPC paths: cancellation
clears the question and its owned failed-answer draft without sending a message,
preserves task timestamps and the injected prompt, keeps later user edits, and
rejects stale IDs. DOM/configuration updates must not reopen cancelled questions;
late cancellation results must preserve a newer question. The runner is not called.
Logs use `fs.appendFileSync` under
`%TEMP%\gpt-login-diag\task-prompt-check-<timestamp>.log`.

For live acceptance, the user starts the application with `npm run dev` and checks
ChatGPT and DeepSeek separately:

1. Start a task that needs a command and a clarification. The injected count increases once.
2. During that task, send a correction, a follow-up and an image. The count stays unchanged;
   user messages/images are still recorded, and the next command can still be handled.
3. Answer the app's question dialog and let command results return. Neither adds a prompt.
4. After an explicit `【任务完成】`, send another task in the same conversation. The count increases once.
5. Repeat after using the app's “结束任务”; confirm that the new task receives a prompt.
6. Reload during a task, or update machine notes without ending it. The next follow-up
   still skips the prompt; the updated prompt is used when the next task starts.
7. In auto mode, wait for a question, type an answer, then close/disconnect/reconnect
   SSH, change the working directory or update machine notes. The question and draft
   must remain available, and confirming the answer must send it without another prompt.
8. With a question open, turn terminal mode off/on. The question remains; an answer
   can also be submitted while it is off, and the model's next live question still appears.
   Commands must stay disabled while it is off.
9. With a question open, type an answer and click **取消**. The dialog and pending
    question shortcut disappear, no message is sent to the model, and the task
    remains active. SSH/mode/environment changes must not reopen the old question.
    Sending a follow-up yourself continues the same task without another prompt.
    **收起** must still retain the question/draft, and the separate **结束任务**
    action must still end the task. Repeat cancellation after an unconfirmed answer
    send: only the app-owned draft is cleared; later edits in the page are retained.

The normal main-process log now reports `sent promptInjected=true/false` and
`taskPromptInjected=true/false`. The first value describes that specific user message;
the second describes the current task. To retain application logs for inspection,
set `$env:DSH_APP_LOG = '1'` in the user's PowerShell session before `npm run dev`;
the app prints its log path. Offline checks and a successful build do not verify
the live third-party websites.

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
2. Whether the flow can be driven to a code/password step at all. This used to ask whether the
   hops after the email address stayed inside the app's **navigation allowlist** — that allowlist
   has since been **removed** (Cloudflare's challenge needs `challenges.cloudflare.com`, which was
   never on it, so a protected site could not finish loading), so every hop is allowed now and the
   question is only about the page.

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
| `START/NAV/IN-PAGE APP-ALLOWS` | a hop, with its host. **Always** `APP-ALLOWS` now — see below |
| `INITIAL` / `AFTER-NAV` / `TICK` | URL, title, which fields exist (`email=/code=/password=/phone=`), visible text |
| `sessionEnded=true` | the “你的会话已结束” dead end — a page state |
| `cloudflare=true` | a Cloudflare interstitial; the app waits it out (~24s measured) |
| `WINDOW-OPEN REQUEST` | a popup was requested; denied and recorded, never launched |
| `BEFORE/AFTER COOKIES` | cookie **names and lengths only** |
| `VERDICT:` | the summary, written when the window closes |

**`APP-WOULD-BLOCK` can no longer appear.** The probe used to duplicate the app's navigation
allowlist so it could judge hops the way the real app would; that allowlist is gone (Cloudflare's
challenge needs `challenges.cloudflare.com`, which was never on it), so every hop is allowed and
the label is now always `APP-ALLOWS`. The hop lines are kept because they still show which hosts
the flow visits. The only case left where the app hands a URL out is `WINDOW-OPEN REQUEST` — a page
asking for a **new window** — and that is unchanged.

## reset-session-urls.mjs

**The question this answers: "why does this session keep landing on a login page?"**

A session's URL is persisted so a restart reopens where you were — which is wrong when the site
redirected through something a restart must not re-enter. On claude.ai the row held

```
https://claude.ai/login?from=logout&reauth=1&returnTo=%2Fnew%3F
```

and `reauth=1` is an explicit "log out and start over". Loading it put the app back into the auth
flow — behind Cloudflare — on **every** launch, so it could never reach the page a probe entered
directly, where the same challenge cleared in ~24 seconds. The session looked permanently broken
while the site was fine.

**Run (from the repo root, with the app CLOSED):**

```powershell
node --experimental-sqlite tools\diag\reset-session-urls.mjs            # report only
node --experimental-sqlite tools\diag\reset-session-urls.mjs --apply    # write
```

```
[reset] sessions: 1, needing repair: 1

  bba4ffab  claude
      was: https://claude.ai/login?from=logout&reauth=1&returnTo=%2Fnew%3F
      ->   https://claude.ai/new

[reset] dry run — nothing written. Re-run with --apply to write.
```

- **Dry run by default.** Check the list before writing; it names the exact URLs it would replace.
- Only the `url` column changes. Titles, conversations, terminal cwd and SSH state are untouched,
  so a session keeps its identity.
- The rule that stops this recurring lives in `isRestorableUrl` (`src/main/session-runtime.ts`).
  The check in this script is a **copy** of it, because a `.mjs` diagnostic cannot import the
  app's TypeScript. **Keep the two in sync** — otherwise this starts flagging sessions the app
  considers fine.

## clear-cloudflare-state.mjs

**The question this answers: "it works now — how do I get the challenge back?"**

When a Cloudflare challenge is solved, Cloudflare plants `cf_clearance` in the jar and stops
challenging that client for a while. That is why a failure caused by a bot check becomes
**unreproducible the moment anything waits the check out** — the app or a probe, either one. The
bug is not fixed; the condition that exposed it is simply gone. This deletes the clearance cookie
and puts the partition back to "first visit".

**Run (from the repo root, with the app CLOSED — it holds the jar open):**

```powershell
node --experimental-sqlite tools\diag\clear-cloudflare-state.mjs claude
```

```
[cf] partition : claude
[cf] mode      : cloudflare state only (login kept)
[cf] removing 3 cookie(s):
       .claude.ai             __cf_bm                            198 bytes
       .claude.ai             cf_clearance                       533 bytes
       .hcaptcha.com          __cf_bm                            198 bytes
```

- The argument is a bare partition name; the script lists the partitions that exist when it cannot
  find the one you asked for.
- **The login is kept**, because a challenge can be reproduced while still signed in and signing
  out costs a real login. Add `--login` only when you actually want the partition signed out.
- Backs the jar up first and leaves the backup in place. It never prints cookie values —
  `cf_clearance` is a bearer token, and anyone holding it can present as this client.

Then start the app and load that platform: it should be challenged again, which is the state the
bot-check handling exists for.

> Related, and deliberately the opposite: `clear-embed-cookies.mjs` **keeps** `cf_clearance` on
> purpose, because dropping bot-management state only makes the next load solve a challenge again.
> This script exists precisely because that is sometimes the thing you want.

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

## chatgpt-dom-probe.js

**The run that answers: did chatgpt.com's markup change out from under the interceptor?**

The interceptor is built on facts read off the live page — the composer is a
contenteditable div, an assistant turn is found through its message wrapper, and the
composer clearing is the only trustworthy "the send really happened" signal. **A selector
that stops matching fails silently**: no error, no log, the automation just never fires
again. So "the page changed" has to be measured, not guessed.

The **first generation** of that list — `#prompt-textarea`, `data-testid="send-button"`,
`data-message-author-role`, `data-message-id` — went to zero matches in the 2026-09 markup
change and took the automation down with it. `src/shared/platforms.ts` records what
replaced each one. Re-run this probe after any unexplained stop.

The probe does two jobs, in that order:

1. **Test every selector the app currently ships** and print `HIT` / `MISS` for each.
2. If something missed, dump enough to write the replacement from **one** run: the
   `data-*` histogram (how a *renamed* attribute is found), the full button inventory,
   the ancestor chain above a turn, and the raw markup of one turn.

```powershell
node_modules\electron\dist\electron.exe tools\diag\chatgpt-dom-probe.js
```

A window opens on chatgpt.com, in the app's real `persist:chatgpt` partition.

1. **Open a conversation that already has a few turns** — an empty page proves nothing
   about the turn selectors.
2. **Type a few characters into the composer, then stop. Do not send.**
3. Wait ~15 seconds so a tick lands with the text still sitting in the box.
4. Press Enter to send it, and **leave the reply streaming** for ~15 seconds so a tick
   catches the stop button.
5. Let the reply finish, wait ~15 seconds more, then close the window. The verdict is
   written at that moment.

Steps **2-4 are not optional**. The two button groups only exist in those states, and a run
that skips them produces `MISS`es that mean nothing — see below.

The probe **never types, clicks or submits** — every observation is a read of the DOM.
The user drives.

Log: `%TEMP%\gpt-login-diag\chatgpt-dom-<timestamp>.log`
Markup: the matching `chatgpt-dom-<timestamp>.markup.html` beside it.

### Reading the log

| Line | Meaning |
| --- | --- |
| `HIT` / `MISS` per selector | the headline. A `MISS` on the *only* selector in a group is the break |
| `^ A MISS HERE PROVES NOTHING …` | a qualifier printed under a `*** BROKEN ***` verdict when the page never had a reason to render that group. **Read it before believing the verdict** |
| `composer: OK` / `*** BROKEN ***` | per group summary, repeated on every tick |
| `candidate attributes` | **what replaced `data-message-author-role` / `data-message-id`.** One line per attribute with a count and sample values — the role discriminator is the *suffix* of one of those values |
| `data-* histogram` | every `data-` attribute on the page, counted — the renamed attribute is in here |
| `composer chain (innermost -> out)` | the composer's ancestors with a `buttons=` count each, so the toolbar container is identifiable |
| `composer toolbar buttons` | **the send/stop button lives here.** Scoped to the composer's subtree on purpose — see the note below |
| `id-ish attribute counts=` | counts for the dead generation (`data-message-id`, `data-testid`, `data-turn-id`, `data-message-author-role`) **and** the live one (`data-chatgpt-selection-message-id`, the `data-content-search-unit-key` role suffixes). The app dedupes executions by message id, so a `0` on the live id attribute is fatal to idempotency |
| `turn ancestors (innermost -> body)` | walking UP from the last turn. The per-turn wrapper and the thread list are named by the level where `turnsInside` stops growing |
| `buttons (N)` | flat inventory, capped at 45 for readability |
| `activeIsComposer=` / `composerText=` | whether the user had started typing when the tick landed — the send-confirmation depends on the box clearing, **and an empty box means the send button does not exist** |
| `urlLooksLikeConversation=` | whether the URL still matches `/c/<uuid>`, which is also how conversations are persisted |
| `sidebar links=` | `a[href^="/c/"]`, for the sidebar sync feature |
| `=== VERDICT ===` | the summary. It separates `BROKEN` groups from `NEVER TESTED` ones — a group whose absence the page state explains is not reported as broken any more |

### Why the buttons are reported twice

The flat `buttons (N)` list is **capped at 45 of 129**, and the sidebar rows fill that
window — so the one button that matters, the send button in the composer toolbar, never
appeared. The first run of this probe came back without it.

`composer toolbar buttons` exists so that cannot happen again: it walks up from the
composer to the first ancestor holding more than one button and lists **only what is
inside it**. Small, precise, and unaffected by how many sidebar rows exist.

### A MISS is only evidence when the element could have been on screen

Two runs of this probe reported `sendButton: *** BROKEN ***` and `stopButton: *** BROKEN ***`
and both verdicts were worthless: every tick had caught the composer **empty**
(`composerText= "\n"`), and ChatGPT does not render a send button until there is something
to send. The fourth and last toolbar slot held `开始语音` — the *voice* button — instead. The
stop button likewise exists only while a reply is generating, and nothing was generating.

A verdict that reads as "the app is broken" sent a whole round after three selectors that
had never been given a chance to match. So the probe now:

- prints a qualifier under any all-`MISS` group whose absence the page state explains,
  naming the state the user has to produce;
- keeps those groups out of `BROKEN` in the verdict and lists them as `NEVER TESTED`.

This is a general trap, not a send-button quirk: **before treating a `MISS` as a
regression, check that the tick happened in a state where the element exists.** An empty
composer, an idle page, and a page with no conversation open are all states in which
several of these selectors are *supposed* to match nothing.

**Confirmed the hard way.** The `sendButton` group reported `*** BROKEN ***` in both runs,
and those three selectors were in fact working the entire time. That was established later by
BEHAVIOUR rather than by this probe: clicking send *and* pressing Enter both still prepend the
system prompt, and from a click the only route into the code that prepends it is the click
interceptor that matches on that list. A round of diagnosis went into selectors that had never
been broken, while the actual fault — a 150ms single-sample send confirmation — sat somewhere
else entirely.

### Rules

- **Never guess a replacement selector.** A wrong guess fails silently and looks exactly
  like the bug you were fixing. The answer is in the histogram and the ancestor chains.
- **The shipped-selector list is duplicated inside the probe on purpose**, so it can say
  *which* one broke. **Change it whenever `src/shared/platforms.ts` changes**, or the
  probe starts reporting on selectors nobody uses any more.
- The page script is one big template literal: **one backtick inside it ends the string
  and breaks the whole file** (`SyntaxError: Unexpected identifier`). Spelling a word
  out in prose is cheaper than debugging that twice.
- **`node --check` does not check the page script**, because the page script is a *string*
  inside the file. To verify an edit to it, evaluate the template literal and parse the
  result — slicing the raw source between the backticks leaves the escapes unprocessed and
  produces a false `Invalid regular expression flags`, which sends you after a bug that is
  not there.
- Text is replaced with `«text»` in the dumped markup and long attribute values are
  truncated — the goal is the shape, not the user's conversation.

## claude-dom-probe.js

**The run that answers: what does `claude.ai` actually look like, from scratch?**

Unlike `chatgpt-dom-probe.js`, there is no list of shipped selectors to test — Claude is a NEW
platform, so this probe's job is **discovery**. It does try a handful of plausible selectors,
but only because a lucky hit saves a round of descriptor-writing: a `MISS` here means nothing
at all, and nothing in the log should be read as "broken". The real deliverable is the
structure:

| Section | Fills in |
| --- | --- |
| `data-testid VALUES` (sorted by count) | **the role markers** — Claude marks up its chat with test ids, so this table usually names both turn selectors outright. The `data-*` histogram cannot, because it counts attribute *names* only |
| `id-ish data-* attributes` | `messageIdAttr` — or proof that the site has none, which is a real finding |
| `composer chain` | `composerSelectors`, and whether it is `contenteditable` or a `textarea` |
| `composer toolbar` | `sendButtonSelectors` (the primary action is the LAST control) and `stopButtonSelectors` |
| `turn ancestors` | `assistantSelectors` / `messageSelectors` |
| `path=` + `NAVIGATE` lines | `conversationIdFromPath` / `conversationUrl` |
| `sidebar links` | how conversations are linked, for the sidebar sync |

```powershell
node_modules\electron\dist\electron.exe tools\diag\claude-dom-probe.js
```

If `claude.ai` is not reachable from this machine, hand it the same proxy the app would use:

```powershell
$env:PROBE_PROXY='http://127.0.0.1:7897'
```

It uses the app's **`persist:claude`** partition, so a login done in the probe window is a login
the app inherits — and equally, an existing app login means no sign-in step at all.

1. Log in, if a sign-in page appears.
2. **Open a conversation that already has a few turns.**
3. **Type a few characters, then STOP — do not send.** Wait ~15s for a tick.
4. Send it and **leave the reply streaming** ~15s, so a tick catches the stop control.
5. Let it finish, wait ~15s more, then close the window.

Steps 3 and 4 are not optional, for the reason recorded above: Claude renders no send control
while the composer is empty and no stop control while nothing is generating, so a run that skips
them produces `MISS`es that mean nothing. The probe prints a qualifier under any such group.

Log: `%TEMP%\gpt-login-diag\claude-dom-<timestamp>.log`
Markup: the matching `claude-dom-<timestamp>.markup.html` beside it.

### Cloudflare, and the identity patch this probe needs

The first run never left **"正在验证您是否是真人"**. The cause is the tell this repo already
recorded for Google: Electron's `Sec-CH-UA` advertises `["Not?A_Brand","Chromium"]` with no
`"Google Chrome"`, so every request says *same User-Agent as Chrome, different browser* — which
is precisely what a browser pretending to be Chrome looks like. `setUserAgent` cannot fix it;
the brand list is browser metadata, and Electron 44 has no `setUserAgentMetadata`.

The probe therefore rewrites `sec-ch-ua*` **and** the UA in a single `onBeforeSendHeaders`
handler, applied to the **whole partition** (`google-login-probe.js` scopes the same rewrite to
google.com only).

**The app does not do this yet.** `src/main/embed.ts` patches the User-Agent string and nothing
else, so unless this is ported into the embed, a Claude view will sit on that challenge page
forever — the descriptor work is not the whole job of adding this platform.

| Line | Meaning |
| --- | --- |
| `identity patch on the wire for …` | the rewrite reached a claude.ai/anthropic.com request, with the before-value |
| `TICK identity: webdriver=… brands=… challenge=…` | what the page's **JS** sees. Headers cannot change `navigator.userAgentData`, so if the challenge sticks while this still reads `Not?A_Brand`, the JS-visible identity is the remaining tell |
| `^ STILL ON THE CHALLENGE PAGE` | repeated on every tick means the patch did not satisfy it |

### Checking an edit to the page script

`node --check` never looks inside the template literal, so verify it separately — and verify it
**by line range**, not by "the first backtick after the opener". That second approach finds a
stray backtick *inside* the literal, mistakes it for the closing delimiter, truncates the range,
and reports a clean bill of health for the broken file. Both halves of that were done while
writing this probe, twice, which is why the note is here rather than in a commit message.

### Overrides (environment variables)

| Variable | Effect |
| --- | --- |
| `PROBE_PROXY` | proxy for this partition, applied for the life of the probe only |
| `PROBE_START_URL` | load something other than `https://claude.ai/new` |
| `PROBE_PARTITION` | different session partition |
| `PROBE_LOG_DIR` | different log directory |
| `PROBE_USER_DATA` | different userData dir (different partition jar) |

## gemini-dom-probe.js

**Two questions, and the FIRST one is not about the DOM.**

`gemini.google.com` is a Google property and needs a Google account. This repo has already
measured that third-party OAuth cannot complete inside an embedded view — `accounts.google.com`
answers `/v3/signin/rejected` even with a patched UA and a corrected `Sec-CH-UA` brand list
(recorded beside `EMBED_LOGIN_URL` in `src/shared/types.ts`). A DOM descriptor is worthless if the
page never gets past a sign-in screen, so this probe answers both in one run instead of producing
a beautiful dump of a login form.

**Why it is still worth running.** The same notes record that Google *renders the sign-in form
fine* in the embedded view, and that the refusal lands one step LATER, when the flow is handed to
OAuth. **Gemini's sign-in is a direct Google sign-in, not a third-party OAuth hand-off** — a path
nothing here has measured.

```powershell
node_modules\electron\dist\electron.exe tools\diag\gemini-dom-probe.js
```

Optional proxy if Google is unreachable: `$env:PROBE_PROXY='http://127.0.0.1:7897'`

It uses `persist:gemini`, so a login that succeeds here is one the app inherits.

1. **If a sign-in form appears, try it.** That IS question 1, and its answer is worth more than
   the DOM dump. The probe only watches.
2. If Gemini loads: open a conversation that already has a few turns.
3. Type a few characters, **do not send**, wait ~15s for a tick.
4. Send it, leave the reply **streaming** ~15s so a tick catches the stop control.
5. Let it finish, wait ~15s more, close the window.

### Reading the log

| Line | Meaning |
| --- | --- |
| `NAVIGATE/IN-PAGE GEMINI\|GOOGLE-AUTH\|OTHER-GOOGLE\|EXTERNAL APP-ALLOWS\|APP-WOULD-BLOCK` | **the line that decides the feature.** The app hands anything outside a platform's allowlist to the system browser; `APP-WOULD-BLOCK` on a `GOOGLE-AUTH` hop means the embed cannot log itself in |
| `pageKind=` | `gemini` / `google-signin` / `google-identifier` / `google-account` / `unknown`, decided from the DOM, not the URL — the URL says `gemini.google.com` even while a sign-in form is what is rendered |
| `^ NOT A GEMINI PAGE` | nothing below it is evidence about the descriptor |
| `custom elements` | **the Angular component tags** (`rich-textarea`, `model-response`, `user-query`) — on this site they are far more stable than the generated class names beside them |
| `data-test-id VALUES` | both `data-test-id` and `data-testid`, by value — where role markers live |
| `=== VERDICT ===` | which of the two questions the run answered, and what is still open |

**Check the id SHAPE before writing `conversationIdFromPath`.** `isConversationId()` in
`src/shared/platforms.ts` requires a UUID; a site using some other shape needs that check widened
deliberately, not assumed — the `path=` and `segments=` lines are what say which case this is.

Log: `%TEMP%\gpt-login-diag\gemini-dom-<timestamp>.log`
Markup: the matching `gemini-dom-<timestamp>.markup.html` beside it.

## gemini-cookie-probe.js

**The run that decides whether the Gemini import route is worth building at all.**

`gemini-dom-probe.js` answered the login question the expensive way — Google replied 无法登录 /
"此浏览器或应用可能不安全" to a direct sign-in inside the embedded view. That is the third time
this wall has come up (third-party OAuth, then Apple, now a first-party Google sign-in), so the
session has to arrive from outside.

`src/main/session-import.ts` already does that for ChatGPT, but its scheme does not fit: it
imports **one** cookie — a NextAuth bearer token, reassembled from `.0`/`.1` chunks — onto the
platform's own domain. A Google session is a **set** of cookies on `.google.com`, with no chunks
and no single bearer token.

**So before any of that is written, this answers the only question that matters:** do copied
Google cookies actually produce a signed-in session here, or does Google reject them the way it
rejects the embedded sign-in? If they are rejected, the feature is dead and nothing should be
built.

### Run it

You need a text file holding your Google cookies. Easiest source — DevTools:

> Network tab → click any `gemini.google.com` request → Headers → Request Headers → copy the
> whole `cookie:` line.

```powershell
$env:PROBE_COOKIE_FILE='C:\path\to\google-cookies.txt'
node_modules\electron\dist\electron.exe tools\diag\gemini-cookie-probe.js
```

**"Copy as cURL" works too**, and so does a bare `name=value; name=value` string — the parser
finds the cookie header inside all three, because asking the user to reformat is asking for a
failed run.

Optional proxy: `$env:PROBE_PROXY='http://127.0.0.1:7897'`

**Cookie values are never logged.** Only names and lengths are written — that is the rule for
every probe here, and this log is a file that gets pasted around. A Google session cookie is a
full account credential.

### Reading the log

| Line | Meaning |
| --- | --- |
| `cookie names present (value lengths in brackets)` | what was parsed — names and lengths only |
| `present` / `MISSING` against the Google auth list | `SID` / `__Secure-1PSID` / `__Secure-3PSID` missing means Google will almost certainly ignore the rest |
| `wrote N/M cookie(s) onto .google.com` | `.google.com` on purpose: the session must cover whatever `accounts.google.com` hop the page makes, and a cookie scoped to `gemini.google.com` would be absent on exactly the request that matters |
| `jar now holds …` + `<-- SESSION COOKIE` | **read this line.** A session cookie is present in this process and gone in the next one |
| `WARNING: N of them are SESSION cookies` | the run will look like it worked and the app will find nothing |
| `hasComposer=` / `looksLikeWall=` | the verdict, decided from the DOM, not the URL: Google serves the wall **on** `gemini.google.com`, so the hostname says nothing |
| `=== VERDICT ===` | `IMPORTED COOKIES WORK` / `REJECTED` / `INCONCLUSIVE`, and what each means for the import feature |

### `expirationDate` is not optional — it cost a whole run

The first version of this probe wrote 25 cookies, reported `wrote 25/25` and `jar now holds 25`,
and loaded Gemini **fully signed in**. The next process found an empty jar and a signed-out page.

Cause: without `expirationDate`, Electron creates a **session cookie**, and Chromium never writes
session cookies to disk. So the write succeeded, the session was real, and nothing was persisted.
Measured afterwards in the on-disk store (`Partitions/gemini/Network/Cookies`): all nine
`SID`/`__Secure-*` cookies absent, while every cookie **Google had re-set during the page load**
was there with `has_expires=1, is_persistent=1`.

Two lessons worth keeping:

- A raw `cookie:` header carries no attributes, so the real expiry is unknowable from the input
  this probe accepts. Thirty days is a deliberate stand-in — the server validates the VALUE, not
  the client's expiry.
- **"The write succeeded" and "the write persisted" are different facts.** The read-back now
  names session cookies explicitly, because this failure is invisible from inside one process.

Reading the on-disk store needs the app closed: Chromium holds `Network/Cookies` with a lock that
blocks even a file copy (`EBUSY`). Once it is closed, copy the file somewhere writable and open
the copy — a read-only open fails, because SQLite still needs to touch the WAL.

Log: `%TEMP%\gpt-login-diag\gemini-cookie-<timestamp>.log`

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

## deepseek-theme-probe.js

**The run that answers: what actually controls `chat.deepseek.com`'s light/dark appearance?**

The app has one theme setting (`应用主题`); the page inside it is a third-party site with a
theme of its own, and until now nothing connected the two — switching the app to dark left
every chat page light. Two mechanisms could carry the setting across, and they are not
interchangeable:

| Mechanism | Where it lives | Covers |
| --- | --- | --- |
| `nativeTheme.themeSource` | the main process | a site whose own appearance is "follow the system" — it changes what `prefers-color-scheme` answers |
| a DOM hook (`html.dark`, `body[theme-mode=dark]`, …) | the page | a site whose appearance is PINNED to an explicit light/dark in its own account settings |

**Which one DeepSeek needs is a fact about DeepSeek, and it is not knowable from here.** A
hook that matches nothing changes nothing, silently — the page simply stays as it was, which
looks exactly like the feature never having been built. So it gets measured.

```powershell
node_modules\electron\dist\electron.exe tools\diag\deepseek-theme-probe.js
```

Optional proxy: `$env:PROBE_PROXY='http://127.0.0.1:7897'`
Uses the app's real **`persist:deepseek`** partition, so it opens whatever session the app has.

### What the user does

1. **Wait ~45 seconds and touch nothing.** The window changes theme, reloads, changes theme
   again, then has its DOM replayed — all of it automatic, and interrupting it wastes the run.
2. **Then switch DeepSeek's OWN theme once** (its settings → 外观/主题). The probe prints a
   `CHANGE` block naming exactly what moved.
3. Leave it ~10 seconds, then close the window. The verdict is written at that moment.

The probe **never clicks and never types in the page, and never writes storage** — the site's
own preference is recorded in the log and left alone. It **does** write the DOM during the
replay phase (the three `<body>` changes in `DESCRIPTOR`, dark then light, ending where the
page already was): that phase exists to test the shipped rules against the live page rather
than trust them. It also changes its own process's theme preference, on a timer, on purpose.

### Reading the log

| Line | Meaning |
| --- | --- |
| `BASELINE` / `AFTER-PHASE-*` / `AFTER-BOOT-*` / `REPLAY-*` / `FINAL` | forced snapshots; `TICK`s log **only when something changed** |
| `CHANGE <field>: before -> after` | **the answer.** Which attribute, class or storage entry moved — printed as a diff, so a theme switch does not have to be spotted across twenty identical dumps |
| `scheme=` + `prefers-color-scheme=` + `(evidence)` | what the page is painted, what the page *believes* the OS wants, and the computed colour that decided it |
| `html attrs=` / `html classes=` / `body attrs=` / `body classes=` | the hooks, in full — not a candidate list, the actual document |
| `localStorage=` / `sessionStorage=` | theme-shaped entries only (`theme`, `appearance`, `scheme`, `color-mode`, or an exact `dark`/`light`/`system` value) |
| `CSS MAP` | **the site's own contract.** Selector prefixes from DeepSeek's stylesheets that mention dark/light/theme, with a count each |
| `FOLLOWS LIVE` | did the page react to a preference flip on an **already-open** page. `false` on DeepSeek — it reads the query at boot only |
| `FOLLOWS AT BOOT` | did it react when the preference was set and the page **reloaded**, which is what the app does. `true` means a fresh load needs no DOM work at all |
| `DESCRIPTOR REPLAY` + `WORKS` / `FAILED` | **the shipped rules, tested.** `DEEPSEEK_THEME` is duplicated in this probe and replayed against the live page in both directions; `FAILED` means the descriptor and the page have drifted apart |
| `cross-origin sheets skipped` | sheets whose `.cssRules` threw; their rules are not in the map and their absence is not evidence of anything |
| `layers=` | computed `bg` / `fg` / `colorScheme` for html, body, `#root`, `#app`, `main` |

### Rules

- **Nothing in the page is clicked, typed into, or written outside the replay phase**, and
  storage is never written: a key this probe has not seen control the theme is a key it has no
  business setting — and even the one it *has* seen is only reported, because it is the site's
  own preference and would follow the user into their real browser.
- **`FOLLOWS AT BOOT` is only meaningful next to the site's own preference**, which the
  `localStorage` line carries. Measured: while DeepSeek is pinned to `light` or `dark` in its
  own settings, the media query reaches the page (`prefers-color-scheme` flips correctly) and
  the page ignores it — at boot as well as live. That pinned case is exactly what the DOM
  replay exists for. With the site set to 跟随系统 the answer can differ, and the log says which
  case the run was.
- **The descriptor is duplicated inside the probe on purpose.** A probe that read
  `src/shared/platforms.ts` would pass whatever that file says, including a value mistyped into
  it. **Keep the two in sync**, the same way the ChatGPT probe duplicates its selector list.
- **The log is the deliverable.** The adapter values are written from it, not before it.
- The verdict is captured on the window's `close`, not its `closed`: `closed` fires after the
  webContents is gone and every capture inside it fails with `Object has been destroyed` — the
  first run of this probe lost its `FINAL` snapshot that way.
- The page scripts are template literals, so the two traps in `chatgpt-dom-probe.js` apply
  here too: **one backtick inside ends the string**, and **a backslash escape is consumed by
  the literal before the page sees it** (`\s` arrives as `s`). Both are avoided — string
  concatenation instead of interpolation, `[ ]` instead of `\s`.
- **`node --check` does not check the page scripts** — they are strings inside the file. They
  were verified by slicing each literal **by line range** and parsing the result, which is
  also the only way to catch the backtick problem: "the first backtick after the opener" finds
  an inner one and reports a clean bill of health for a broken file.

Log: `%TEMP%\gpt-login-diag\deepseek-theme-<timestamp>.log`

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
