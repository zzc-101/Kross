package com.kross.knowledge;

import com.fasterxml.jackson.databind.JsonNode;
import com.kross.api.ApiException;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequiredArgsConstructor
@RequestMapping("/mcp/knowledge")
public class KnowledgeMcpController {
  private final KnowledgeMcpService mcp;

  @PostMapping(consumes = MediaType.APPLICATION_JSON_VALUE, produces = MediaType.APPLICATION_JSON_VALUE)
  public ResponseEntity<JsonNode> post(
      @RequestHeader(value = HttpHeaders.AUTHORIZATION, required = false) String authorization,
      @RequestBody(required = false) JsonNode body) {
    try {
      return mcp.dispatch(authorization, body);
    } catch (ApiException error) {
      if (error.getStatus() == 401) {
        return KnowledgeMcpService.unauthorized();
      }
      throw error;
    }
  }

  @DeleteMapping
  public ResponseEntity<Void> delete() {
    return ResponseEntity.noContent().build();
  }
}
