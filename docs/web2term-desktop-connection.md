# 桌面端 web2term 连接

web2term 是现有会话右侧终端的一种执行通道。连接设备后仍使用原来的会话界面、聊天平台、命令输入区、执行记录、输出区和结果回传流程。设备上的工具提供 PTY；设备不需要运行 SSH 服务。

## 使用方式

1. 在 **设置 → 后端服务** 登录，与设备工具使用同一个后端和账号。
2. 点击会话栏 **＋ → web2term 连接**，打开 SSH 风格的 **我的设备** 弹框。弹框只显示设备列表、状态、刷新和连接按钮。
3. 点击设备的 **连接**。请求被接受后进入普通会话。右侧终端标识为 `web2term · 设备名称`，原有聊天区域保持可用。
4. 等待右侧输出 **设备终端已就绪** 和环境探测结果。直接输入命令，或使用现有模型指令执行流程；输出、退出码和模型回传都使用原来的逻辑。
5. 使用 **＋ → web2term 连接** 再选同一设备，可以创建其他普通会话，每个会话对应一个独立 Shell，最多同时运行 3 个。尚未就绪或已断开的同设备会话会优先恢复。关闭、创建过程也占用名额；工具确认退出后才能复用。
6. **中断** 会结束当前设备 PTY，等待工具确认后重建；**重置** 会清空当前输出并重建 Shell。断线后点击右侧 **重新连接**。重建时尝试恢复该会话上一次已确认的工作目录。
7. **关闭** 会取消当前任务、结束此会话的设备 PTY，保留会话、设备绑定和终端历史，关闭后不自动重建。输入区禁用，点击 **重新连接** 可恢复且保留历史；只有在线时点击 **重置** 才清空历史。同设备还有其他活动终端时保留共享通道；最后一个终端确认关闭后，主动断开桌面 WebSocket。

切换会话不会关闭远端终端。删除普通会话会尽力关闭它自己的 PTY，不影响同设备的其他活动会话；没有其他活动终端时关闭设备通道，已关闭但保留在侧栏的会话不会占用通道。应用重启后保留会话和设备绑定，点击 **重新连接** 或重新选择设备恢复。重启不会自动连接设备或启动本机 Shell。每个绑定包含后端地址、账号公开 ID 和设备 ID，使用其他后端或账号时不会连接旧绑定。

目前应用共享一条桌面 WebSocket；选择另一台设备会替换当前通道，原设备会话保留历史并显示断开。恢复它需要重新连接。后端和工具的行为沿用当前实现。

## 终端执行

主进程的 `Web2termShell` 将工具 PTY 适配为现有 `CommandRunner` 的执行 Shell。每个普通会话持有自己的协议 `session_id`，手动命令和模型命令共用一个持久 Shell，目录、变量和函数跨命令保留。

收到工具的 `terminal_ready` 后，关闭 PTY 输入回显和规范行缓冲，启动无提示符的 Bash；没有 Bash 时使用 `/bin/sh`。初始化确认后才允许输入。命令沿用完成标记、退出码和当前目录的帧协议；跨 WebSocket 消息的 UTF-8 和完成标记按流解析。该流程与原来的命令终端一致，命令标准输入为空，适合命令执行和结果回传。

右侧继续使用现有文本终端，不新增 xterm 页面、终端标签工作台或常驻 web2term 导航项。全屏交互程序、SFTP 上传/浏览、Git 文件界面和 `read_files` 附件传输尚未接入该通道；可通过命令读取远端文件和运行 git。web2term 会话不会向模型声明尚未支持的附件工具。

连接失败、Shell 未就绪、账号变化和网络断线都会保留设备执行器；手动指令反馈不可用，模型指令保持待执行。它们不会自动回退到本机 PowerShell。

## 现有接口与协议

设备接口：

```text
GET <后端地址>/api/user/devices
Authorization: Bearer <当前登录 Token>
```

使用后端 `UserDeviceController#listDevices` 返回的 `deviceId`、`deviceName`、`enabled`、`onlineStatus`。包含离线、禁用设备；禁用设备不能点击连接。设备查询只允许主窗口主框架请求，校验格式、大小和账号切换后的过期响应，凭据保留在主进程。

桌面 WebSocket：

```text
<后端地址转换成 ws/wss>/ws/desktop
Authorization: Bearer <当前登录 Token>
X-Desktop-Client-Id: <持久桌面 UUID>
X-Agent-Id: <选定设备 UUID>
```

保留后端部署路径和 IPv6，禁止跟随重定向，校验 TLS 证书。握手超时 10 秒。握手完成只表示桌面到后端已连接；工具确认终端创建和 Shell 初始化后才表示终端可用。

后端在设备已绑定客户端时拒绝握手，返回 HTTP 409。桌面端显示“设备已被占用，无法建立连接。请先断开已有的客户端连接，再重试。”失败原因显示在设备弹框或已经打开的终端中；终端重新连接也沿用此提示。即使拒绝发生在进入会话的过程中，设备弹框也会读取最新连接错误，避免显示通用错误覆盖占用原因。握手拒绝日志沿用 `handshake_rejected` 事件，记录 HTTP 状态，不读取或记录响应正文。

使用 [工具终端协议 v1](../agents/linux/docs/terminal_protocol.md)：`terminal_open`、`terminal_input`、`terminal_close` 及相应 ready/output/exit/error 消息。会话 ID 由桌面主进程生成 UUID v4；后端透明转发。输入为 Base64，按最多 4 KiB 字节分包，输出按流解码。文本命令区使用固定 PTY 尺寸 120×30。

设备创建和关闭确认均等待 10 秒。创建超时后尝试关闭；迟到确认不会恢复已取消的终端。单个终端关闭超时且仍有其他活动终端时，保留其名额并提示再次关闭或重新连接。如果所有会话都已请求关闭，关闭超时或发送失败后主动断开桌面通道，并明确显示设备尚未确认关闭。正常退出和账号切换会尽力发送关闭请求；网络故障时请求是否到达仍取决于当前后端和工具。

当前后端在 `DesktopWebSocketHandler.afterConnectionClosed` 中删除桌面 `currentSessions` 的对应 Session，并调用 `AgentDesktopClientRegistry.unbind` 删除 `agentId → desktopClientId` 绑定。单独发送 `terminal_close` 只结束一个终端，保留共享通道的映射。关闭桌面通道不会断开工具的 `/ws/agent` 长连接，设备仍可保持在线。异常掉线需要后端检测到连接已关闭后才会执行清理；现有后端的桌面断线回调未通知工具结束 PTY，因此无法通过客户端改动保证突发断网时的远端进程回收。

后端仍有一个切换设备的解绑时序问题：相同 `desktopClientId` 的新 Session 若先替换旧 Session，旧连接关闭时的 `currentSessions.remove(desktopClientId, oldSession)` 会返回 `false`，旧设备对应的 `agentId → desktopClientId` 解绑也被跳过。正常单设备主动关闭会走已有清理逻辑，但不能据此保证切换设备或账号时所有旧绑定都已回收。本次未修改后端。

## 日志与验收

连接日志：

```text
%TEMP%\gpt-login-diag\web2term-desktop-connect-<timestamp>-<uuid>.log
```

悬停右侧终端设备名称可查看设备 ID、连接反馈和日志路径。日志同步追加连接、握手、终端创建/退出/超时、Shell 初始化/就绪/失败和固定错误分类；不记录 Token、邮箱、命令、输入输出或响应正文。设备查询日志沿用 `web2term-desktop-login-*.log`。

用户可运行以下离线诊断，不启动 Electron、Shell 或网络连接：

```powershell
node tools/diag/web2term-desktop-connect-check.cjs
node tools/diag/web2term-terminal-check.cjs
node tools/diag/web2term-workspace-check.cjs
```

实际验收由用户运行 `npm run dev`，按上面的使用方式检查直接输入、模型执行及回传、三个独立会话、中断、重置、关闭、断线、重启恢复和账号切换。关闭最后一个终端后，后端应出现 `Desktop disconnected` 日志；工具仍应保持在线。详细检查见 [诊断说明](../tools/diag/README.md)。交付状态为 **构建通过，等待测试**。
