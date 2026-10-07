package xyz.kangnasi.web2termback.config;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;
import xyz.kangnasi.web2termback.interceptor.AgentHandshakeInterceptor;
import xyz.kangnasi.web2termback.websocket.AgentWebSocketHandler;

/**
 * WebSocket 路由配置。
 */
@Configuration
@EnableWebSocket
public class WebSocketConfig implements WebSocketConfigurer {

    private final AgentWebSocketHandler agentWebSocketHandler;
    private final AgentHandshakeInterceptor agentHandshakeInterceptor;

    public WebSocketConfig(AgentWebSocketHandler agentWebSocketHandler,
                           AgentHandshakeInterceptor agentHandshakeInterceptor) {
        this.agentWebSocketHandler = agentWebSocketHandler;
        this.agentHandshakeInterceptor = agentHandshakeInterceptor;
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(agentWebSocketHandler, "/ws/agent")
                .addInterceptors(agentHandshakeInterceptor);
    }
}