package xyz.kangnasi.web2termback.websocket;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import xyz.kangnasi.web2termback.interceptor.DesktopHandshakeInterceptor;

import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;

/**
 * Desktop WebSocket 连接处理器。
 * 负责维护 Desktop 会话并接收 Desktop 发来的 JSON 文本消息。
 */
@Component
public class DesktopWebSocketHandler extends TextWebSocketHandler {

    private static final Logger log = LoggerFactory.getLogger(DesktopWebSocketHandler.class);
    private static final CloseStatus REPLACED = new CloseStatus(1000, "replaced by new connection");

    private final ConcurrentMap<String, WebSocketSession> currentSessions = new ConcurrentHashMap<>();
    private final ObjectMapper objectMapper;
    private final AgentWebSocketHandler agentWebSocketHandler;

    public DesktopWebSocketHandler(ObjectMapper objectMapper, AgentWebSocketHandler agentWebSocketHandler) {
        this.objectMapper = objectMapper;
        this.agentWebSocketHandler = agentWebSocketHandler;
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) throws Exception {
        long userId = userId(session);
        String desktopClientId = desktopClientId(session);
        String agentId = agentId(session);

        // 同一个 desktopClientId 只保留最新连接，避免一个客户端标识对应多个活跃 Session。
        WebSocketSession previous = currentSessions.put(desktopClientId, session);
        if (previous != null && previous != session && previous.isOpen()) {
            previous.close(REPLACED);
        }
        log.info("Desktop connected: userId={}, desktopClientId={}, agentId={}",
                userId, desktopClientId, agentId);
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) throws Exception {
        final JsonNode json;
        try {
            json = objectMapper.readTree(message.getPayload());
        } catch (Exception exception) {
            // Desktop 与后端统一使用 JSON 文本协议，非法 JSON 直接关闭连接。
            session.close(new CloseStatus(1003, "invalid json"));
            return;
        }

        String type = json.path("type").asText();
        if (type == null || type.isBlank()) {
            session.close(new CloseStatus(1003, "missing message type"));
            return;
        }

        String agentId = agentId(session);
        log.info("Desktop message received: userId={}, desktopClientId={}, agentId={}, type={}",
                userId(session), desktopClientId(session), agentId, type);

        // X-Agent-Id 已在握手阶段完成归属和启用状态校验，这里只使用服务端保存的 agentId 定位 Agent Session。
        WebSocketSession agentSession = agentWebSocketHandler.getSession(agentId);
        if (agentSession == null) {
            log.warn("Cannot forward Desktop message because Agent is offline: desktopClientId={}, agentId={}, type={}",
                    desktopClientId(session), agentId, type);
            return;
        }

        agentSession.sendMessage(new TextMessage(message.getPayload()));
        log.debug("Desktop message forwarded to Agent: desktopClientId={}, agentId={}, type={}",
                desktopClientId(session), agentId, type);
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        String desktopClientId = desktopClientId(session);
        if (currentSessions.remove(desktopClientId, session)) {
            log.info("Desktop disconnected: userId={}, desktopClientId={}, agentId={}, status={}",
                    userId(session), desktopClientId, agentId(session), status);
        }
    }

    /**
     * 根据桌面端客户端 ID 获取当前活动会话，供后续 Agent/终端会话转发逻辑使用。
     */
    public WebSocketSession getSession(String desktopClientId) {
        WebSocketSession session = currentSessions.get(desktopClientId);
        return session != null && session.isOpen() ? session : null;
    }

    private static long userId(WebSocketSession session) {
        return ((Number) session.getAttributes().get(DesktopHandshakeInterceptor.ATTR_USER_ID)).longValue();
    }

    private static String desktopClientId(WebSocketSession session) {
        return (String) session.getAttributes().get(DesktopHandshakeInterceptor.ATTR_DESKTOP_CLIENT_ID);
    }

    private static String agentId(WebSocketSession session) {
        return (String) session.getAttributes().get(DesktopHandshakeInterceptor.ATTR_AGENT_ID);
    }
}