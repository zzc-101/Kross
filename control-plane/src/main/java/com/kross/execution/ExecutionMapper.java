package com.kross.execution;

import com.fasterxml.jackson.databind.JsonNode;
import com.kross.execution.entity.Approval;
import com.kross.execution.entity.ModelCredential;
import com.kross.execution.entity.Run;
import com.kross.execution.entity.RunEvent;
import com.kross.execution.entity.QueuedLaunch;
import com.kross.execution.entity.RunLease;
import com.kross.execution.entity.RunSpecData;
import com.kross.execution.entity.SourceBlob;
import com.kross.execution.entity.TaskLock;
import com.kross.execution.entity.UsableModel;
import com.kross.execution.entity.WorkerToken;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

@Mapper
public interface ExecutionMapper {
  Optional<Run> findRun(@Param("organizationId") String organizationId, @Param("id") String id);

  Optional<TaskLock> lockTask(
      @Param("organizationId") String organizationId, @Param("taskId") String taskId);

  Optional<UsableModel> findUsableModel(
      @Param("organizationId") String organizationId, @Param("modelProfileId") String modelProfileId);

  void insertRun(Run row);

  void insertLease(@Param("runId") String runId, @Param("organizationId") String organizationId);

  int requestCancel(@Param("organizationId") String organizationId, @Param("id") String id);

  int markProvisioning(
      @Param("organizationId") String organizationId,
      @Param("id") String id,
      @Param("generation") int generation);

  int markCancelledIfCancelling(@Param("organizationId") String organizationId, @Param("id") String id);

  Optional<Integer> leasedGenerationForCancelling(
      @Param("organizationId") String organizationId, @Param("runId") String runId);

  Optional<RunLease> claimLease(@Param("owner") String owner, @Param("durationMs") long durationMs);

  Optional<RunLease> renewLease(
      @Param("organizationId") String organizationId,
      @Param("leaseId") String leaseId,
      @Param("owner") String owner,
      @Param("generation") int generation,
      @Param("durationMs") long durationMs);

  int releaseLease(
      @Param("organizationId") String organizationId,
      @Param("leaseId") String leaseId,
      @Param("owner") String owner,
      @Param("generation") int generation,
      @Param("delayMs") long delayMs);

  int insertToken(
      @Param("tokenHash") String tokenHash,
      @Param("organizationId") String organizationId,
      @Param("runId") String runId,
      @Param("generation") int generation,
      @Param("leaseId") String leaseId,
      @Param("expiresAt") Instant expiresAt);

  int workerReleaseLease(
      @Param("organizationId") String organizationId,
      @Param("runId") String runId,
      @Param("leaseId") String leaseId,
      @Param("owner") String owner,
      @Param("generation") int generation);

  Optional<QueuedLaunch> findQueuedLaunch(
      @Param("organizationId") String organizationId, @Param("runId") String runId);

  Optional<WorkerToken> authenticateToken(@Param("tokenHash") String tokenHash);

  int bindWorker(
      @Param("tokenHash") String tokenHash,
      @Param("sessionId") String sessionId,
      @Param("workerId") String workerId);

  int revokeToken(@Param("tokenHash") String tokenHash);

  int revokeTokensForLease(
      @Param("organizationId") String organizationId,
      @Param("runId") String runId,
      @Param("generation") int generation,
      @Param("leaseId") String leaseId);

  int extendToken(
      @Param("tokenHash") String tokenHash,
      @Param("expiresAt") Instant expiresAt,
      @Param("durationMs") long durationMs);

  Optional<RunSpecData> loadRunSpec(
      @Param("organizationId") String organizationId,
      @Param("runId") String runId,
      @Param("generation") int generation,
      @Param("leaseId") String leaseId);

  List<SourceBlob> loadReadySources(
      @Param("organizationId") String organizationId, @Param("ids") List<String> ids);

  int insertEvent(
      @Param("publicEventId") String publicEventId,
      @Param("organizationId") String organizationId,
      @Param("runId") String runId,
      @Param("generation") int generation,
      @Param("leaseId") String leaseId,
      @Param("seq") long seq,
      @Param("type") String type,
      @Param("occurredAt") Instant occurredAt,
      @Param("payload") JsonNode payload);

  long maxEventSeq(@Param("runId") String runId, @Param("generation") int generation);

  int insertPendingApproval(
      @Param("id") String id,
      @Param("organizationId") String organizationId,
      @Param("runId") String runId,
      @Param("kind") String kind,
      @Param("scope") String scope,
      @Param("riskLevel") String riskLevel,
      @Param("actionPreview") String actionPreview,
      @Param("target") JsonNode target,
      @Param("requestHash") String requestHash,
      @Param("requestedAt") Instant requestedAt,
      @Param("expiresAt") Instant expiresAt);

  int projectRunFromEvent(
      @Param("organizationId") String organizationId,
      @Param("runId") String runId,
      @Param("type") String type,
      @Param("occurredAt") Instant occurredAt,
      @Param("terminalStatus") String terminalStatus);

  List<RunEvent> replayEvents(
      @Param("organizationId") String organizationId,
      @Param("cursor") String cursor,
      @Param("projectId") String projectId,
      @Param("taskId") String taskId,
      @Param("runId") String runId,
      @Param("limit") int limit);

  Optional<JsonNode> findIdempotency(
      @Param("organizationId") String organizationId,
      @Param("scope") String scope,
      @Param("key") String key);

  Optional<String> findIdempotencyHash(
      @Param("organizationId") String organizationId,
      @Param("scope") String scope,
      @Param("key") String key);

  int reserveIdempotency(
      @Param("organizationId") String organizationId,
      @Param("scope") String scope,
      @Param("key") String key,
      @Param("hash") String hash);

  int completeIdempotency(
      @Param("organizationId") String organizationId,
      @Param("scope") String scope,
      @Param("key") String key,
      @Param("hash") String hash,
      @Param("status") int status,
      @Param("body") JsonNode body,
      @Param("resourceId") String resourceId);

  int abandonIdempotency(
      @Param("organizationId") String organizationId,
      @Param("scope") String scope,
      @Param("key") String key,
      @Param("hash") String hash);

  int setCheckpoint(
      @Param("organizationId") String organizationId,
      @Param("runId") String runId,
      @Param("checkpointKey") String checkpointKey);

  Optional<String> findCheckpoint(
      @Param("organizationId") String organizationId,
      @Param("runId") String runId,
      @Param("checkpointKey") String checkpointKey);

  Optional<ModelCredential> findRunCredential(
      @Param("organizationId") String organizationId, @Param("runId") String runId);

  List<Approval> listPendingApprovals(@Param("organizationId") String organizationId);

  Optional<Approval> lockApproval(
      @Param("organizationId") String organizationId, @Param("id") String id);

  int expireApproval(@Param("organizationId") String organizationId, @Param("id") String id);

  int decideApproval(Approval row);

  int insertApprovalDecidedEvent(
      @Param("publicEventId") String publicEventId,
      @Param("organizationId") String organizationId,
      @Param("projectId") String projectId,
      @Param("taskId") String taskId,
      @Param("runId") String runId,
      @Param("payload") JsonNode payload);

  int requeueRunAfterApproval(
      @Param("organizationId") String organizationId, @Param("runId") String runId);

  int releaseLeaseAfterApproval(
      @Param("organizationId") String organizationId, @Param("runId") String runId);

  void insertAudit(
      @Param("organizationId") String organizationId,
      @Param("userId") String userId,
      @Param("action") String action,
      @Param("resourceType") String resourceType,
      @Param("resourceId") String resourceId,
      @Param("payload") JsonNode payload);

  Optional<Approval> nextWorkerApproval(
      @Param("organizationId") String organizationId,
      @Param("runId") String runId,
      @Param("generation") int generation);

  int markApprovalDelivered(
      @Param("organizationId") String organizationId,
      @Param("id") String id,
      @Param("generation") int generation,
      @Param("consumptionKey") String consumptionKey);
}
