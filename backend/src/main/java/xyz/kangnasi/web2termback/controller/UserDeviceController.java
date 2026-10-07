package xyz.kangnasi.web2termback.controller;

import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import xyz.kangnasi.web2termback.feignclient.UserServiceClient;
import xyz.kangnasi.web2termback.mapper.UserDeviceMapper;

import java.util.List;

/**
 * 当前用户设备查询接口。
 */
@RestController
@RequestMapping("/api/user/devices")
public class UserDeviceController {

    private final UserServiceClient userServiceClient;
    private final UserDeviceMapper userDeviceMapper;
    private final ObjectMapper objectMapper;

    public UserDeviceController(UserServiceClient userServiceClient,
                                UserDeviceMapper userDeviceMapper,
                                ObjectMapper objectMapper) {
        this.userServiceClient = userServiceClient;
        this.userDeviceMapper = userDeviceMapper;
        this.objectMapper = objectMapper;
    }

    @GetMapping
    public List<UserDeviceMapper.UserDeviceRecord> listDevices(
            @RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String authorization) {
        ResponseEntity<String> authResponse = userServiceClient.introspect(authorization);
        long userId = extractUserId(authResponse.getBody());
        return userDeviceMapper.findByUserId(userId);
    }

    /**
     * userId 只信任 user-service 的 introspect 返回值，不接受客户端直接传入用户 ID。
     */
    private long extractUserId(String body) {
        try {
            JsonNode json = body == null ? null : objectMapper.readTree(body);
            long userId = json == null ? 0 : json.path("userId").asLong(0);
            if (userId <= 0) {
                throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "invalid user identity");
            }
            return userId;
        } catch (ResponseStatusException exception) {
            throw exception;
        } catch (Exception exception) {
            throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, "invalid auth response", exception);
        }
    }
}