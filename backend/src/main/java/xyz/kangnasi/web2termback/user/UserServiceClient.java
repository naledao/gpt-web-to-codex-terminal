package xyz.kangnasi.web2termback.user;

import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;

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

    record LoginCodeRequest(String email) {
    }

    record LoginRequest(String email, String code) {
    }
}