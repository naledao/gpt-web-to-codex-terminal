# GPT Web to Codex Terminal

A React + Electron desktop app scaffold: **electron-vite + Vite + TypeScript + React 19**,
with a context-isolated IPC bridge and `electron-builder` packaging.

## Requirements

- Node.js >= 22.12 (Electron 44 requires it)
- npm 10+

## Quick start

```bash
npm install
npm run dev
```

The dev command first makes sure Electron's platform binary is installed (using the
mirror configured in `.npmrc`), then starts the Vite dev server for the renderer and
launches Electron against it — edit any file under `src/renderer/` and the window
hot-reloads. Changes to
`src/main/` or `src/preload/` restart the Electron process automatically.

## When something only breaks in the real app

Login, Cloudflare and proxy problems happen against live third-party pages inside
your real session, so they cannot be reproduced by a script. Those are investigated
with **user-driven probes**: you click through the app (or a small probe window built
from the same `persist:chatgpt` partition), the probe writes a log file, and the
agent analyses that file. See **[`tools/diag/README.md`](tools/diag/README.md)** and
the division-of-labour rule in `AGENTS.md`. Probes never type credentials, never
submit forms, and never log cookie values.

## Scripts

| Script                 | What it does                                                        |
| ---------------------- | ------------------------------------------------------------------- |
| `npm run dev`          | Ensure Electron is installed, then run Vite + Electron with HMR       |
| `npm run electron:install` | Pre-fetch the Electron binary (mirror-aware)                     |
| `npm run build`        | Typecheck, then bundle main/preload/renderer into `out/`             |
| `npm run preview`      | Run Electron against the built `out/` (production behaviour)         |
| `npm run typecheck`    | Typecheck both TS projects (node + web)                              |
| `npm run pack:dir`     | Build an unpacked app dir in `release/` (fast packaging smoke test)  |
| `npm run dist`         | Build installers for the current platform                            |
| `npm run dist:win`     | Windows NSIS installer                                               |
| `npm run dist:mac`     | macOS DMG                                                            |
| `npm run dist:linux`   | Linux AppImage                                                       |

## Project layout

```
electron.vite.config.ts   Three Vite builds: main, preload, renderer
electron-builder.yml      Packaging / installer configuration
tsconfig.node.json        TS project for main + preload + shared (Node, no DOM)
tsconfig.web.json         TS project for the renderer (DOM + JSX)

src/
  main/index.ts           Electron main process — window lifecycle, IPC handlers
  main/embed.ts           chatgpt.com hosted in a native WebContentsView
  preload/index.ts        contextBridge: exposes a typed `window.api` to the renderer
  preload/index.d.ts      Global `window.api` type for the renderer
  shared/types.ts         Types + IPC channel names shared by all three processes
  renderer/
    index.html            Renderer entry (note the CSP meta tag)
    src/main.tsx          React bootstrap
    src/App.tsx           Root component: toolbar + embed slot + status bar
    src/assets/main.css   Styles
```

## Embedding chatgpt.com

The middle of the window is the real chatgpt.com, hosted in a native
**`WebContentsView`** that the main process layers on top of the React renderer.

**Why not an `<iframe>`?** chatgpt.com refuses to be framed (`X-Frame-Options` /
CSP `frame-ancestors`), so it can only be embedded out-of-process.

**Why a native view and not a component.** A `WebContentsView` is not a DOM node —
it cannot be styled, positioned by CSS, rounded, or z-ordered against the page. It
always paints *above* the renderer. So the two sides cooperate:

1. React renders an empty `<div class="stage__slot">` as a placeholder.
2. A `ResizeObserver` measures that div and sends the rectangle over
   `embed:set-bounds`.
3. The main process calls `view.setBounds()` to move the native view onto it.

Consequences worth knowing before extending the UI:

- **Nothing may overlap the slot.** Any dropdown, tooltip or modal drawn over it
  will be hidden behind the native view. Call `window.api.setEmbedVisible(false)`
  before opening such UI, and restore it afterwards.
- **The slot is deliberately square-cornered** — a native view cannot be clipped
  to a `border-radius`, so rounding it would only expose a mismatched edge.
- Coordinates are CSS pixels from `getBoundingClientRect()`, which is already the
  DIP space `setBounds()` expects. Do not multiply by `devicePixelRatio`.

### Isolation and navigation

- The page runs in its own `persist:chatgpt` partition, so it has a separate
  cookie jar and can never read the app's session. Login survives restarts.
- `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, and **no
  preload** — the third-party page gets no access to `window.api`.
- Navigation is pinned to OpenAI-owned domains; anything else is opened in the
  system browser. This policy covers normal navigations, server redirects, and
  main-frame navigation events, so third-party OAuth (Google/Apple) does not stay
  inside the embedded user-agent. Those providers block embedded sign-in.
- The embedded ChatGPT session has its own cookie jar. Opening an OAuth provider
  in the system browser is the policy-compliant escape hatch, but it does not copy
  the system browser's cookies back into `persist:chatgpt`; if the provider does
  not return through a supported desktop-app callback, use ChatGPT's email/OTP
  sign-in or the normal browser version of ChatGPT. The status bar shows these
  alternatives after an external OAuth redirect is opened.
- The embed IPC channels are only accepted from the app's own window, so the
  embedded page cannot drive its own native view.
- A stock Electron user agent advertises `Electron/44.4.3`, which Cloudflare's bot
  rules on chatgpt.com reject. `embed.ts` therefore sends a plain Chrome UA.
  Override it with the `EMBED_USER_AGENT` environment variable if needed.

### Signing in: email/OTP is the only route that works in the embed

Measured, not assumed (see `tools/diag/README.md` for the probes and the raw
evidence):

- **Provider OAuth cannot be made to work inside the embedded view.** Google serves
  the sign-in form and then refuses a step later with
  `accounts.google.com/v3/signin/rejected`. This is not a user-agent problem: this
  Electron's stock UA already carries no `Electron/` token, the UA does reach the
  network layer, and rewriting `Sec-CH-UA` to advertise `"Google Chrome"` in
  `onBeforeSendHeaders` changes nothing. Page-level Client Hints cannot be corrected
  at all — Electron 44 has no `setUserAgentMetadata`, and top-level navigations do
  not expose `sec-ch-ua` to that handler.
- **The system browser cannot close the loop either.** Its ChatGPT cookies live in
  another jar, and Chrome's App-Bound Encryption (v20 cookies) makes importing them
  from outside Chrome impossible.
- **Email/OTP is the one route that finishes inside the embed** — `auth.openai.com`
  is inside the navigation allowlist, and the session it creates is created in
  `persist:chatgpt`, which is exactly the session the embedded page needs.

So the auth notice's **改用邮箱登录** button navigates the embed to
`EMBED_LOGIN_URL` (`https://auth.openai.com/log-in`). It previously sent the embed
home while claiming to offer email sign-in — a button that promised a route no code
implemented. Anything that changes this needs to keep the email route intact.

### When no sign-in route exists: importing a session

Email/OTP sign-in still needs the account to *have* a password, and an account created
with Google does not. Entering such an address and pressing continue makes OpenAI
redirect straight back to Google — observed at
`auth.openai.com/api/accounts/authorize/continue` answering with
`accounts.google.com/o/oauth2/v2/auth` — which Google then refuses. For those accounts
the only credential that can travel into this app is the **session token the browser
already holds**.

`src/main/session-import.ts` implements that: the user copies the cookie value out of
their browser's DevTools, and it is written into `persist:chatgpt` with
`secure: true, httpOnly: true` for `.chatgpt.com`.

Design decisions worth keeping:

- **The user must copy it by hand.** Chrome and Edge both seal their cookie database
  with App-Bound Encryption, whose key is bound to the browser's own process. Nothing
  outside that process can decrypt it, so "read the browser's cookies automatically"
  is not implementable — not merely unimplemented.
- **Success is decided by the page, not by the write.** A cookie can be accepted and
  still be expired or revoked, so the import reloads and then probes the document for
  the signed-in chrome (a composer plus a sidebar or account button, and no login call
  to action). Text matching is deliberately avoided: both states contain the words
  "ChatGPT" and "log in".
- **The value is never persisted anywhere.** It is one IPC argument, written to the
  cookie jar, then dropped — never logged, never stored on disk, and cleared from the
  input on both success and failure.
- **"Cannot tell" is reported as not signed in.** A navigation during the probe must
  never be reported as a successful login.

### State flow

The main process pushes `embed:state` on every navigation/loading change. Because
the first events fire while the window is still being created — before React has
subscribed — the renderer also pulls `embed:get-state` once on mount. Without that
pull the UI can stay stuck on its initial "loading" state.


## The three processes

- **main** (`src/main/index.ts`) — full Node.js. Owns windows, filesystem, OS access.
  Must never be exposed directly to the renderer.
- **preload** (`src/preload/index.ts`) — runs in the renderer with Node access, before
  page scripts. Uses `contextBridge` to publish a narrow, typed API.
- **renderer** (`src/renderer/`) — an ordinary sandboxed web page. It has **no** Node
  access; it can only call what preload published.

Adding a feature means adding a channel end to end:

1. Add the name to `IpcChannels` and the signature to `AppApi` in `src/shared/types.ts`.
2. Handle it with `ipcMain.handle(...)` in `src/main/index.ts`.
3. Implement it in `src/preload/index.ts` (the `AppApi` annotation makes TS enforce this).
4. Call `window.api.<method>()` from React.

Because `AppApi` lives in one place, a mismatch between preload and renderer is a
compile error rather than a runtime `undefined`.

## Terminal mode (send interceptor)

When terminal mode is on (the default), every message you send gets a fixed
system prompt prepended **inside the composer**, so you can see it in the input
box before it goes out:

```
你现在处在一个win11的cmd终端中，用户会发送给你他的目标，你只能输出cmd指令和这个指令的用户格式是json形式
{"command":"","description":""}，一次只能输出一个指令，用户会把指令的结果发送给你，你要继续处理知道目标完成。
如果任务已经完成，不需要再执行任何指令，就把 command 输出为空字符串。

<your text here>
```

Toggle it in the right-hand panel; the panel also shows how many times it has
injected and the text of the last message sent. Edit the prompt in
`TERMINAL_SYSTEM_PROMPT` (`src/shared/types.ts`).

### How the interception works

The script lives in `src/main/injected/send-interceptor.js` and is injected into
**the page's main world** by `embed.ts` using `executeJavaScript` (which is not
subject to the page's CSP nonce — it never becomes a `<script>` tag). It is
bundled as a string through Vite's `?raw` import, so it stays a normal `.js` file
with real syntax highlighting instead of an escaped string literal.

Two details matter:

- **The composer is ProseMirror, not a plain input.** `#prompt-textarea` is a
  `contenteditable` div whose document state is owned by ProseMirror. Assigning
  `innerHTML` does not work: ProseMirror overwrites it and the send button stays
  disabled. The script uses `document.execCommand('insertText', …)` with the
  caret placed at offset 0, so ProseMirror sees an ordinary user edit and updates
  its state.
- **Both send paths are intercepted** — Enter (`keydown`, capture phase on
  `document`, ignoring Shift+Enter and IME composition) and clicking the send
  button. After injecting, the script submits programmatically, retrying because
  the send button only enables once ProseMirror commits the edit. If injection
  ever fails, the message is still submitted rather than being trapped in the box.

`document`-level capture listeners are used so they survive ChatGPT's
client-side route changes; the script re-installs itself on every full page load
and guards against duplicate listeners.

### Scrolling to the newest message

A programmatic send does not make ChatGPT scroll the way a real click does: the
message the app just injected, and the reply that follows it, land below the fold and
you have to scroll down by hand every time. So after a **confirmed** send (never after
a failed one) the script sets the thread's scroll position itself, and re-asserts it
over the next 1.2 seconds while the new turn renders.

Two details that are easy to get wrong:

- **The scroll container is found by behaviour, not by selector.** ChatGPT's class
  names are hashed and change without notice. The code walks up from the newest turn to
  the first ancestor that genuinely overflows vertically and has `overflow-y: auto` or
  `scroll`; only if that fails does it scan for the tallest scroller on the page.
- **The scroll is instant, not smooth.** The thread is styled with smooth scrolling,
  and an animated scroll competes with the re-render that immediately follows a send —
  it gets cancelled part-way and settles short, which looks exactly like not having
  scrolled at all.

It deliberately stops after that brief window rather than following the reply to the
end: past that point you may well be reading something further up, and being yanked
back down would be worse than the original problem.

### Reporting back to the app

The embedded page has no preload and therefore no IPC bridge, so the script
cannot call `window.api`. It reports with `console.log('[cmd-terminal] {…}')`,
which the main process parses in `webContents.on('console-message')`. That is a
deliberately one-way, parse-only channel: the page can log, but it can never
invoke anything in the app.

The injected **count is accumulated in the main process**, not read from the page,
because the page's own counter resets on reload.

## Terminal automation

Terminal mode can drive a full loop: the model asks for a command, the app runs
it in the terminal, and the output is handed back to the model.

```
you type a goal
  -> interceptor prepends the system prompt, sends
model replies {"command":"...","description":"..."}
  -> page watcher parses it, reports over the console bridge
main process
  -> dedupe by assistant message id, check the danger list
  -> store the row, push it to the UI
  -> run it in the persistent shell for that backend
       local   : PowerShell, one long-lived process for the whole app
       remote  : bash -s on the SSH host, once a session is attached
  -> hand stdout/stderr back to the model, WITHOUT the system prompt
model replies with the next command ...
  -> a reply with no JSON means the task is finished and the loop stops
```

Set the mode to **自动执行** in the right-hand panel to close the loop; the default
is **手动执行**, where every command waits for a click. Attaching an SSH session moves
the loop to that host and swaps the prompt to match — see [SSH](#ssh).

### One terminal, not one per conversation

The left pane is a window onto a **machine**, not onto a chat. Opening a conversation,
starting a new one, or switching between them changes nothing about it: the scrollback
stays, the working directory stays, and variables set three commands ago are still
there.

That is deliberate. Shells used to be per conversation, which meant the first message
of a new chat — the moment ChatGPT creates the conversation and the URL gains an id —
cleared the pane and started the next shell in your home directory, while the prompt
still told the model it was in the directory you had picked. The terminal now belongs
to whichever machine is in charge (this one, or an attached SSH host), and the prompt
describes that machine because it is the same shell the commands run in.

**重置** is the only thing that clears it.

### The current step
Above the output the terminal pane keeps a standing call-out of the command the loop
is on — the model's own one-line description of it, the command itself, its status and
its exit code:

```
[执行中]  检查 ffmpeg 是否安装                    退出码 —
> where.exe ffmpeg
```

The description was already being stored with every command and shown nowhere; the
command itself existed only as one line in the scrollback, so answering "what is it
doing right now, and why" meant reading back up through the terminal to find it.

What it shows, in order of preference:

| | |
| --- | --- |
| a **running** command | that is literally the one executing |
| else the **newest waiting** one | that is what the next 运行 click would start |
| else the **last finished** one | so the block does not go blank the moment a command ends |

The running case is the one worth stating: if you click 运行 on an older waiting
command while a newer one is still queued, the block follows what is *actually*
running, not the newest row in the table.

### Why the backend is PowerShell, and why commands go in base64

An earlier version of this app drove `cmd.exe`. It was abandoned for a concrete,
reproducible reason: feeding commands to a long-lived cmd through a **stdin pipe**
means going through a code page, and `chcp 65001` does not reliably apply to piped
input. **Any command containing a non-ASCII character made cmd.exe terminate
outright** — fatal for a tool whose whole job is running a model's commands.

The backend is now Windows PowerShell (`pwsh.exe` if present, otherwise the built-in
`powershell.exe`), and each command is a fresh process:

```
spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
                   '-EncodedCommand', base64_utf16le(script)])
```

The command travels as **base64 of its UTF-16LE form**, and that detail is load
bearing rather than stylistic:

- **No code page is involved anywhere.** The failure mode described above cannot
  exist on this path.
- **No quoting rules.** PowerShell's own command-line parser mangles embedded
  quotes in `-Command`; base64 sidesteps it entirely.
- **No helper files.** The cmd backend needed a wrapper `.bat`, an environment
  variable for the command text, and a file to carry the working directory. All
  three are gone.

Continuity that still matters is restored by hand. The script ends with

```powershell
Write-Output ('<random token>' + (Get-Location).Path)
```

and that line is pulled out of the output to become the `cwd` of the next spawn.
This is what keeps `cd somewhere` followed by another command — the shape of nearly
every multi-step plan — working.

**Not preserved:** variables a command sets for itself, and shell state such as
`pushd`/`popd`. Each command is its own process.

The prompt teaches **PowerShell 5.1-compatible syntax**, which is a subset of 7's,
so it works on whichever one is installed — in particular it tells the model not to
use `&&`/`||`, which 5.1 does not have.

### Encoding: normalised to UTF-8 at the boundary

Everything inside the app — the UI, the database, the messages handed back to the
model — is UTF-8. Whatever the terminal produces is normalised on the way in.

There is a hard limit worth knowing: **a third-party program writing to a pipe uses
the process ANSI code page (936 here), and `chcp` cannot reach it.** That code page
is fixed by `GetACP()` at process start, so "make every tool emit UTF-8" is not
achievable without changing the system locale. Normalising on our side is the only
place it can be fixed.

Three encodings actually turn up, and all three are handled:

| Encoding | Who produces it |
| --- | --- |
| **UTF-16LE** | `wmic` and friends, whenever their output is redirected — every ASCII character arrives followed by a NUL byte |
| **UTF-8** | cmd's own builtins under `chcp 65001`, and tools that honour the console code page |
| **GBK** | everything else, i.e. tools using the ANSI code page |

The order matters: UTF-16LE is detected first (BOM or NUL pattern), then the chunk
is tested as *strict* UTF-8, and only if that fails is it decoded as GBK. Testing
UTF-8 strictly is what keeps GBK text from being mistaken for it. Trailing bytes
that might be a split character are held back — three for UTF-8, one for UTF-16.

Two things push the balance towards real UTF-8 rather than guesswork:

- the wrapper runs `chcp 65001`, so cmd's own builtins read and write UTF-8 and
  `echo 你好>hello.md` lands on disk as UTF-8;
- the spawn sets `PYTHONUTF8=1` and `PYTHONIOENCODING=utf-8`, so Python — the
  runtime a model is most likely to script against — emits UTF-8 natively.

The GBK fallback is still required: `certutil` really does only ever produce GBK.

### Execution mode

Pick the mode in the right-hand panel; it is persisted in the database and
restored on the next launch.

| Mode | Behaviour |
| --- | --- |
| **手动执行** (default) | Every command is stored and appears as a pending row. You click 运行; the output goes back to the model; the next command arrives as another pending row. |
| **自动执行** | A detected command runs immediately, its output goes back to the model, and the loop continues until `command` is empty. |

In **both** modes the result is handed back to the model, and in both modes the
danger list still stops a command and waits for a click.

**暂停** is the global stop: nothing runs and nothing is sent while it is on.

### When the model stops to ask

The loop has exactly two ways to end: the model reports the task done, or it asks a
question. Both are the same mechanism — a reply in plain text with **no JSON**, which
the parser reads as "no command" and simply stops.

The prompt uses the second one for two cases:

```
【不确定时】
拿不准就**停下来问用户** —— 这不是失败，是正常的一步。典型情况：任务本身没说清
（目标模糊、有明显不同的几种做法、缺一个只有用户知道的信息），或者这一步需要的工具
这台机器上没有装（**不要擅自安装**，也不要为了绕开它去拼一个更差的替代方案）。
但**自己能查清楚的不要问**：先看文件、读代码、跑一条只读命令确认，再决定要不要问。
问的时候直接正常回复用户（**不输出 JSON**），说清你在纠结什么、有哪几种选择、你倾向哪个
以及为什么，然后等用户回答；得到答复后继续输出 JSON 推进任务。
```

- **An underspecified task.** Guessing burns a round trip and usually more.
- **A tool that is not installed.** Installing unasked changes your machine, and quietly
  substituting a worse approach is worse still — that is exactly how the
  `Format-Table -AutoSize` timeout above came about, from reaching for
  `Get-ChildItem | Select-String` because `rg` was missing.

**The third line is the one that keeps this useful.** Framed as a bare permission, "you
may ask" reads as "ask whenever anything is unknown" — and a model that asks about
things it could have checked itself is worse than one that never asks, because the loop
exists precisely to save you that round trip. So the permission and the "look it up
first" guard ship together.

It is a labelled section rather than a line appended to 【输出格式】, because it is a
behaviour rule and has to be acted on, not skimmed.

If you would rather it just install what it needs on a machine you own, say so in that
machine's **说明** — the 用户补充 section is declared to outrank the generic rules, so
that is the intended override and no extra switch is needed.

### Why opening an old conversation does not run anything

Auto mode would be dangerous if a conversation's restored history counted as
"new". Opening an old chat whose last reply contains a command would execute it
on the spot.

Rather than trying to discard history — which loses commands whenever the timing
is slightly off — the page tags every command with a **`live`** flag:

| `live` | Meaning |
| --- | --- |
| `true` | The app sent a message and has not seen the answer yet, so this reply is that answer. |
| `false` | Nothing was sent, so this is history that happened to be on screen. |

Commands are always stored and always shown in the terminal, history included, so
you can run one by hand. **Only `live` commands are ever executed automatically.**

The subtle part is *when* the "we sent something" flag is consumed. It must only be
cleared once a command has actually been parsed out of the reply — never on the
first assistant turn that shows up. ChatGPT renders the assistant turn container
while the model is still thinking, so that first sighting is usually an empty
placeholder; clearing the flag there makes the real reply look like history.

And creating a new chat changes the conversation id too, but restores no history:
sending the first message *creates* the conversation, so the URL only picks up an
id after the send. Only the main process can tell that apart from a real
navigation, because only it sees the previous conversation id.

If the app is closed mid-task, the interrupted step is not replayed on restart.
**检查上一条** re-reads the last reply on demand to resume, and counts as live so
auto mode will run what it finds.

### Safety rails

Auto-executing model output on a real machine is genuinely risky, so:

- **Danger list** — disk operations (`format`, `diskpart`, `mkfs`, `dd of=/dev/…`),
  power state (`shutdown`, `reboot`, `Stop-Computer`), recursive deletes
  (`rm -rf`, `Remove-Item -Recurse`, `rd /s`, `del /f /q`), and account/ownership
  changes (`net user`, `userdel`, `takeown`, `chown -R`, `chmod 777`, `reg delete`).
  A hit is stored as `blocked` and printed as a loud red line naming the rule **and
  the exact fragment of the command that matched it**, so a hit can always be checked
  afterwards. Both Windows and Linux forms are listed, because the model writes
  whichever one the prompt asked for.
- **暂停** stops the loop without disarming; **手动执行** makes every command wait.
- **Idle timeout** — a command that produces no output for six minutes is treated as
  stuck and killed, with a thirty-minute absolute ceiling for something that streams
  forever. See [why silence is ambiguous](#why-silence-is-ambiguous) below.
- Every execution is written to the `executions` table, keyed by ChatGPT's assistant
  message id, so a command that already ran is never run again — across restarts.

**In 自动执行 the danger list does not block anything.** That is deliberate: a command
that runs and fails produces output that goes back to the model, which corrects itself,
while blocking produces nothing to correct. 手动执行 and 暂停 are the brakes. The
consequence is stated plainly: opening an old conversation in auto mode runs whatever
command sits in its last reply.

### Why silence is ambiguous

There is no PTY, so "has produced no output for six minutes" is the only signal
available for "this command is stuck". Two very different situations produce it:

1. **It is waiting for input that will never come.** Standard input is empty, so
   `Read-Host`, a `read`, or a password prompt sits there forever.
2. **It is working, and the output is buffered.** `Format-Table` — especially
   `-AutoSize` — `Format-List`, `Format-Wide`, `Sort-Object` and `Group-Object` all have
   to consume their **entire** input before emitting the first line.

The second is not hypothetical. Run against this repo, this was killed with **zero
bytes captured** in its execution record:

```powershell
Get-ChildItem -Recurse -File | Select-String -Pattern '...' | Format-Table -AutoSize
```

It matched 32,448 lines (11,093 files inside `node_modules`) and the first of them
appeared only when the whole pipeline finished. Measured on the same data: without
formatting the first line arrives at 0.56s, with `Format-Table -AutoSize` all five rows
land together at 1.82s.

**This cannot be un-buffered from outside.** `$PSDefaultParameterValues['Format-Table:AutoSize']
= $false` does not override an explicitly passed `-AutoSize` (measured — both buffered),
and the buffering happens inside your own pipeline where the wrapper cannot reach.

So the timeout was widened from two minutes to **six**, and the timeout message names
both causes rather than asserting the interactive one: a model told only "it wanted
input" will rewrite a command that was working. The prompt also asks it not to write
buffering pipelines in the first place (Windows 命令规范 #5, POSIX #6), and to exclude
`node_modules` / `.git` / `out` from whole-repo searches.

Widening it costs nothing more than patience when a command really is stuck — **重置**
kills the session and its entire process tree immediately, and that remains the way to
stop something you already know is stuck.

### Known limits

- **Not a PTY.** `node-pty` would give real terminal semantics but is a native
  module needing an Electron ABI rebuild, and this machine cannot reach GitHub for
  prebuilds (the same reason the database uses the built-in `node:sqlite`).
  Colour codes are stripped; interactive programs will hang until the idle timeout.
  The remote command channel is deliberately a non-PTY `bash -s` for the same class
  of reason — no echo and no prompt means the framing is exact.
- **Encoding.** PowerShell's own output is forced to UTF-8 and the decoder recognises
  UTF-16LE and GBK as well, because an external tool writing to a pipe uses the ANSI
  code page and that cannot be changed from inside the process.
- **Reply completion is a heuristic.** The watcher waits for the reply text to stop
  changing for 800ms, then takes the *last* parseable `{...}` in the message. A
  model that pauses mid-reply for longer than that could have a partial command
  parsed. The message-id dedupe limits the damage, but this is the part most
  likely to need tuning against the real page.
- **Output is truncated** to 4000 chars head + 2000 tail before being sent back.

## Per-machine notes

The **说明** button in the terminal pane's second row opens a small editor. What you
write there is appended to the end of the system prompt, so the model reads it with
every message:

```
【用户补充】
以下是用户针对这台机器补充的说明。**它与上面的通用约定冲突时，以这里为准**：
项目在 /srv/app，用 docker compose 部署
不要动 /data 目录
```

Three things worth knowing:

- **Every machine has its own note.** The local machine has one, and so does each saved
  SSH host. The editor's header names the machine you are writing for, and the button
  carries a ● marker when the machine currently in charge has one set.
- **It is declared to outrank the generic advice**, which is the whole point. The
  sections above it say things like "use apt-get" and "keep intermediate values in
  variables" — right on average, and occasionally wrong on one particular box. That is
  exactly the case worth writing down.
- **It is sent to ChatGPT verbatim, every message**, like the rest of the prompt. This
  is a note to the model, not a private local memo — the editor says so for that reason.

Leaving it empty adds nothing at all: no heading, no blank lines, no noise.

## Settings

The ⚙ button in the toolbar opens the settings dialog.

### ChatGPT proxy

An optional HTTP proxy for reaching chatgpt.com. Enter `http://host:port`, or just
`host:port` — a missing scheme is filled in rather than rejected, and the value you
get back is the normalised one.

The proxy is applied to **the embedded page's session only**:

```ts
session.fromPartition(EMBED_PARTITION).setProxy({ proxyRules: proxy })
```

That scoping is the whole point. The proxy exists to reach chatgpt.com, so routing
everything through it — which `app.commandLine.appendSwitch('proxy-server', …)`
would do — would also drag along traffic that must stay direct, SSH being the
planned example.

Two details worth knowing:

- **Electron does not persist session proxies**, so the setting is stored in the
  app's SQLite database and re-applied on every launch, before the window exists —
  otherwise the page's first requests would already have gone out direct.
- Saving **reloads the page**, because connections that are already open keep using
  the old route. Without the reload the change would look like it did nothing.

Because the embedded page is a native view that paints above the DOM, the dialog
hides it while open (`setEmbedVisible(false)`) — otherwise the dialog would be
behind the page.

### Detected environment

The dialog also shows **执行目标**, the operating system, the shell and the starting
directory — the same facts that go into the prompt sent to ChatGPT. It is not a
static description: it follows whatever machine the terminal is actually pointed at,
so attaching an SSH session replaces it with that host, and disconnecting brings the
local one back. If the probe could not read something, the panel says so rather than
showing a plausible-looking guess.

## SSH

The **SSH** button in the terminal pane header opens the host list. The first time
there is nothing in it — click **新建 / 管理** to fill in a display name, host, port,
username and password.

**Every host you connect to is remembered.** The connection is saved to the app's
SQLite database on the way in, password and all (see [Passwords](#passwords)), so the
list is there again next launch.

### Switching hosts

The list is the switcher, and it is deliberately one click:

| | |
| --- | --- |
| **一键连接** badge | the password is on file — clicking the row connects immediately |
| **需输密码** badge | nothing stored yet — clicking opens the form prefilled, so you type the password once |
| green row with ● | the host the model is currently driving |

Rows are ordered by last use, so the machine you were on a minute ago is at the top.
While a session is live the header button reads **切换** and the list opens over the
current one — no need to disconnect first. **断开当前连接** in the list's footer ends
the session but leaves the transcript on screen; **关闭** in the header clears it and
goes back to the local terminal.

Connecting to a different host drops the previous session, so **switching is not free**
— the new handshake takes as long as it takes.

Once connected the pane switches from the local PowerShell terminal to the remote
shell, and the input box at the bottom sends whole lines to it.

**新建 / 管理** opens the full form, which also lists the saved hosts: click one to
load it into the form, change anything, and connect to save over it. The ✕ beside a
row deletes that host. Editing a host without retyping the password keeps the stored
one, so fixing a port number does not cost you the password.

### Connecting hands the model's commands to that host

**A connected SSH session takes over command execution.** From that moment the model's
commands run on the remote machine, and the prompt injected into ChatGPT is rebuilt to
describe *that* machine — distro, kernel, architecture, shell, starting directory.

**None of that identifies the machine.** The prompt is pasted into a third-party chat
with every message, so it carries only what the model needs in order to write commands:
"Linux, bash, this directory". The host's name, its address, and even the fact that it
is reached over SSH stay on your side — the settings dialog shows them, the prompt
never does.

The two have to move together. Telling the model "you are on Ubuntu" while PowerShell
executes its commands is worse than saying nothing at all: it aims the model at
commands that cannot possibly work. Disconnecting (or 关闭) switches both back to the
local machine and re-probes it.

You can always see which machine is in charge:

- a green **模型命令在此执行** badge in the terminal pane header, or an amber
  **模型命令仍在本地** one if the remote command channel could not be opened;
- **远端执行 · \<host\>** in the status bar;
- **执行目标** in the settings dialog, next to the detected OS and shell.

A connection opens **two channels**, and they are not the same session:

| Channel | Who uses it | Why |
| --- | --- | --- |
| interactive PTY (`client.shell()`) | you, in the left pane | a real terminal — you can type into it |
| `bash -s` (`client.exec()`) | the model | no echo and no prompt, so framing the output is exact |

Because of that, **they do not share a working directory**: `cd /tmp` typed in the pane
does not move the model's shell. The header shows the model's directory separately
(`… · 模型目录 /root`) rather than pretending they are one session.

Command results, output and the probe all still appear in the pane — they are mirrored
into the SSH transcript, so you watch the model work on the remote host in the same
place you would type yourself.

### Proxies: two separate settings

The two are unrelated mechanisms, which is why they are not one field:

| Setting | What it affects | How it works |
| --- | --- | --- |
| **ChatGPT 网页代理** | the embedded chatgpt.com view only | `session.setProxy()` on the embed's Electron session |
| **SSH 代理** | outgoing SSH connections | the app dials an HTTP `CONNECT` tunnel itself and hands the socket to `ssh2` |

`ssh2` uses a plain Node socket, so an Electron session proxy has no effect on it —
the tunnel has to be built by hand. A proxy that reaches chatgpt.com is also not
automatically the right route to a particular server, so each **host** can override
the SSH proxy in its own connect form; leaving that blank follows the setting.

Only **HTTP(S) proxies** are supported (via `CONNECT`). A `socks5://` URL is refused
with an explanation rather than left to time out — most local proxies, including
Clash's mixed port, speak HTTP on the same port, so pointing at that port works.

### Passwords

Stored with Electron's `safeStorage`, which on Windows is DPAPI — the ciphertext is
bound to the user account, so copying the database file elsewhere does not reveal
it. If the OS cannot offer encryption the password is **not stored at all** rather
than written in the clear; you simply retype it next time.

An empty password field means "reuse whatever is saved for this host", so
reconnecting does not wipe a stored password.

### Known limits

- **Host keys are accepted without checking** (`hostVerifier: () => true`). There is
  no known_hosts UI yet, and refusing everything unknown would make the feature
  unusable — but it does mean this does not currently protect against a
  man-in-the-middle.
- **Not a terminal emulator.** ANSI escapes are stripped, and a bare carriage
  return starts a new line rather than overwriting the current one. Full-screen
  programs (`vim`, `top`) will look wrong.
- **The model's shell is `bash -s`, or `sh -s` where bash is missing.** It needs
  nothing beyond POSIX shell, but it is not your login shell: no `.bashrc`, no aliases.
- **Give the model something that needs interactive input and it will hang.** Standard
  input on the command channel is `/dev/null`, so a `read`, a `cat` with no arguments,
  or an installer waiting for a `y` will not receive one. `sudo` that wants a password
  is the common case — the prompt asks the model to stop and tell you instead.
- If the remote command channel dies mid-session it is reopened automatically (up to
  three times). During that instant execution falls back to the local machine; the
  connection is turn-based, so the window is vanishingly small, but it exists.
- `ssh2` is pure JavaScript; its native accelerators are optional and were never
  built here, so no Electron ABI rebuild is involved.

## Security posture

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: false` (required so the
  preload bundle can use Node built-ins).
- `setWindowOpenHandler` and `will-navigate` open external URLs in the system browser
  instead of navigating the app window.
- A `Content-Security-Policy` meta tag ships in `src/renderer/index.html`. It allows
  `'unsafe-inline'` for scripts because the react-refresh preamble that
  `@vitejs/plugin-react` injects during dev is an inline script. It does **not** allow
  `eval`. Tighten this before shipping: scope `connect-src` to the exact API origins
  you call, and drop `'unsafe-inline'` if you disable Fast Refresh for release builds.

## Packaging

`npm run dist:win` produces an NSIS installer in `release/`. Drop `icon.ico` /
`icon.icns` / `icon.png` into `build/` to replace the default Electron icon — see
`build/README.md`.

## Network note

GitHub is unreachable from this machine, so `.npmrc` points Electron's binary downloads at
the npmmirror mirrors. `@electron/get` resolves the mirror from `npm_config_electron_mirror`
first, then `ELECTRON_MIRROR`, so **this only takes effect inside an npm context** — running
`node node_modules/electron/install.js` from a bare shell would still try GitHub and fail.
Use the npm script instead:

```bash
npm run electron:install   # pre-fetch the ~235 MB Electron binary via the mirror
```

If your network can reach `github.com`, delete `.npmrc` (or just those two lines).

> npm 11 warns that unknown `.npmrc` keys "will stop working in the next major version".
> If a future npm drops them, set the variables yourself instead:
> `$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'`

Electron 44 no longer downloads its binary in a `postinstall` hook. The `dev`,
`dev:watch`, and `preview` scripts therefore run `npm run electron:install` first;
the command exits immediately when the binary is already present. You can also run
`npm run electron:install` manually to pre-fetch it before starting another script.

## Troubleshooting

**The app crashes with `TypeError: Cannot read properties of undefined (reading 'isPackaged')`**,
or `electron --version` prints a Node version instead of an Electron version.

`ELECTRON_RUN_AS_NODE=1` is set in your environment. Electron honours it by booting as plain
Node.js, so `require('electron')` returns a path string instead of the Electron API and the
main process dies immediately. This is inherited from any Electron-based parent process
(some IDE/terminal integrations set it).

Clear it before launching:

```powershell
Remove-Item Env:\ELECTRON_RUN_AS_NODE
npm run dev
```

Note it can be present in the real environment block while being absent from
`Get-ChildItem env:`, so verify with `node -p "process.env.ELECTRON_RUN_AS_NODE"`.

