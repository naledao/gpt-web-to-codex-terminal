package xyz.kangnasi.web2termback.websocket;

import org.springframework.stereotype.Component;

import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;

/**
 * Agent 与 Desktop 客户端 ID 的绑定关系。
 * 这里只保存 agentId -> desktopClientId，不保存 WebSocket Session。
 */
@Component
public class AgentDesktopClientRegistry {

    private final ConcurrentMap<String, String> desktopClientsByAgent = new ConcurrentHashMap<>();

    public String bind(String agentId, String desktopClientId) {
        return desktopClientsByAgent.put(agentId, desktopClientId);
    }

    /**
     * 仅删除仍指向指定 Desktop 的绑定，避免旧连接关闭时误删新绑定。
     */
    public boolean unbind(String agentId, String desktopClientId) {
        return desktopClientsByAgent.remove(agentId, desktopClientId);
    }

    public String getDesktopClientId(String agentId) {
        return desktopClientsByAgent.get(agentId);
    }
}