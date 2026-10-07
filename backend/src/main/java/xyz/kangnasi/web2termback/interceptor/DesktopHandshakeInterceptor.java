package xyz.kangnasi.web2termback.interceptor;

import feign.FeignException;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.server.HandshakeInterceptor;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import xyz.kangnasi.web2termback.feignclient.UserServiceClient;

import java.util.Map;
import java.util.UUID;

/**
 * Desktop WebSocket 握手认证。
 * 使用 Bearer JWT 校验用户身份，并使用 X-Desktop-Client-Id 标识桌面端实例。
 */
@Component
public class DesktopHandshakeInterceptor implements HandshakeInterceptor {

    public static final String ATTR_USER_ID = "desktopUserId";
    public static final String ATTR_DESKTOP_CLIENT_ID = "desktopClientId";

    private static final String DESKTOP_CLIENT_ID_HEADER = "X-Desktop-Client-Id";

    private final UserServiceClient userServiceClient;
    private final ObjectMapper objectMapper;

    public DesktopHandshakeInterceptor(UserServiceClient userServiceClient, ObjectMapper objectMapper) {
        this.userServiceClient = userServiceClient;
        this.objectMapper = objectMapper;
    }

    @Override
    public boolean beforeHandshake(ServerHttpRequest request,
                                   ServerHttpResponse response,
                                   WebSocketHandler wsHandler,
                                   Map<String, Object> attributes) {
        String authorization = request.getHeaders().getFirst(HttpHeaders.AUTHORIZATION);
        if (authorization == null || !authorization.startsWith("Bearer ")) {
            return reject(response, HttpStatus.UNAUTHORIZED);
        }

        String desktopClientId = normalizeDesktopClientId(
                request.getHeaders().getFirst(DESKTOP_CLIENT_ID_HEADER));
        if (desktopClientId == null) {
            return reject(response, HttpStatus.BAD_REQUEST);
        }

        final long userId;
        try {
            String body = userServiceClient.introspect(authorization).getBody();
            JsonNode json = body == null ? null : objectMapper.readTree(body);
            userId = json == null ? 0 : json.path("userId").asLong(0);
            if (userId <= 0) {
                return reject(response, HttpStatus.UNAUTHORIZED);
            }
        } catch (FeignException exception) {
            // JWT 无效返回 401；鉴权服务异常返回 503，避免混淆认证失败和服务故障。
            return reject(response, exception.status() == 401
                    ? HttpStatus.UNAUTHORIZED
                    : HttpStatus.SERVICE_UNAVAILABLE);
        } catch (Exception exception) {
            return reject(response, HttpStatus.BAD_GATEWAY);
        }

        // 只保存经过服务端校验后的身份，后续消息不得信任客户端自行声明的 userId。
        attributes.put(ATTR_USER_ID, userId);
        attributes.put(ATTR_DESKTOP_CLIENT_ID, desktopClientId);
        return true;
    }

    @Override
    public void afterHandshake(ServerHttpRequest request,
                               ServerHttpResponse response,
                               WebSocketHandler wsHandler,
                               Exception exception) {
        // 无额外清理动作。
    }

    private static String normalizeDesktopClientId(String rawDesktopClientId) {
        if (rawDesktopClientId == null || rawDesktopClientId.isBlank()) {
            return null;
        }
        try {
            return UUID.fromString(rawDesktopClientId.trim()).toString();
        } catch (IllegalArgumentException exception) {
            return null;
        }
    }

    private static boolean reject(ServerHttpResponse response, HttpStatus status) {
        response.setStatusCode(status);
        return false;
    }
}