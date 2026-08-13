package com.kross.worker;

import com.kross.api.ApiException;
import com.kross.worker.dto.WorkerProtocol.ApprovalDecision;
import com.kross.worker.dto.WorkerProtocol.ArtifactCommitRequest;
import com.kross.worker.dto.WorkerProtocol.ArtifactCommitted;
import com.kross.worker.dto.WorkerProtocol.ArtifactReserveRequest;
import com.kross.worker.dto.WorkerProtocol.ArtifactReserved;
import com.kross.worker.dto.WorkerProtocol.CheckpointStored;
import com.kross.worker.dto.WorkerProtocol.LeaseRenewed;
import com.kross.worker.dto.WorkerProtocol.ModelEnvironment;
import com.kross.worker.dto.WorkerProtocol.WorkerEventAck;
import com.kross.worker.dto.WorkerProtocol.WorkerEventRequest;
import com.kross.worker.dto.WorkerProtocol.WorkerHeartbeatRequest;
import com.kross.worker.dto.WorkerProtocol.WorkerRegisterRequest;
import com.kross.worker.dto.WorkerProtocol.WorkerRegistered;
import com.kross.worker.dto.WorkerProtocol.WorkerReleaseRequest;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.io.InputStream;
import java.util.Optional;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequiredArgsConstructor
@RequestMapping("/internal/v2/workers")
public class WorkerController {
  private static final int MAX_CHECKPOINT_BYTES = 16 * 1024 * 1024;

  private final WorkerControlService workers;

  @PostMapping("/register")
  public WorkerRegistered register(
      @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization,
      @RequestBody WorkerRegisterRequest message) {
    requireType(message.type(), "worker.register");
    return workers.register(bearer(authorization), message);
  }

  @PostMapping("/events")
  public WorkerEventAck events(
      @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization,
      @RequestBody WorkerEventRequest message) {
    requireType(message.type(), "worker.event");
    return workers.appendEvent(
        bearer(authorization),
        Optional.ofNullable(message.envelope())
            .orElseThrow(() -> ApiException.invalidRequest("Worker event envelope is required")));
  }

  @PostMapping("/heartbeat")
  public LeaseRenewed heartbeat(
      @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization,
      @RequestBody WorkerHeartbeatRequest message) {
    requireType(message.type(), "worker.heartbeat");
    return workers.heartbeat(bearer(authorization), message);
  }

  @PostMapping("/release")
  public ResponseEntity<Void> release(
      @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization,
      @RequestBody WorkerReleaseRequest message) {
    requireType(message.type(), "lease.release");
    workers.release(bearer(authorization), message);
    return ResponseEntity.noContent().build();
  }

  @PostMapping("/artifacts/reserve")
  public ArtifactReserved reserveArtifact(
      @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization,
      @RequestBody ArtifactReserveRequest message) {
    requireType(message.type(), "artifact.reserve");
    return workers.reserveArtifact(bearer(authorization), message);
  }

  @PostMapping("/artifacts/commit")
  public ArtifactCommitted commitArtifact(
      @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization,
      @RequestBody ArtifactCommitRequest message) {
    requireType(message.type(), "artifact.commit");
    return workers.commitArtifact(bearer(authorization), message);
  }

  @GetMapping("/approval-decision")
  public ResponseEntity<ApprovalDecision> approvalDecision(
      @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization) {
    return workers.nextApprovalDecision(bearer(authorization))
        .map(ResponseEntity::ok)
        .orElseGet(() -> ResponseEntity.noContent().build());
  }

  @PutMapping("/checkpoints")
  @ResponseStatus(HttpStatus.CREATED)
  public CheckpointStored putCheckpoint(
      @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization,
      @RequestParam String sha256,
      @RequestParam long sizeBytes,
      HttpServletRequest request) throws IOException {
    if (sizeBytes < 0 || sizeBytes > MAX_CHECKPOINT_BYTES) {
      throw new ApiException("invalid_checkpoint_metadata", "Invalid checkpoint metadata", 400);
    }
    byte[] content;
    try (InputStream body = request.getInputStream()) {
      content = body.readNBytes((int) sizeBytes + 1);
    }
    return workers.putCheckpoint(bearer(authorization), sha256, sizeBytes, content);
  }

  @GetMapping("/checkpoints")
  public void getCheckpoint(
      @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization,
      @RequestParam("key") String key,
      HttpServletResponse response) throws IOException {
    try (var content = workers.getCheckpoint(bearer(authorization), key)) {
      response.setStatus(HttpServletResponse.SC_OK);
      response.setContentType("application/json");
      response.setHeader(HttpHeaders.CACHE_CONTROL, "no-store");
      content.transferTo(response.getOutputStream());
    }
  }

  @GetMapping("/model-environment")
  public ModelEnvironment modelEnvironment(
      @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization) {
    return workers.mintModelEnvironment(bearer(authorization));
  }

  private static String bearer(String authorization) {
    String header = Optional.ofNullable(authorization).orElse("");
    if (!header.startsWith("Bearer ") || header.length() <= 7) {
      throw new ApiException("worker_unauthenticated", "Run-scoped Bearer token is required", 401);
    }
    return header.substring("Bearer ".length());
  }

  private static void requireType(String actual, String expected) {
    if (!expected.equals(actual)) {
      throw new ApiException(
          "worker_message_route_mismatch", "Worker message type does not match route", 400);
    }
  }
}
