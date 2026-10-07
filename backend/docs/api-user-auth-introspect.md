# 用户令牌校验接口

## 接口说明

校验调用方提交的 JWT 访问令牌，并在校验通过后返回可信的用户身份信息。该接口仅供其他可信服务在内网调用。

## 基本信息

| 项目 | 内容 |
| --- | --- |
| 请求方法 | POST |
| 请求路径 | /api/user/auth/introspect |
| 请求内容类型 | 无请求体（凭请求头传参） |
| 认证方式 | Bearer Token（JWT） |
| 所属控制器 | com.example.userservice.controller.UserInternalController |
| 服务端口 | 8961（默认，见运行日志） |

## 请求参数

### 请求头

| 参数名 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| Authorization | string | 是 | 格式为 Bearer <accessToken>，前缀 Bearer 不区分大小写，token 前后空白会被忽略 |

说明：请求头缺失、前缀不是 Bearer，或 token 为空时，均视为未提供令牌，直接返回 401。

## 响应说明

### 成功响应 200 OK

返回 InternalUserInfoRecord 结构：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| userId | integer(int64) | 用户数据库主键 |
| publicId | string | 用户对外公开标识 |
| email | string | 用户登录邮箱 |
| role | string | 用户角色，取值 USER 或 ADMIN |

响应示例：

{ "userId": 42, "publicId": "public-id", "email": "test@example.com", "role": "USER" }

### 失败响应

失败时返回 ApiErrorRecord 结构：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| code | string | 稳定业务错误码 |
| message | string | 面向调用方的错误说明 |

| HTTP 状态 | code | message | 触发条件 |
| --- | --- | --- | --- |
| 401 | UNAUTHORIZED | 当前请求尚未认证 | 未携带 Bearer 令牌，或令牌无效、已过期、用户不可用 |
| 400 | INVALID_REQUEST | 请求内容不合法 | 请求体无法反序列化（本接口无请求体，正常不会触发） |

失败响应示例：

{ "code": "UNAUTHORIZED", "message": "当前请求尚未认证" }

## 调用示例

curl -X POST http://127.0.0.1:8961/api/user/auth/introspect -H 'Authorization: Bearer <accessToken>'

## 注意事项

1. 该接口为内部接口，需通过内网访问，建议在网关或防火墙层限制来源。
2. 令牌校验同时检查 JWT 签名与对应用户状态，用户不可用时统一返回 401，不区分具体原因。
3. 接口为无状态设计，不创建会话，不返回 Set-Cookie。
4. Spring Security 对所有请求均放行，访问控制由业务逻辑与令牌校验完成。

## 相关代码

- 控制器：src/main/java/com/example/userservice/controller/UserInternalController.java
- 服务：src/main/java/com/example/userservice/service/UserService.java
- 返回结构：src/main/java/com/example/userservice/model/record/InternalUserInfoRecord.java
- 错误结构：src/main/java/com/example/userservice/model/record/ApiErrorRecord.java
- 错误码：src/main/java/com/example/userservice/model/enums/BusinessErrorCodeEnum.java
