package xyz.kangnasi.web2termback.websocket;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;
import xyz.kangnasi.web2termback.interceptor.DesktopHandshakeInterceptor;

import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;

/**
 * Desktop WebSocket 连接处理器。
 * 当前负责维护 desktopClientId 与 WebSocketSession 的映射，后续终端控制消息在此扩展。
 */
@Component
public class DesktopWebSocketHandler extends TextWebSocketHandler {

    private static final Logger log = LoggerFactory.getLogger(DesktopWebSocketHandler.class);
    private static final CloseStatus REPLACED = new CloseStatus(1000, "replaced by new connection");

    private final ConcurrentMap<String, WebSocketSession> currentSessions = new ConcurrentHashMap<>();

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