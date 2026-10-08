package xyz.kangnasi.web2termback.mapper;

import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

import java.time.LocalDateTime;
import java.util.List;

/**
 * Agent 设备连接状态的数据访问层。
 */
@Mapper
public interface UserDeviceMapper {

    @Select("""
            SELECT id, user_id AS userId, enabled
            FROM user_device
            WHERE device_id = #{deviceId}
            LIMIT 1
            """)
    DeviceAuthRecord findAuthState(@Param("deviceId") String deviceId);

    @Insert("""
            INSERT IGNORE INTO user_device (user_id, device_id, device_name)
            VALUES (#{userId}, #{deviceId}, #{deviceName})
            """)
    int insertIfAbsent(@Param("userId") long userId,
                       @Param("deviceId") String deviceId,
                       @Param("deviceName") String deviceName);

    @Update("""
            UPDATE user_device
            SET device_name = #{deviceName},
                online_status = 1,
                last_connected_at = NOW(3),
                last_heartbeat_at = NOW(3)
            WHERE device_id = #{deviceId}
              AND user_id = #{userId}
              AND enabled = 1
            """)
    int markConnected(@Param("userId") long userId,
                      @Param("deviceId") String deviceId,
                      @Param("deviceName") String deviceName);

    @Update("""
            UPDATE user_device
            SET last_heartbeat_at = NOW(3)
            WHERE device_id = #{deviceId}
              AND user_id = #{userId}
              AND enabled = 1
              AND online_status = 1
            """)
    int updateHeartbeat(@Param("userId") long userId,
                        @Param("deviceId") String deviceId);

    @Update("""
            UPDATE user_device
            SET online_status = 0,
                last_disconnected_at = NOW(3)
            WHERE device_id = #{deviceId}
              AND user_id = #{userId}
            """)
    int markDisconnected(@Param("userId") long userId,
                         @Param("deviceId") String deviceId);

    /**
     * 仅在设备原本在线时更新离线状态，避免重复刷新断开时间。
     */
    @Update("""
            UPDATE user_device
            SET online_status = 0,
                last_disconnected_at = NOW(3)
            WHERE device_id = #{deviceId}
              AND user_id = #{userId}
              AND online_status = 1
            """)
    int markOfflineIfOnline(@Param("userId") long userId,
                            @Param("deviceId") String deviceId);

    /**
     * 查询当前用户的全部设备，供设备列表接口使用。
     */
    @Select("""
            SELECT device_id AS deviceId,
                   device_name AS deviceName,
                   enabled,
                   online_status AS onlineStatus,
                   last_connected_at AS lastConnectedAt,
                   last_heartbeat_at AS lastHeartbeatAt,
                   last_disconnected_at AS lastDisconnectedAt,
                   terminal_connection_status AS terminalConnectionStatus,
                   terminal_session_id AS terminalSessionId,
                   desktop_client_id AS desktopClientId,
                   terminal_requested_at AS terminalRequestedAt,
                   terminal_connected_at AS terminalConnectedAt,
                   terminal_disconnected_at AS terminalDisconnectedAt,
                   terminal_error AS terminalError,
                   created_at AS createdAt,
                   updated_at AS updatedAt
            FROM user_device
            WHERE user_id = #{userId}
            ORDER BY updated_at DESC, id DESC
            """)
    List<UserDeviceRecord> findByUserId(@Param("userId") long userId);

    record UserDeviceRecord(String deviceId,
                            String deviceName,
                            Integer enabled,
                            Integer onlineStatus,
                            LocalDateTime lastConnectedAt,
                            LocalDateTime lastHeartbeatAt,
                            LocalDateTime lastDisconnectedAt,
                            Integer terminalConnectionStatus,
                            String terminalSessionId,
                            String desktopClientId,
                            LocalDateTime terminalRequestedAt,
                            LocalDateTime terminalConnectedAt,
                            LocalDateTime terminalDisconnectedAt,
                            String terminalError,
                            LocalDateTime createdAt,
                            LocalDateTime updatedAt) {
    }
    record DeviceAuthRecord(Long id, Long userId, Integer enabled) {
    }
}