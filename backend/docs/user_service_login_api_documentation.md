# 用户服务邮箱验证码登录 API 接口文档

本文档适用于外部应用、聚合微服务、BFF（Backend For Frontend）或网关接入 `user-service` 的邮箱验证码登录流程。

---

## 1. 登录交互时序概述

完整登录流程由两个端点协作完成：

```
[调用方/前端/客户端]               [user-service]                 [邮件服务/邮箱]
        |                                |                             |
        |  1. POST /api/user/login/code  |                             |
        |------------------------------->|  生成 6 位验证码并存储缓存    |
        |                                |-- 发送验证码邮件 ----------->|
        |  2. HTTP 204 No Content        |                             |  用户收到邮件
        |<-------------------------------|                             |
        |                                                              |
        |  3. 用户查收验证码并在调用方界面输入                              |
        |                                                              |
        |  4. POST /api/user/login (email + code)                      |
        |------------------------------->|                             |
        |                                |-- 校验验证码与用户状态        |
        |                                |-- 签发 JWT Access Token     |
        |  5. HTTP 200 (返回 Token 及用户资料)                           |
        |<-------------------------------|                             |
```

---

## 2. 接口详细定义

### 2.1 发送登录验证码

向指定的目标邮箱发送一次性 6 位数字验证码。

- **请求路径**：`POST /api/user/login/code`
- **Content-Type**：`application/json`
- **鉴权要求**：无需鉴权（公开接口）

#### 请求体参数

| 参数名 | 类型 | 必填 | 格式/约束 | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| `email` | String | 是 | 合法邮箱格式 | 目标用户邮箱（不区分大小写，内部会自动转小写去除两端空格） |

#### 请求体示例

```json
{
  "email": "user@example.com"
}
```

#### 响应说明

- **HTTP 状态码**：`204 No Content`（发送成功时无响应体包体）

---

### 2.2 验证码校验登录

提交邮箱与收到的 6 位数字验证码，完成身份验证并获取系统颁发的访问令牌（JWT）。如果用户首次登录，系统会自动初始化创建用户基础数据。

- **请求路径**：`POST /api/user/login`
- **Content-Type**：`application/json`
- **鉴权要求**：无需鉴权（公开接口）

#### 请求体参数

| 参数名 | 类型 | 必填 | 格式/约束 | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| `email` | String | 是 | 合法邮箱格式 | 登录邮箱 |
| `code` | String | 是 | 6 位纯数字字符串 | 邮件中收到的一次性验证码 |

#### 请求体示例

```json
{
  "email": "user@example.com",
  "code": "123456"
}
```

#### 响应说明

- **HTTP 状态码**：`200 OK`
- **响应体类型**：`application/json`

#### 响应字段结构

| 字段名 | 类型 | 描述 |
| :--- | :--- | :--- |
| `accessToken` | String | JWT 访问凭证，后续用于请求头认证 |
| `tokenType` | String | 令牌类型，固定为 `Bearer` |
| `expiresInSeconds` | Long | 令牌有效剩余秒数 |
| `user` | Object | 当前登录用户的简要公开资料 |
| `user.publicId` | String | 用户对外的公开唯一标识（雪花/UUID） |
| `user.email` | String | 用户登录邮箱 |
| `user.nickname` | String | 显示昵称 |
| `user.avatarUrl` | String | 头像图片链接（可能为 null） |
| `user.role` | String | 用户角色：`USER`、`ADMIN` 等 |

#### 响应体示例

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "tokenType": "Bearer",
  "expiresInSeconds": 86400,
  "user": {
    "publicId": "usr_783921094821",
    "email": "user@example.com",
    "nickname": "user@example.com",
    "avatarUrl": "https://cdn.example.com/avatars/default.png",
    "role": "USER"
  }
}
```

---

## 3. 错误响应与状态码

发生业务异常或校验失败时，服务返回统一的错误 JSON 响应：

```json
{
  "code": "ERROR_CODE",
  "message": "错误提示信息"
}
```

### 常见业务错误码一览

| HTTP 状态码 | 业务 Code | 说明 / 触发条件 |
| :--- | :--- | :--- |
| `400 Bad Request` | `INVALID_REQUEST` | 请求 JSON 为空或字段缺失 |
| `400 Bad Request` | `INVALID_EMAIL` | 邮箱格式不符合规范 |
| `400 Bad Request` | `INVALID_LOGIN_CODE` | 验证码格式非 6 位数字 |
| `401 Unauthorized` | `LOGIN_CODE_INCORRECT` | 验证码错误或已超时失效 |
| `401 Unauthorized` | `USER_NOT_AVAILABLE` | 账号不存在或当前状态不可用 |
| `403 Forbidden` | `USER_DISABLED` | 账号已被拉黑、禁用或逻辑删除 |
| `429 Too Many Requests` | `LOGIN_CODE_TOO_FREQUENT`| 发送验证码过于频繁（受防刷重发时间窗口限制） |
| `500 Internal Error` | `LOGIN_CODE_SEND_FAILED` | 邮件下游服务异常，验证码投递失败 |

---

## 4. 后续调用：携带 Token 访问

登录成功拿到 `accessToken` 后，调用方或下游服务在调用受保护端点时需在 HTTP 请求头添加：

```http
Authorization: Bearer <accessToken>
```

其他内部服务若需校验此令牌的合法性与身份，可调用内部内省接口：
- `POST /api/user/auth/introspect`
- Header: `Authorization: Bearer <accessToken>`