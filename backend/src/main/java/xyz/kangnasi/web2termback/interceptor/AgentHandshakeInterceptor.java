package xyz.kangnasi.web2termback.interceptor;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import feign.FeignException;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.server.HandshakeInterceptor;
import xyz.kangnasi.web2termback.feignclient.UserServiceClient;
import xyz.kangnasi.web2termback.mapper.UserDeviceMapper;

import java.util.Map;
import java.util.UUID;

/**
 * Agent WebSocket 握手认证。
 *
 * 协议：Authorization 携带 Bearer JWT，X-Device-Id 携带设备 UUID，
 * X-Device-Name 可选；首次连接时缺省名称会自动使用 agent-xxxxxxxx。
 */
@Component
public class AgentHandshakeInterceptor implements HandshakeInterceptor {

    public static final String ATTR_USER_ID = "agentUserId";
    public static final String ATTR_DEVICE_ID = "agentDeviceId";
    public static final String ATTR_DEVICE_NAME = "agentDeviceName";

    private static final String DEVICE_ID_HEADER = "X-Device-Id";
    private static final String DEVICE_NAME_HEADER = "X-Device-Name";

    private final UserServiceClient userServiceClient;
    private final UserDeviceMapper userDeviceMapper;
    private final ObjectMapper objectMapper;

    public AgentHandshakeInterceptor(UserServiceClient userServiceClient,
                                     UserDeviceMapper userDeviceMapper,
                                     ObjectMapper objectMapper) {
        this.userServiceClient = userServiceClient;
        this.userDeviceMapper = userDeviceMapper;
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

        String rawDeviceId = request.getHeaders().getFirst(DEVICE_ID_HEADER);
        String deviceId = normalizeDeviceId(rawDeviceId);
        if (deviceId == null) {
            return reject(response, HttpStatus.BAD_REQUEST);
        }

        String deviceName = normalizeDeviceName(request.getHeaders().getFirst(DEVICE_NAME_HEADER), deviceId);
        if (deviceName == null) {
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
            // JWT 无效返回 401；鉴权服务自身故障不伪装成客户端认证失败。
            return reject(response, exception.status() == 401
                    ? HttpStatus.UNAUTHORIZED
                    : HttpStatus.SERVICE_UNAVAILABLE);
        } catch (Exception exception) {
            return reject(response, HttpStatus.BAD_GATEWAY);
        }

        UserDeviceMapper.DeviceAuthRecord existing = userDeviceMapper.findAuthState(deviceId);
        if (existing != null) {
            if (!Long.valueOf(userId).equals(existing.userId())) {
                return reject(response, HttpStatus.FORBIDDEN);
            }
            if (!Integer.valueOf(1).equals(existing.enabled())) {
                return reject(response, HttpStatus.FORBIDDEN);
            }
        }

        // 只把服务端校验后的可信身份写入 WebSocket Session，客户端不能覆盖这些属性。
        attributes.put(ATTR_USER_ID, userId);
        attributes.put(ATTR_DEVICE_ID, deviceId);
        attributes.put(ATTR_DEVICE_NAME, deviceName);
        return true;
    }

    @Override
    public void afterHandshake(ServerHttpRequest request,
                               ServerHttpResponse response,
                               WebSocketHandler wsHandler,
                               Exception exception) {
        // 无额外清理动作。
    }

    private static String normalizeDeviceId(String rawDeviceId) {
        if (rawDeviceId == null || rawDeviceId.isBlank()) {
            return null;
        }
        try {
            return UUID.fromString(rawDeviceId.trim()).toString();
        } catch (IllegalArgumentException exception) {
            return null;
        }
    }

    private static String normalizeDeviceName(String rawDeviceName, String deviceId) {
        if (rawDeviceName == null || rawDeviceName.isBlank()) {
            return "agent-" + deviceId.substring(0, 8);
        }
        String name = rawDeviceName.trim();
        return name.length() <= 100 ? name : null;
    }

    private static boolean reject(ServerHttpResponse response, HttpStatus status) {
        response.setStatusCode(status);
        return false;
    }
}