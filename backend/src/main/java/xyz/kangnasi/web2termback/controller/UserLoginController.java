package xyz.kangnasi.web2termback.controller;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import xyz.kangnasi.web2termback.feignclient.UserServiceClient;

/**
 * 登录接口代理层，对外保持与 user-service 登录 API 一致的请求路径和响应状态。
 */
@RestController
@RequestMapping("/api/user/login")
public class UserLoginController {

    private final UserServiceClient userServiceClient;

    public UserLoginController(UserServiceClient userServiceClient) {
        this.userServiceClient = userServiceClient;
    }

    @PostMapping("/code")
    public ResponseEntity<String> sendLoginCode(@RequestBody UserServiceClient.LoginCodeRequest request) {
        return userServiceClient.sendLoginCode(request);
    }

    @PostMapping
    public ResponseEntity<String> login(@RequestBody UserServiceClient.LoginRequest request) {
        ResponseEntity<String> downstream = userServiceClient.login(request);
        // 只透传状态码和响应体，避免把 user-service 的响应头再次带到当前服务造成重复响应头。
        return ResponseEntity.status(downstream.getStatusCode())
                .body(downstream.getBody());
    }
}