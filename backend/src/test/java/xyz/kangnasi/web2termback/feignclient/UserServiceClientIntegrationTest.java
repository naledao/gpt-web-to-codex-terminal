package xyz.kangnasi.web2termback.feignclient;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * user-service 真实集成测试。
 * 不使用 Mock，通过 OpenFeign + Nacos 服务发现真实调用 user-service。
 */
@SpringBootTest
class UserServiceClientIntegrationTest {

    // 测试前在这里填写真实邮箱。
    private static final String EMAIL = "2419646091@qq.com";

    // 收到验证码后在这里填写真实的 6 位验证码。
    private static final String CODE = "978862";

    @Autowired
    private UserServiceClient userServiceClient;

    /**
     * 第一步：真实发送登录验证码。
     */
    @Test
    void sendLoginCode() {
        ResponseEntity<String> response = userServiceClient.sendLoginCode(
                new UserServiceClient.LoginCodeRequest(EMAIL));

        assertEquals(HttpStatus.NO_CONTENT, response.getStatusCode());
    }

    /**
     * 第二步：填写收到的验证码后，真实执行登录并校验响应。
     */
    @Test
    void login() {
        ResponseEntity<String> response = userServiceClient.login(
                new UserServiceClient.LoginRequest(EMAIL, CODE));

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertNotNull(response.getBody());
        assertTrue(response.getBody().contains("\"accessToken\""), "响应中缺少 accessToken");
        assertTrue(response.getBody().contains("\"tokenType\":\"Bearer\""), "响应中 tokenType 不是 Bearer");
        assertTrue(response.getBody().contains("\"user\""), "响应中缺少 user 信息");

        System.out.println("登录响应: " + response.getBody());
    }
}