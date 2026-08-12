import { DomainInvariantError } from './errors';
import { isRunActive } from './stateMachines';
import type { Approval, Artifact, Run, Source, Task } from './types';

type RunIdentity = Pick<Run, 'id' | 'taskId' | 'status'>;

export function assertSingleActiveRunPerTask(runs: readonly RunIdentity[]): void {
  const activeRunByTask = new Map<string, string>();

  for (const run of runs) {
    if (!isRunActive(run.status)) {
      continue;
    }

    const existingRunId = activeRunByTask.get(run.taskId);
    if (existingRunId !== undefined) {
      throw new DomainInvariantError(
        'active_run_conflict',
        `Task ${run.taskId} already has active Run ${existingRunId}; persistence must also enforce this with a transaction or partial unique index`,
        { taskId: run.taskId, existingRunId, conflictingRunId: run.id }
      );
    }
    activeRunByTask.set(run.taskId, run.id);
  }
}

export function assertTaskCanStartRun(
  task: Pick<Task, 'id' | 'status'>,
  existingRuns: readonly RunIdentity[]
): void {
  if (task.status !== 'open') {
    throw new DomainInvariantError(
      'task_not_open',
      `Task ${task.id} must be open before starting a Run`,
      { taskId: task.id, taskStatus: task.status }
    );
  }

  const activeRun = existingRuns.find(
    (run) => run.taskId === task.id && isRunActive(run.status)
  );
  if (activeRun !== undefined) {
    throw new DomainInvariantError(
      'active_run_conflict',
      `Task ${task.id} already has active Run ${activeRun.id}; persistence must also enforce this with a transaction or partial unique index`,
      { taskId: task.id, existingRunId: activeRun.id }
    );
  }
}

export type ApprovalDecisionClassification =
  | { kind: 'apply'; status: 'approved' | 'rejected' }
  | { kind: 'replay'; status: 'approved' | 'rejected' }
  | { kind: 'conflict'; status: Exclude<Approval['status'], 'pending'> }
  | { kind: 'invalid_time' };

function isValidIsoDateTime(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
    value
  ) && Number.isFinite(Date.parse(value));
}

export function classifyApprovalDecision(
  approval: Pick<Approval, 'status' | 'expiresAt'>,
  decision: 'approved' | 'rejected',
  decidedAt: string
): ApprovalDecisionClassification {
  if (!isValidIsoDateTime(decidedAt)) {
    return { kind: 'invalid_time' };
  }
  if (approval.status === 'pending') {
    if (
      approval.expiresAt !== undefined &&
      (!isValidIsoDateTime(approval.expiresAt) ||
        Date.parse(approval.expiresAt) <= Date.parse(decidedAt))
    ) {
      return { kind: 'conflict', status: 'expired' };
    }
    return { kind: 'apply', status: decision };
  }
  if (approval.status === decision) {
    return { kind: 'replay', status: decision };
  }
  return { kind: 'conflict', status: approval.status };
}

export function assertApprovalCanBeDecided(
  approval: Pick<Approval, 'id' | 'status' | 'expiresAt'>,
  decision: 'approved' | 'rejected',
  decidedAt: string
): Extract<ApprovalDecisionClassification, { kind: 'apply' | 'replay' }> {
  const classification = classifyApprovalDecision(approval, decision, decidedAt);
  if (classification.kind === 'invalid_time') {
    throw new DomainInvariantError(
      'approval_decision_conflict',
      `Approval ${approval.id} decision requires a valid server-authoritative decidedAt`,
      { approvalId: approval.id, decidedAt }
    );
  }
  if (classification.kind === 'conflict') {
    throw new DomainInvariantError(
      'approval_decision_conflict',
      `Approval ${approval.id} was already resolved as ${classification.status}`,
      { approvalId: approval.id, existingStatus: classification.status, requestedDecision: decision }
    );
  }
  return classification;
}

export interface ApprovalConsumptionRequest {
  requestHash: string;
  idempotencyKey: string;
  consumedAt: string;
}

export type ApprovalConsumptionClassification =
  | { kind: 'apply' }
  | { kind: 'replay' }
  | { kind: 'not_approved' }
  | { kind: 'request_mismatch' }
  | { kind: 'already_consumed' };

export function classifyApprovalConsumption(
  approval: Pick<
    Approval,
    'status' | 'requestHash' | 'target' | 'consumedAt' | 'consumptionIdempotencyKey'
  >,
  request: Pick<ApprovalConsumptionRequest, 'requestHash' | 'idempotencyKey'>
): ApprovalConsumptionClassification {
  if (approval.status !== 'approved') {
    return { kind: 'not_approved' };
  }
  if (
    approval.consumedAt !== undefined &&
    approval.consumptionIdempotencyKey !== request.idempotencyKey
  ) {
    return { kind: 'already_consumed' };
  }
  if (approval.requestHash !== request.requestHash) {
    return { kind: 'request_mismatch' };
  }
  if (
    approval.target.type === 'external_action' &&
    approval.target.idempotencyKey !== request.idempotencyKey
  ) {
    return { kind: 'request_mismatch' };
  }
  if (approval.consumedAt === undefined) {
    return { kind: 'apply' };
  }
  return { kind: 'replay' };
}

/**
 * Prepares an updated Approval snapshot after classifying a consumption request.
 *
 * This pure helper does not make consumption once-only under concurrency. The repository must
 * persist the returned snapshot with compare-and-swap inside a transaction. External actions
 * must use the same idempotency key stored in `approval.target` when invoking the connector.
 */
export function prepareApprovalConsumptionSnapshot(
  approval: Approval,
  request: ApprovalConsumptionRequest
): { approval: Approval; replayed: boolean } {
  const classification = classifyApprovalConsumption(approval, request);
  if (classification.kind === 'replay') {
    return { approval, replayed: true };
  }
  if (classification.kind !== 'apply') {
    const code =
      classification.kind === 'not_approved'
        ? 'approval_not_approved'
        : classification.kind === 'request_mismatch'
          ? 'approval_request_mismatch'
          : 'approval_already_consumed';
    throw new DomainInvariantError(code, `Approval ${approval.id} cannot be consumed`, {
      approvalId: approval.id,
      reason: classification.kind
    });
  }

  return {
    approval: {
      ...approval,
      consumedAt: request.consumedAt,
      consumptionIdempotencyKey: request.idempotencyKey
    },
    replayed: false
  };
}

export function assertSourceReadyMetadata(
  source: Pick<Source, 'id' | 'status' | 'sizeBytes' | 'sha256' | 'blobKey' | 'externalLocator'>
): void {
  if (source.status !== 'ready') {
    return;
  }
  if (
    source.sizeBytes === undefined ||
    source.sha256 === undefined ||
    (source.blobKey === undefined && source.externalLocator === undefined)
  ) {
    throw new DomainInvariantError(
      'missing_ready_metadata',
      `Ready Source ${source.id} is missing immutable content metadata`,
      { sourceId: source.id }
    );
  }
}

export function assertArtifactReadyMetadata(
  artifact: Pick<Artifact, 'id' | 'status' | 'sizeBytes' | 'sha256' | 'blobKey' | 'mimeType'>
): void {
  if (artifact.status !== 'ready') {
    return;
  }
  if (
    artifact.sizeBytes === undefined ||
    artifact.sha256 === undefined ||
    artifact.blobKey === undefined ||
    artifact.mimeType === undefined
  ) {
    throw new DomainInvariantError(
      'missing_ready_metadata',
      `Ready Artifact ${artifact.id} is missing immutable content metadata`,
      { artifactId: artifact.id }
    );
  }
}

export function assertNewSourceRevision(previous: Source, revision: Source): void {
  const taskScopeMatches =
    previous.scope === revision.scope &&
    (previous.scope !== 'task' ||
      (revision.scope === 'task' && revision.taskId === previous.taskId));
  if (
    revision.id === previous.id ||
    revision.previousSourceId !== previous.id ||
    revision.organizationId !== previous.organizationId ||
    revision.projectId !== previous.projectId ||
    revision.kind !== previous.kind ||
    !taskScopeMatches
  ) {
    throw new DomainInvariantError(
      'invalid_source_revision',
      'A Source revision must be a new resource with the same tenant, Project, kind, scope, and scoped Task',
      { previousSourceId: previous.id, revisionSourceId: revision.id }
    );
  }
}

export function assertNewArtifactRevision(previous: Artifact, revision: Artifact): void {
  if (
    revision.id === previous.id ||
    revision.parentArtifactId !== previous.id ||
    revision.organizationId !== previous.organizationId ||
    revision.projectId !== previous.projectId ||
    revision.taskId !== previous.taskId
  ) {
    throw new DomainInvariantError(
      'invalid_artifact_revision',
      'An Artifact revision must be a new resource linked to its parent in the same tenant, Project, and Task',
      { parentArtifactId: previous.id, revisionArtifactId: revision.id }
    );
  }
}

export function assertOrganizationBoundary(
  context: { organizationId: string },
  resource: { organizationId: string }
): void {
  if (context.organizationId !== resource.organizationId) {
    throw new DomainInvariantError(
      'organization_boundary_violation',
      'Resource does not belong to the active organization',
      {
        contextOrganizationId: context.organizationId,
        resourceOrganizationId: resource.organizationId
      }
    );
  }
}
