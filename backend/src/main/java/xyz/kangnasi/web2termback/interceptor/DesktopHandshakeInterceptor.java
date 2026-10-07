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
import xyz.kangnasi.web2termback.mapper.UserDeviceMapper;
import xyz.kangnasi.web2termback.websocket.AgentDesktopClientRegistry;

import java.util.Map;
import java.util.UUID;

/**
 * Desktop WebSocket 握手认证。
 * 使用 Bearer JWT 校验用户身份，并校验 Desktop 客户端 ID 和目标 Agent ID。
 */
@Component
public class DesktopHandshakeInterceptor implements HandshakeInterceptor {

    public static final String ATTR_USER_ID = "desktopUserId";
    public static final String ATTR_DESKTOP_CLIENT_ID = "desktopClientId";
    public static final String ATTR_AGENT_ID = "agentId";

    private static final String DESKTOP_CLIENT_ID_HEADER = "X-Desktop-Client-Id";
    private static final String AGENT_ID_HEADER = "X-Agent-Id";

    private final UserServiceClient userServiceClient;
    private final UserDeviceMapper userDeviceMapper;
    private final ObjectMapper objectMapper;
    private final AgentDesktopClientRegistry agentDesktopClientRegistry;

    public DesktopHandshakeInterceptor(UserServiceClient userServiceClient,
                                       UserDeviceMapper userDeviceMapper,
                                       ObjectMapper objectMapper,
                                       AgentDesktopClientRegistry agentDesktopClientRegistry) {
        this.userServiceClient = userServiceClient;
        this.userDeviceMapper = userDeviceMapper;
        this.objectMapper = objectMapper;
        this.agentDesktopClientRegistry = agentDesktopClientRegistry;
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

        String desktopClientId = normalizeUuid(
                request.getHeaders().getFirst(DESKTOP_CLIENT_ID_HEADER));
        if (desktopClientId == null) {
            return reject(response, HttpStatus.BAD_REQUEST);
        }

        String agentId = normalizeUuid(request.getHeaders().getFirst(AGENT_ID_HEADER));
        if (agentId == null) {
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

        UserDeviceMapper.DeviceAuthRecord agent = userDeviceMapper.findAuthState(agentId);
        if (agent == null) {
            return reject(response, HttpStatus.NOT_FOUND);
        }
        if (!Long.valueOf(userId).equals(agent.userId())) {
            return reject(response, HttpStatus.FORBIDDEN);
        }
        if (!Integer.valueOf(1).equals(agent.enabled())) {
            return reject(response, HttpStatus.FORBIDDEN);
        }

        // 一个 Agent 同一时间只允许一个 Desktop 建立控制连接；已存在绑定时拒绝本次握手。
        if (agentDesktopClientRegistry.isBound(agentId)) {
            return reject(response, HttpStatus.CONFLICT);
        }

        // 只保存经过服务端校验后的身份和目标设备，后续消息不得信任客户端自行声明的这些字段。
        attributes.put(ATTR_USER_ID, userId);
        attributes.put(ATTR_DESKTOP_CLIENT_ID, desktopClientId);
        attributes.put(ATTR_AGENT_ID, agentId);
        return true;
    }

    @Override
    public void afterHandshake(ServerHttpRequest request,
                               ServerHttpResponse response,
                               WebSocketHandler wsHandler,
                               Exception exception) {
        // 无额外清理动作。
    }

    private static String normalizeUuid(String rawValue) {
        if (rawValue == null || rawValue.isBlank()) {
            return null;
        }
        try {
            return UUID.fromString(rawValue.trim()).toString();
        } catch (IllegalArgumentException exception) {
            return null;
        }
    }

    private static boolean reject(ServerHttpResponse response, HttpStatus status) {
        response.setStatusCode(status);
        return false;
    }
}