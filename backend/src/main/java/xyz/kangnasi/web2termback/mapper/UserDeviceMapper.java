package xyz.kangnasi.web2termback.mapper;

import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

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

    record DeviceAuthRecord(Long id, Long userId, Integer enabled) {
    }
}