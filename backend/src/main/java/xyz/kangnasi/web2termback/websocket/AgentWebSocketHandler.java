package xyz.kangnasi.web2termback.websocket;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;
import xyz.kangnasi.web2termback.interceptor.AgentHandshakeInterceptor;
import xyz.kangnasi.web2termback.mapper.UserDeviceMapper;

import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;

/**
 * Agent WebSocket 连接处理器。
 * 当前负责设备上下线和 heartbeat，后续终端协议可以继续在此扩展。
 */
@Component
public class AgentWebSocketHandler extends TextWebSocketHandler {

    private static final Logger log = LoggerFactory.getLogger(AgentWebSocketHandler.class);
    private static final CloseStatus DEVICE_NOT_ALLOWED = new CloseStatus(1008, "device not allowed");
    private static final CloseStatus REPLACED = new CloseStatus(1000, "replaced by new connection");

    private final UserDeviceMapper userDeviceMapper;
    private final ObjectMapper objectMapper;
    private final ConcurrentMap<String, WebSocketSession> currentSessions = new ConcurrentHashMap<>();

    public AgentWebSocketHandler(UserDeviceMapper userDeviceMapper, ObjectMapper objectMapper) {
        this.userDeviceMapper = userDeviceMapper;
        this.objectMapper = objectMapper;
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) throws Exception {
        long userId = userId(session);
        String deviceId = deviceId(session);
        String deviceName = (String) session.getAttributes().get(AgentHandshakeInterceptor.ATTR_DEVICE_NAME);

        // 首次连接自动创建设备；已存在设备不会被重新绑定到其他用户。
        userDeviceMapper.insertIfAbsent(userId, deviceId, deviceName);
        if (userDeviceMapper.markConnected(userId, deviceId, deviceName) != 1) {
            session.close(DEVICE_NOT_ALLOWED);
            return;
        }

        // 同一个 deviceId 只保留最新连接，旧连接关闭时不会把新连接误标为离线。
        WebSocketSession previous = currentSessions.put(deviceId, session);
        if (previous != null && previous != session && previous.isOpen()) {
            previous.close(REPLACED);
        }
        log.info("Agent connected: userId={}, deviceId={}", userId, deviceId);
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) throws Exception {
        JsonNode json;
        try {
            json = objectMapper.readTree(message.getPayload());
        } catch (Exception exception) {
            session.close(new CloseStatus(1003, "invalid json"));
            return;
        }

        if ("heartbeat".equals(json.path("type").asText())) {
            long userId = userId(session);
            String deviceId = deviceId(session);
            if (userDeviceMapper.updateHeartbeat(userId, deviceId) != 1) {
                session.close(DEVICE_NOT_ALLOWED);
                return;
            }
            session.sendMessage(new TextMessage("{\"type\":\"heartbeat_ack\"}"));
        }
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        String deviceId = deviceId(session);
        WebSocketSession current = currentSessions.get(deviceId);
        if (current == session && currentSessions.remove(deviceId, session)) {
            userDeviceMapper.markDisconnected(userId(session), deviceId);
            log.info("Agent disconnected: userId={}, deviceId={}, status={}", userId(session), deviceId, status);
        }
    }

    private static long userId(WebSocketSession session) {
        return ((Number) session.getAttributes().get(AgentHandshakeInterceptor.ATTR_USER_ID)).longValue();
    }

    private static String deviceId(WebSocketSession session) {
        return (String) session.getAttributes().get(AgentHandshakeInterceptor.ATTR_DEVICE_ID);
    }
}