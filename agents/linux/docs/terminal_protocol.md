# 工具端终端协议 v1

本协议由工具端定义。当前实现目标是 Linux x86_64，每台设备最多同时运行 **3 个终端**。每个会话创建独立的 PTY 和交互式 Shell，使用工具进程所属 Linux 用户的权限，无需宿主机运行 sshd，也不连接 22 端口。

本次只实现工具端。现有后端 `/ws/agent` 只处理设备认证、在线状态和心跳，还需要实现客户端到设备的消息路由，Windows 客户端也需要接入本协议后才能端到端操作。

## 连接与责任

```text
Windows 客户端 ── 后端 ── web2term 后台进程 ── PTY ── 本机 Shell
                         一个设备连接承载最多三个终端会话
```

工具沿用主动连接 `/ws/agent` 的 WebSocket：`Authorization: Bearer <token>`、`X-Device-Id`、`X-Device-Name`。HTTP/HTTPS 基础地址分别转换为 WS/WSS。不增加设备公网监听端口。

后端需要认证客户端身份、校验设备归属及是否启用、维护客户端/设备/会话的映射，仅将授权请求转发到对应设备，并将设备响应交给对应客户端。客户端断开时，后端应为该客户端持有的每个会话发送 `terminal_close`。工具检查协议和并发限制，负责 PTY、Shell、输入输出和资源回收。

远程终端拥有运行工具的用户权限；客户端发来的任何输入都可能成为 Shell 命令，因此后端的身份和归属校验必须在转发前完成。工具只信任已配置并成功连接的后端。

## 心跳与能力声明

现有心跳保持原格式，不要求 version 或 session_id：

```json
{"type":"heartbeat"}
```

```json
{"type":"heartbeat_ack"}
```

工具第一次收到心跳确认后发送一次能力声明；重连后重新声明，无需响应：

```json
{
  "version": 1,
  "type": "agent_hello",
  "payload": {
    "protocol": "web2term-terminal",
    "max_terminals": 3,
    "capabilities": ["pty", "terminal_input", "terminal_resize", "terminal_close"]
  }
}
```

现有后端忽略此声明，不影响旧心跳。终端输出与心跳由同一个写入协程发送，心跳拥有独立的优先队列。

## 消息格式

终端消息使用 WebSocket **文本帧中的 JSON**：

```json
{
  "version": 1,
  "type": "terminal_open",
  "session_id": "550e8400-e29b-41d4-a716-446655440001",
  "payload": {"cols": 120, "rows": 30}
}
```

`session_id` 是由后端生成的规范小写 UUID，必须有固定位置的连字符，用于在同一个设备连接上区分终端。每次新建会话使用新 UUID，不能在结束后复用。工具拒绝正在使用的 ID，并保留最近 128 个结束 ID 来拦截迟到请求；后端仍需在更长时间范围内避免复用。

所有终端消息要求 `version=1`；payload 必须为 JSON 对象，工具拒绝不支持的 payload 字段。`terminal_close` 可以省略 payload。每个接收帧最多 64 KiB；输出块和输入解码后每条最多 16 KiB。二进制帧不用于本协议。

| 方向 | type | 含义 |
| --- | --- | --- |
| 后端 → 工具 | terminal_open | 请求新建终端 |
| 工具 → 后端 | terminal_ready | PTY 和 Shell 已创建 |
| 后端 → 工具 | terminal_input | 向指定 PTY 写入原始字节 |
| 工具 → 后端 | terminal_output | 指定 PTY 的输出字节 |
| 后端 → 工具 | terminal_resize | 调整终端行列数 |
| 工具 → 后端 | terminal_resized | 已完成尺寸调整 |
| 后端 → 工具 | terminal_close | 关闭指定会话 |
| 工具 → 后端 | terminal_exit | Shell 已退出且会话资源已回收 |
| 工具 → 后端 | terminal_error | 请求失败或会话处理异常 |

## 打开终端

```json
{"version":1,"type":"terminal_open","session_id":"550e8400-e29b-41d4-a716-446655440001","payload":{"cols":120,"rows":30}}
```

cols/rows 必须为整数；省略或为 0 时分别默认 120 和 30，其他有效范围为 1–1000。`payload:{}` 可以打开默认大小的终端。客户端不能指定 Shell 路径、工作目录、启动命令或环境变量。

工具优先选择本机环境变量 `$SHELL` 中的绝对可执行文件路径，其次 `/bin/bash`、`/bin/sh`。以 `-i` 启动交互式 Shell，初始目录为当前用户的 home，设置 `TERM=xterm-256color`。每个 Shell 都有独立的控制终端和进程会话。

成功响应：

```json
{"version":1,"type":"terminal_ready","session_id":"550e8400-e29b-41d4-a716-446655440001","payload":{"cols":120,"rows":30,"shell":"/bin/bash"}}
```

创建中、运行中、关闭中均占用名额，直到 Shell 回收及读写协程结束才释放。工具在启动 Shell 之前保留名额，因此同时到达的请求也不会突破 3 个。上限是每台设备、每个正在运行的工具实例的总量，客户端各自不能再获得额外名额。

第 4 个请求响应：

```json
{"version":1,"type":"terminal_error","session_id":"550e8400-e29b-41d4-a716-446655440004","payload":{"code":"TERMINAL_LIMIT_REACHED","message":"最多同时运行 3 个终端，请先关闭一个终端"}}
```

## 输入和输出

```json
{"version":1,"type":"terminal_input","session_id":"550e8400-e29b-41d4-a716-446655440001","payload":{"data":"bHMNCg=="}}
```

此例的 Base64 对应 `ls\r\n`。data 必须为标准 Base64 字符串，解码后最多 16 KiB；空字符串合法。工具原样写入 PTY，不将每条输入当作独立的命令执行。Ctrl+C、方向键、Tab、ANSI 转义序列均作为原始终端字节传递；Ctrl+C 的字节为 `0x03`，Base64 为 `Aw==`。

输出使用同样的 data 编码：

```json
{"version":1,"type":"terminal_output","session_id":"550e8400-e29b-41d4-a716-446655440001","payload":{"data":"aGVsbG8NCg=="}}
```

输出可能包含回显、颜色、控制字符和跨消息分割的 UTF-8 序列。客户端应将解码后的字节按接收顺序交给支持 ANSI 的终端组件，并使用连续的字节解码状态。PTY 已合并 stdout 和 stderr。

同一会话的输入顺序和输出顺序各自保留，不同会话可交错，后端按 session_id 路由。工具不会记录输入命令或输出正文。

## 调整大小

```json
{"version":1,"type":"terminal_resize","session_id":"550e8400-e29b-41d4-a716-446655440001","payload":{"cols":132,"rows":43}}
```

cols/rows 均需为 1–1000 的整数，此消息不使用默认值。工具通过 PTY ioctl 调整大小，前台程序由终端机制接收尺寸变化通知。成功响应：

```json
{"version":1,"type":"terminal_resized","session_id":"550e8400-e29b-41d4-a716-446655440001","payload":{"cols":132,"rows":43}}
```

## 关闭、退出和断线

```json
{"version":1,"type":"terminal_close","session_id":"550e8400-e29b-41d4-a716-446655440001","payload":{}}
```

关闭一个终端不影响另两个。关闭请求立即标记会话结束，随后终止 Shell 和当前前台作业、关闭 PTY、等待回收；Shell 2 秒内未退出则尝试强制结束 Shell。已经主动脱离终端的 `nohup`/守护进程不属于本版的进程清理保证。

正常 `exit` 或显式关闭后发送：

```json
{"version":1,"type":"terminal_exit","session_id":"550e8400-e29b-41d4-a716-446655440001","payload":{"exit_code":0,"reason":"shell_exit"}}
```

exit_code 是 Shell 退出码；被信号终止或尚未启动即取消时通常为 -1。被信号终止时附加 signal 字符串。reason 的值包括 `shell_exit`、`closed`、`input_backpressure`、`input_error`、`output_error`；断线/连接关闭在本地日志中记录 `connection_lost`。输出与 terminal_exit 使用同一发送队列，退出消息不会越过该会话已经排队的输出。收到 terminal_exit 后，原会话已释放名额，新建仍应使用新 UUID。

启动失败时返回 `TERMINAL_START_FAILED` 并释放名额，不发送 terminal_ready；客户端应将该会话标记为创建失败。错误码本身不能一律视为现有会话退出，例如格式错误、重复打开和并发上限错误不会关闭已存在的终端。

工具与后端断线、心跳失败、登录到期或 `web2term stop` 时会回收所有终端。后台进程重连后不会恢复此前 Shell。连接已经丢失时不能再发送 terminal_exit，因此后端需要在设备连接关闭时结束相关客户端会话，客户端显示断开并显式新建会话。

## 错误码

| code | 含义/处理 |
| --- | --- |
| INVALID_SESSION_ID | session_id 不是规范小写 UUID，响应不回显无效 ID |
| UNSUPPORTED_VERSION | 终端协议版本不支持 |
| UNSUPPORTED_MESSAGE | 未定义的终端消息类型 |
| INVALID_PAYLOAD | 缺少 payload/data、类型错误或包含不支持的字段 |
| INVALID_SIZE | 行列数超出范围或尺寸格式错误 |
| INVALID_INPUT | Base64 错误或输入超过 16 KiB |
| SESSION_EXISTS | 同 ID 会话已存在 |
| SESSION_CLOSED | 最近已经结束的 ID，需使用新 UUID |
| SESSION_NOT_FOUND | 输入/调整/关闭请求的会话不存在 |
| SESSION_CLOSING | 会话正在关闭，停止向其发送输入 |
| TERMINAL_LIMIT_REACHED | 已占用 3 个名额，先关闭一个 |
| TERMINAL_START_FAILED | 本机 Shell/PTY 创建失败，检查运行日志 |
| INPUT_BACKPRESSURE | 输入队列满，当前会话关闭 |
| TERMINAL_INPUT_FAILED | PTY 写入或调整尺寸失败，当前会话关闭 |
| TERMINAL_OUTPUT_FAILED | 输出读取/排队失败，当前会话关闭 |

## 队列、日志与后端接入

每个终端有 16 条输入/尺寸操作的队列，单条输入最多 16 KiB。队列满时只关闭该会话。设备连接共享 64 条输出队列，排队最多等待 5 秒，超时关闭产生该输出的会话；连接写入超时或控制消息队列满会关闭连接，随后按现有策略重连。控制队列为 32 条，心跳另有优先队列；正在执行的一次 WebSocket 写入仍受 10 秒写入超时限制。

`web2term status` 显示 `终端会话：n/3`，创建中和关闭中也计入 n。运行日志保留会话 ID、事件、终端错误码、退出码及安全分类的底层错误，便于定位失败阶段。输入、命令、输出、验证码、Token 和消息正文均不记录。

后端接入至少需要：识别 agent_hello 能力、授权后路由终端消息、维护最多多个会话的映射、处理客户端断开及设备断开、保证每个会话消息有序。现有 user_device 表里的单一 terminal_session_id 不能完整表达三个并发会话，后续应单独保存会话记录或在内存维护会话映射；本次未修改后端代码或数据库。
