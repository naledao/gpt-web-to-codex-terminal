CREATE TABLE `user_device` (
    -- 设备基本信息
                               `id` BIGINT NOT NULL AUTO_INCREMENT
        COMMENT '设备记录主键',

                               `user_id` BIGINT NOT NULL
                                   COMMENT '设备所属用户ID',

                               `device_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL
                                   COMMENT '设备端工具持久保存的设备唯一标识，UUID',

                               `device_name` VARCHAR(100) NOT NULL
                                   COMMENT '设备显示名称',

                               `enabled` TINYINT NOT NULL DEFAULT 1
                                   COMMENT '是否允许使用该设备：0禁用，1启用',

    -- 设备端工具与服务端的连接状态
                               `online_status` TINYINT NOT NULL DEFAULT 0
                                   COMMENT '设备端工具在线状态：0离线，1在线',

                               `last_connected_at` DATETIME(3) DEFAULT NULL
        COMMENT '设备端工具最近一次认证成功并连接服务端的时间',

                               `last_heartbeat_at` DATETIME(3) DEFAULT NULL
        COMMENT '服务端最近一次收到设备端工具有效心跳的时间',

                               `last_disconnected_at` DATETIME(3) DEFAULT NULL
        COMMENT '服务端最近一次确认设备端工具离线的时间',

    -- 控制端客户端到设备的终端会话
                               `terminal_connection_status` TINYINT NOT NULL DEFAULT 0
                                   COMMENT '控制端与设备的终端会话状态：0未连接，1连接中，2已连接，3连接异常',

                               `terminal_session_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL
                                   COMMENT '当前或最近一次终端会话标识，由服务端生成，UUID',

                               `desktop_client_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL
                                   COMMENT '当前或最近一次终端会话对应的控制端客户端标识，UUID',

                               `terminal_requested_at` DATETIME(3) DEFAULT NULL
        COMMENT '服务端最近一次收到建立终端会话请求的时间',

                               `terminal_connected_at` DATETIME(3) DEFAULT NULL
        COMMENT '最近一次终端会话建立成功的时间',

                               `terminal_disconnected_at` DATETIME(3) DEFAULT NULL
        COMMENT '最近一次终端会话正常关闭或确认异常结束的时间',

                               `terminal_error` VARCHAR(512) DEFAULT NULL
                                   COMMENT '最近一次终端会话异常的原因',

    -- 记录维护时间
                               `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
        COMMENT '设备记录创建时间',

                               `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
        ON UPDATE CURRENT_TIMESTAMP(3)
        COMMENT '设备记录最近更新时间',

                               PRIMARY KEY (`id`),

                               UNIQUE KEY `uk_user_device_device_id` (`device_id`),

                               UNIQUE KEY `uk_user_device_terminal_session_id` (`terminal_session_id`),

                               KEY `idx_user_device_user_online`
                                   (`user_id`, `online_status`),

                               KEY `idx_user_device_user_terminal`
                                   (`user_id`, `terminal_connection_status`),

                               KEY `idx_user_device_online_heartbeat`
                                   (`online_status`, `last_heartbeat_at`),

                               KEY `idx_user_device_terminal_requested`
                                   (`terminal_connection_status`, `terminal_requested_at`),

                               CONSTRAINT `chk_user_device_enabled`
                                   CHECK (`enabled` IN (0, 1)),

                               CONSTRAINT `chk_user_device_online_status`
                                   CHECK (`online_status` IN (0, 1)),

                               CONSTRAINT `chk_user_device_terminal_status`
                                   CHECK (`terminal_connection_status` IN (0, 1, 2, 3)),

                               CONSTRAINT `chk_user_device_active_terminal`
                                   CHECK (
                                       `terminal_connection_status` NOT IN (1, 2)
                                           OR (
                                           `terminal_session_id` IS NOT NULL
                                               AND `desktop_client_id` IS NOT NULL
                                               AND `terminal_requested_at` IS NOT NULL
                                           )
                                       )
) ENGINE = InnoDB
  DEFAULT CHARACTER SET = utf8mb4
  COLLATE = utf8mb4_0900_ai_ci
  COMMENT = '用户设备、设备端工具在线状态及远程终端会话状态';