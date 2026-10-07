# 用户登录接口文档

## 1. 发送登录验证码

对应方法：`xyz.kangnasi.web2termback.controller.UserLoginController#sendLoginCode`

### 接口



POST /api/user/login/code



用于向指定邮箱发送一次性 6 位数字登录验证码。当前接口无需携带 Token。

### 请求头



Content-Type: application/json



### 请求参数

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `email` | String | 是 | 用户邮箱地址 |

### 请求示例



{
  "email": "user@example.com"
}



### 成功响应



204 No Content



发送成功时无响应体。

### 常见错误

| HTTP 状态码 | Code | 说明 |
| --- | --- | --- |
| 400 | `INVALID_REQUEST` | 请求参数缺失 |
| 400 | `INVALID_EMAIL` | 邮箱格式错误 |
| 429 | `LOGIN_CODE_TOO_FREQUENT` | 验证码发送过于频繁 |
| 500 | `LOGIN_CODE_SEND_FAILED` | 邮件发送失败 |

错误响应格式：



{
  "code": "INVALID_EMAIL",
  "message": "错误提示信息"
}



---

## 2. 邮箱验证码登录

对应方法：`xyz.kangnasi.web2termback.controller.UserLoginController#login`

### 接口



POST /api/user/login



提交邮箱和收到的 6 位验证码进行登录。登录成功后返回 JWT Access Token 和用户信息。

### 请求头



Content-Type: application/json



### 请求参数

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `email` | String | 是 | 登录邮箱 |
| `code` | String | 是 | 6 位数字验证码 |

### 请求示例



{
  "email": "user@example.com",
  "code": "123456"
}



### 成功响应



200 OK





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



### 响应字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `accessToken` | String | JWT Access Token |
| `tokenType` | String | 固定为 `Bearer` |
| `expiresInSeconds` | Long | Token 剩余有效时间，单位秒 |
| `user.publicId` | String | 用户公开唯一 ID |
| `user.email` | String | 用户邮箱 |
| `user.nickname` | String | 用户昵称 |
| `user.avatarUrl` | String / null | 用户头像 |
| `user.role` | String | 用户角色，如 `USER`、`ADMIN` |

### 常见错误

| HTTP 状态码 | Code | 说明 |
| --- | --- | --- |
| 400 | `INVALID_REQUEST` | 请求参数缺失 |
| 400 | `INVALID_EMAIL` | 邮箱格式错误 |
| 400 | `INVALID_LOGIN_CODE` | 验证码不是 6 位数字 |
| 401 | `LOGIN_CODE_INCORRECT` | 验证码错误或已失效 |
| 401 | `USER_NOT_AVAILABLE` | 用户不存在或不可用 |
| 403 | `USER_DISABLED` | 用户已被禁用 |

错误响应格式：



{
  "code": "LOGIN_CODE_INCORRECT",
  "message": "错误提示信息"
}



---

## 3. 登录后的 Token 使用方式

登录成功后，`accessToken` 即 JWT。后续调用受保护接口时，通过请求头携带：



Authorization: Bearer <accessToken>



## 4. 接口对应关系



UserLoginController#sendLoginCode
POST /api/user/login/code

UserLoginController#login
POST /api/user/login

