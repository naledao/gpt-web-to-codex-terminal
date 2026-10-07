package xyz.kangnasi.web2termback.config;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;
import xyz.kangnasi.web2termback.interceptor.AgentHandshakeInterceptor;
import xyz.kangnasi.web2termback.interceptor.DesktopHandshakeInterceptor;
import xyz.kangnasi.web2termback.websocket.AgentWebSocketHandler;
import xyz.kangnasi.web2termback.websocket.DesktopWebSocketHandler;

/**
 * WebSocket 路由配置。
 */
@Configuration
@EnableWebSocket
public class WebSocketConfig implements WebSocketConfigurer {

    private final AgentWebSocketHandler agentWebSocketHandler;
    private final AgentHandshakeInterceptor agentHandshakeInterceptor;
    private final DesktopWebSocketHandler desktopWebSocketHandler;
    private final DesktopHandshakeInterceptor desktopHandshakeInterceptor;

    public WebSocketConfig(AgentWebSocketHandler agentWebSocketHandler,
                           AgentHandshakeInterceptor agentHandshakeInterceptor,
                           DesktopWebSocketHandler desktopWebSocketHandler,
                           DesktopHandshakeInterceptor desktopHandshakeInterceptor) {
        this.agentWebSocketHandler = agentWebSocketHandler;
        this.agentHandshakeInterceptor = agentHandshakeInterceptor;
        this.desktopWebSocketHandler = desktopWebSocketHandler;
        this.desktopHandshakeInterceptor = desktopHandshakeInterceptor;
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(agentWebSocketHandler, "/ws/agent")
                .addInterceptors(agentHandshakeInterceptor);

        registry.addHandler(desktopWebSocketHandler, "/ws/desktop")
                .addInterceptors(desktopHandshakeInterceptor);
    }
}