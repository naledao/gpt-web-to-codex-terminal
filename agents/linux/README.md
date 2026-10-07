# web2term Linux 工具

面向 Linux x86_64 的 Go 命令行工具，提供交互式的 `web2term set server`、邮箱验证码登录命令 `web2term login`，以及连接服务端并承载远程终端的后台命令 `web2term run`。每台设备最多同时运行 3 个 PTY 终端，不依赖宿主机 sshd。

## 配置后端请求地址

```text
$ web2term set server
按 Ctrl+C 取消。
请输入后端请求地址（例如 https://example.com:8443）：http://127.0.0.1:8080
后端请求地址已保存：http://127.0.0.1:8080
配置文件：/home/user/.config/web2term/config.json
```

地址在提示出现后输入，不作为命令参数传入。支持 `http://`、`https://`、端口、IPv6 和后端路径，如 `https://example.com:8443/backend/`。地址需要显式填写协议，不接受内嵌用户名/密码、查询参数、片段或无效端口。

再次执行会显示当前地址；直接回车保留它。首次设置时空输入会提示重新输入。Ctrl+C 或输入结束可取消。地址校验只检查格式，保存时不发起网络请求。

配置示例：

```json
{
  "server_url": "http://127.0.0.1:8080"
}
```

Linux 配置路径为 `$XDG_CONFIG_HOME/web2term/config.json`，没有设置 `XDG_CONFIG_HOME` 时使用 `~/.config/web2term/config.json`。路径与当前工作目录无关，配置属于执行命令的用户。文件权限为 `0600`，新建工具配置目录权限为 `0700`。

更新地址会保留其他 JSON 配置字段；切换到不同后端时清除旧后端的 `login` 信息，重新保存相同地址时保留登录信息。现有文件损坏时报告错误并保留原文件；正常保存先写入同目录临时文件，再替换配置文件。

## 邮箱验证码登录

先通过 `web2term set server` 配置后端基础地址，再执行：

```text
$ web2term login
诊断日志：/tmp/web2term-login-<时间>-<随机编号>.log
登录后端：https://example.com:8443
按 Ctrl+C 取消。
请输入登录邮箱：user@example.com
正在发送登录验证码……
验证码已发送，请查看邮箱。验证码错误或过期后，可取消并重新登录以获取新验证码。
请输入 6 位验证码：123456
正在登录……
登录成功：user@example.com
用户 ID：usr_783921094821
登录有效期至：2026-10-08 04:00:00（UTC）
登录信息已保存：/home/user/.config/web2term/config.json
```

按照 `backend/docs/user_login_api.md`，命令依次调用 `POST /api/user/login/code`（成功为 204）和 `POST /api/user/login`（成功为 200）。配置的地址可带后端上下文路径，例如 `https://example.com/backend` 对应 `/backend/api/user/login`，无需在配置地址中追加登录接口路径。

邮箱或验证码格式错误时重新提示。验证码错误或失效（`LOGIN_CODE_INCORRECT`）时可再次输入；获取新验证码需要取消并重新执行登录。请求超时为 30 秒，不自动重发邮件或登录请求，不跟随后端重定向。登录响应缺少 Token、有效期或用户信息时拒绝保存。

成功后在同一个配置文件的 `login` 字段保存：

- `server_url`：本次登录对应的后端地址。
- `access_token`、`token_type`、`expires_in_seconds`：后端返回的访问凭据和有效期。
- `logged_in_at`、`expires_at`：UTC 登录时间和按返回有效期计算的到期时间。
- `user`：完整用户信息，包括 `publicId`、`email`、`nickname`、可空的 `avatarUrl` 和 `role`。

Token 保存到权限为 `0600` 的本地 JSON 配置中，成功输出只显示用户和有效期，不打印 Token。邮箱验证码不保存。请求失败、取消、配置损坏或登录期间后端地址变更时，不覆盖本次操作之外的配置。接口文档未提供刷新接口，因此到期后重新运行 `web2term login`。

## 登录诊断日志

每次执行 `web2term login` 自动生成一个独立日志，并在输入邮箱前显示完整路径。不需要额外参数。日志使用系统临时目录：Linux 通常为 `/tmp`，设置了 `TMPDIR` 时使用该目录；文件名为 `web2term-login-<UTC时间>-<随机编号>.log`，文件权限为 `0600`。

日志按行保存 JSON，包括 UTC 时间、登录阶段、请求编号、POST 地址、代理地址（移除账号密码、路径和查询参数）、请求超时、连接建立、连接复用、请求发送、响应接收、HTTP 状态、耗时、响应字节数、已知接口错误码和配置保存结果。`phase=send_code` 表示发送验证码，`phase=login` 表示提交验证码。

网络错误保留类别和底层错误类型链，区分 EOF、响应未收全、连接重置、连接拒绝、DNS、超时和 TLS 问题，以及重复/不支持的 Transfer-Encoding、无效/冲突的 Content-Length 等 HTTP 响应解析错误。未知错误保留类型信息；可能含响应头、响应正文或凭据的原始错误文本不会直接写入。邮箱输入、验证码、Token、请求/响应正文和 HTTP 头均不记录，未知接口错误码也不原样记录。

例如，日志中先出现发送验证码的 `request_finished` / `http_status=204`，再出现登录的 `request_failed` / `error.kind=eof`，表示发码成功，但登录请求没有收到完整的 HTTP 响应。`response_read_failed` 表示已收到响应头，读取响应正文时失败。

复现后查看终端显示的日志文件：

```bash
cat "/tmp/web2term-login-<实际文件名>.log"
```

将该日志内容交给智能体分析即可，不需要提供保存 Token 的 `config.json`。每条记录同步写入并刷新，按 Ctrl+C 后已经写出的记录仍然保留，但可能没有 `login_finished`。日志创建或写入失败只给出警告，登录流程继续；临时日志不自动清理，排查完成后可手动删除，系统临时目录清理也可能移除它们。

## 连接服务端

完成地址配置和登录后，使用同一 Linux 用户执行：

```bash
web2term run
```

该命令启动独立的后台进程，完成初始化后立即返回命令提示符。关闭当前终端、退出 Shell 或断开启动它的 SSH 连接后，后台进程继续保持通信。无需额外使用 `&` 或 `nohup`。

使用同一 Linux 用户和配置目录管理后台进程：

```bash
web2term status    # 查看进程、连接状态、终端数量 n/3 及日志路径
web2term stop      # 关闭终端会话、WebSocket 并停止后台进程
```

`run` 只确认后台进程已启动；设备是否成功连接并收到心跳确认由 `status` 显示。状态包括正在连接、已在线、等待重连和未运行。重复执行 `run` 会显示现有实例的信息，不会再创建连接。后台进程异常退出后，状态查询会显示未运行并保留上次日志路径及已记录的错误，再次执行 `run` 可以重新启动。

后台运行不自动安装开机启动，也不在进程崩溃或机器重启后自动拉起。网络断线重连由存活的后台进程处理。修改后端地址或更新登录凭据后，应执行 `web2term stop`，再执行 `web2term run` 读取新配置。

输出示例：

```text
后台进程已启动（PID：12345）。
后台状态：正在连接服务端
进程 PID：12345
终端会话：0/3
设备名称：my-linux
设备 ID：550e8400-e29b-41d4-a716-446655440000
连接地址：wss://example.com:8443/ws/agent
登录有效期至：2026-10-08 04:00:00（UTC）
运行日志：/tmp/web2term-run-<时间>-<随机编号>.log
后台输出日志：/tmp/web2term-daemon-<时间>-<随机编号>.log
关闭当前终端后继续运行。查看状态：web2term status；停止：web2term stop。
```

`web2term status` 显示“设备已在线，服务端已确认心跳”时，才表示当前后台连接已获得心跳确认。后台进程使用独立会话，并将标准输入连接到 `/dev/null`、标准输出和错误输出写入私人日志文件。进程锁、状态文件与本机 Unix 控制套接字放在配置文件所在目录；状态和套接字权限为 `0600`。停止命令通过控制套接字发送请求并等待进程退出，不会根据可能被系统复用的旧 PID 杀进程。

工具直接对接当前后端的 `/ws/agent`。配置为 `http://` 时连接使用 `ws://`，`https://` 使用 `wss://`；保留后端上下文路径，例如 `https://example.com/backend` 对应 `wss://example.com/backend/ws/agent`。握手携带 `Authorization: Bearer <登录Token>`、`X-Device-Id` 和 `X-Device-Name`，不跟随重定向。

首次运行会在现有配置中保存 `device_id` 和 `device_name`，同时保留登录及其他字段。设备 ID 为 UUID，以后启动和重连都使用相同的 ID；现有 ID 损坏时提示修复，认证被拒绝时也不会重新生成 ID。设备名称默认取主机名；无法用作 HTTP 请求头的名称回退为 `agent-<UUID前8位>`。手动修改 `device_name` 时需使用 1 到 100 个可打印 ASCII 字符。

连接成功后立即发送文本消息 `{"type":"heartbeat"}`，收到 `{"type":"heartbeat_ack"}` 后显示设备在线。此后每次收到确认后等待 20 秒发送下一次心跳。握手、单次写入和等待心跳确认分别最多等待 10 秒；超时后关闭当前连接。连接期间持续读取服务端消息和 WebSocket 控制帧。

网络中断、心跳超时及可恢复的服务端错误会自动重连，等待时间依次为 1、2、4、8 秒，最多 30 秒，并加入最多 20% 的提前随机偏移。重连收到有效心跳确认后重置等待时间。认证失败（401）、设备禁用或不属于当前用户（403）、错误地址（404）、协议错误以及服务端拒绝设备（关闭码 1008）会停止并显示原因。服务端正常关闭连接（1000）也会停止；当前后端在同一设备的另一实例上线时使用该关闭码，以免两个实例反复争抢连接。

登录到期时停止连接并提示重新执行 `web2term login`，登录后再执行 `web2term run`。命令启动前会检查登录信息有效性及其对应的服务端，不会使用旧后端的 Token 连接新地址。

当前后端的三个 WebSocket 文件只提供设备认证、上线/离线和心跳处理。工具端现已实现终端协议，但还需要后端消息转发和 Windows 客户端接入，才能从客户端实际操作终端。本次没有修改后端或桌面端。对接格式见 [终端协议 v1](docs/terminal_protocol.md)。

后台初始化时创建 `web2term-run-<UTC时间>-<随机编号>.log`，位于系统临时目录（Linux 通常为 `/tmp`，或 `TMPDIR`），权限为 `0600`，并在终端打印路径。日志同步记录设备 ID、连接地址、连接尝试、HTTP 状态、关闭码、心跳确认耗时、超时、重连等待、终端会话 ID、终端错误码、退出码和退出结果。日志不记录 Token、完整请求头、消息正文、输入命令、终端输出或关闭原因原文；底层错误使用安全的分类信息。另有 `web2term-daemon-<UTC时间>-<随机编号>.log` 保存后台输出和启动错误，权限同为 `0600`。初始化时无法创建日志会报告启动失败；运行中的诊断日志写入失败会警告并继续运行。临时日志不自动清理，路径可以通过 `web2term status` 再次查询。测试异常时提供这些日志即可，无需提供包含 Token 的配置文件。

## 远程终端

`run` 启动后等待后端转发 `terminal_open`，按会话 ID 创建独立 PTY 和交互式 Shell。创建中和关闭中的会话也占用名额，第 4 个请求返回 `TERMINAL_LIMIT_REACHED`，不启动额外 Shell。已释放名额可以用新的会话 ID 再次打开终端。

默认终端大小为 120 列、30 行，支持输入、实时输出、Ctrl+C、方向键、Tab、ANSI 颜色、窗口尺寸调整和独立关闭。每条输入/输出使用 Base64 携带原始字节，解码后最多 16 KiB。每个终端分别处理输入，心跳使用独立优先队列；输入积压只关闭该会话。

Shell 以运行工具的 Linux 用户权限启动，优先使用本机 `$SHELL`，然后尝试 `/bin/bash`、`/bin/sh`，初始目录为该用户 home。远程请求不能指定启动 Shell、目录、命令或环境变量。后端负责客户端认证、设备归属校验和会话路由，工具端负责协议校验及并发限制。

连接中断、登录到期或执行 `web2term stop` 时，工具会关闭 PTY 并回收会话 Shell；重连后需要新建终端，不恢复此前会话。主动脱离终端的 `nohup`/守护进程不属于本版的清理保证。后端必须在客户端断开时关闭该客户端持有的会话，避免持续占用设备名额。

## 构建与安装

当前版本的发布目标为 Linux x86_64（Go 架构名称为 `amd64`）。使用 Go 1.27.0 或以上版本，从当前目录构建：

```bash
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -o dist/linux-amd64/web2term ./cmd/web2term
```

Linux 安装到 PATH 中的目录后，即可在任意工作目录使用：

```bash
sudo install -m 0755 dist/linux-amd64/web2term /usr/local/bin/web2term
web2term set server
```

升级已经在后台运行的版本时，先用原来执行 `run` 的用户运行 `web2term stop`，安装新二进制后，再用同一用户运行 `web2term run`。仅替换磁盘上的文件不会让已有进程自动加载新功能。安装使用 sudo 不代表运行时也需要 sudo；切换运行用户会切换配置、设备身份和 Shell 权限。

从 Windows PowerShell 编译 Linux AMD64 版本：

```powershell
$env:GOOS = 'linux'
$env:GOARCH = 'amd64'
$env:CGO_ENABLED = '0'
go build -trimpath -o dist/linux-amd64/web2term ./cmd/web2term
```

## 用户运行检查

按照仓库约定，智能体只构建，不执行测试或工具的交互操作。

在仓库根目录由用户运行：

```bash
node tools/diag/web2term-server-check.cjs
```

默认检查运行配置、登录、连接循环、后台状态和终端管理的 Go 回归测试。HTTP/WebSocket 使用内存假传输，终端使用内存管道和假进程，不创建真实 PTY 或 Shell。覆盖 3 个名额、第 4 个拒绝、创建/关闭期间占用、关闭释放、独立输入/尺寸/输出、退出顺序、断线清理、输入积压、状态数量和日志隐私。配置样本均在临时目录，不读写真实配置，不联网，也不发送邮件。后台控制检查使用内存请求，不启动后台进程；Linux 额外检查进程锁与旧 PID 处理。需要本机 Go 模块缓存中已有 `github.com/coder/websocket v1.8.15` 和 `github.com/creack/pty v1.1.24`（正常构建会下载）；检查禁止下载模块。日志写入系统临时目录下的 `gpt-login-diag/web2term-server-check-<timestamp>.log`，可交给智能体分析。

在具备 Go 和 Node.js 的 Linux x86_64 测试机，由用户明确启用真实 PTY 检查：

```bash
node tools/diag/web2term-server-check.cjs --pty
```

`--pty` 额外在临时目录启动 `/bin/sh -i`，检查终端字节输出、`stty size`、窗口调整及关闭是否能解除阻塞读取；不访问真实后端，不启动守护进程。默认命令不会继承环境中的真实 PTY 测试开关。两种检查都需要用户运行，构建通过不表示这些测试已通过。

手动验收：运行 `web2term set server`，输入一个有效地址；再次运行后直接回车，确认保留原地址；输入无效地址后再输入有效地址，确认重新提示且成功保存；取消输入，确认原配置不变。

实际登录由用户运行 `web2term login` 并操作邮箱。确认收到验证码、成功保存登录信息、错误验证码可重试、取消/失败保留旧登录信息、切换后端清除旧登录信息。真实邮件发送与后端登录行为等待用户验收。

实际连接由用户运行 `web2term run`：确认命令返回且 `web2term status` 随心跳确认变为在线；关闭终端或 SSH 后，从新终端查询仍在运行，服务端心跳时间继续推进；重复 `run` 保持相同 PID 和 UUID；`web2term stop` 后设备离线，再次启动保持相同 UUID；暂时断网或服务端重启后重连。认证失败、禁用设备、心跳超时与 Token 到期的真实行为等待用户验收。升级此前的前台版本时，先在旧终端按 Ctrl+C 停止旧进程，再安装新版；旧版进程不支持本版的控制套接字。

终端端到端验收需等待后端和客户端接入协议：打开 3 个会话，确认各自输入输出和目录互不干扰；第 4 个请求应被拒绝；关闭一个后以新 ID 再打开；调整窗口、输入 Ctrl+C 和 `exit`；断开设备连接确认全部会话结束；重连后手动打开新会话。状态中的终端数量应随创建和关闭变化。
