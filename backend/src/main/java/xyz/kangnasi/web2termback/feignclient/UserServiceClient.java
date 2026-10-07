package xyz.kangnasi.web2termback.feignclient;

import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;

/**
 * user-service 的 OpenFeign 客户端。
 * name 对应 Nacos 中注册的服务名，由 Spring Cloud LoadBalancer 自动选择服务实例。
 */
@FeignClient(name = "user-service")
public interface UserServiceClient {

    @PostMapping("/api/user/login/code")
    ResponseEntity<String> sendLoginCode(@RequestBody LoginCodeRequest request);

    @PostMapping("/api/user/login")
    ResponseEntity<String> login(@RequestBody LoginRequest request);

    /**
     * 校验 JWT，并返回 user-service 提供的可信用户身份信息。
     */
    @PostMapping("/api/user/auth/introspect")
    ResponseEntity<String> introspect(@RequestHeader(value = "Authorization", required = false) String authorization);

    record LoginCodeRequest(String email) {
    }

    record LoginRequest(String email, String code) {
    }
}