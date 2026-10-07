package xyz.kangnasi.web2termback.exceptrinhandler;

import feign.FeignException;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

/**
 * Feign 下游业务错误透传处理。
 * 保留 user-service 返回的 HTTP 状态码和 JSON 错误体，避免 401/400 被转换成后端 500。
 */
@RestControllerAdvice
public class FeignExceptionHandler {

    @ExceptionHandler(FeignException.class)
    public ResponseEntity<String> handleFeignException(FeignException exception) {
        String body = exception.contentUTF8();
        return ResponseEntity.status(exception.status())
                .contentType(MediaType.APPLICATION_JSON)
                .body(body == null || body.isBlank() ? null : body);
    }
}