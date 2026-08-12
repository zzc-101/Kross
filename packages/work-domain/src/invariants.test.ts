import { describe, expect, it } from 'vitest';

import { DomainInvariantError } from './errors';
import {
  assertApprovalCanBeDecided,
  assertArtifactReadyMetadata,
  assertNewArtifactRevision,
  assertNewSourceRevision,
  assertOrganizationBoundary,
  assertSingleActiveRunPerTask,
  assertSourceReadyMetadata,
  assertTaskCanStartRun,
  classifyApprovalConsumption,
  classifyApprovalDecision,
  prepareApprovalConsumptionSnapshot
} from './invariants';
import type { Approval, Artifact, Source } from './types';

const now = '2026-08-12T08:00:00.000Z';
const hash = 'a'.repeat(64);

function createApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: 'approval-1',
    organizationId: 'org-1',
    projectId: 'project-1',
    taskId: 'task-1',
    runId: 'run-1',
    kind: 'external_action',
    scope: 'run',
    status: 'approved',
    riskLevel: 'high',
    actionPreview: '发送报告',
    target: {
      type: 'external_action',
      actionType: 'email.send',
      idempotencyKey: 'external-1',
      argumentsHash: hash
    },
    requestHash: hash,
    requestedAt: now,
    decidedBy: 'user-1',
    decidedAt: now,
    decisionIdempotencyKey: 'decision-1',
    ...overrides
  };
}

function createSource(overrides: Partial<Source> = {}): Source {
  return {
    id: 'source-1',
    organizationId: 'org-1',
    projectId: 'project-1',
    kind: 'upload',
    scope: 'project',
    status: 'ready',
    displayName: 'input.csv',
    mimeType: 'text/csv',
    sizeBytes: 10,
    sha256: hash,
    blobKey: 'sources/source-1',
    origin: { label: '用户上传' },
    createdBy: 'user-1',
    createdAt: now,
    ...overrides
  } as Source;
}

function createArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: 'artifact-1',
    organizationId: 'org-1',
    projectId: 'project-1',
    taskId: 'task-1',
    runId: 'run-1',
    kind: 'document',
    status: 'ready',
    displayName: 'report.md',
    mimeType: 'text/markdown',
    sizeBytes: 100,
    sha256: hash,
    blobKey: 'artifacts/artifact-1',
    sourceIds: ['source-1'],
    createdAt: now,
    ...overrides
  };
}

describe('同 Task 活跃 Run 不变量', () => {
  it('允许不同 Task 各有一个活跃 Run，也允许历史终态 Run', () => {
    expect(() =>
      assertSingleActiveRunPerTask([
        { id: 'run-1', taskId: 'task-1', status: 'running' },
        { id: 'run-2', taskId: 'task-1', status: 'completed' },
        { id: 'run-3', taskId: 'task-2', status: 'queued' }
      ])
    ).not.toThrow();
  });

  it('拒绝同 Task 同时存在两个非终态 Run', () => {
    expect(() =>
      assertSingleActiveRunPerTask([
        { id: 'run-1', taskId: 'task-1', status: 'waiting_for_approval' },
        { id: 'run-2', taskId: 'task-1', status: 'queued' }
      ])
    ).toThrowError(
      expect.objectContaining<Partial<DomainInvariantError>>({ code: 'active_run_conflict' })
    );
  });

  it('创建 Run 前可单独检查现有活跃 Run', () => {
    expect(() =>
      assertTaskCanStartRun({ id: 'task-1', status: 'open' }, [
        { id: 'run-1', taskId: 'task-1', status: 'failed' }
      ])
    ).not.toThrow();
    expect(() =>
      assertTaskCanStartRun({ id: 'task-1', status: 'open' }, [
        { id: 'run-2', taskId: 'task-1', status: 'cancelling' }
      ])
    ).toThrow(DomainInvariantError);
    expect(() =>
      assertTaskCanStartRun({ id: 'task-1', status: 'completed' }, [])
    ).toThrowError(
      expect.objectContaining<Partial<DomainInvariantError>>({ code: 'task_not_open' })
    );
  });
});

describe('Approval 幂等决策与一次性消费', () => {
  it('pending 决策需要应用，同结果重试返回 replay，相反结果冲突', () => {
    expect(classifyApprovalDecision({ status: 'pending' }, 'approved', now)).toEqual({
      kind: 'apply',
      status: 'approved'
    });
    expect(classifyApprovalDecision({ status: 'approved' }, 'approved', now)).toEqual({
      kind: 'replay',
      status: 'approved'
    });
    expect(classifyApprovalDecision({ status: 'approved' }, 'rejected', now)).toEqual({
      kind: 'conflict',
      status: 'approved'
    });
    expect(
      assertApprovalCanBeDecided({ id: 'approval-1', status: 'approved' }, 'approved', now)
    ).toEqual({ kind: 'replay', status: 'approved' });
    expect(() =>
      assertApprovalCanBeDecided({ id: 'approval-1', status: 'expired' }, 'approved', now)
    ).toThrowError(
      expect.objectContaining<Partial<DomainInvariantError>>({
        code: 'approval_decision_conflict'
      })
    );
  });

  it('决策分类必须显式接收合法的服务端时间', () => {
    expect(classifyApprovalDecision({ status: 'pending' }, 'approved', 'invalid')).toEqual({
      kind: 'invalid_time'
    });
    expect(() =>
      assertApprovalCanBeDecided(
        { id: 'approval-1', status: 'pending' },
        'approved',
        'invalid'
      )
    ).toThrow(DomainInvariantError);
  });

  it('拒绝在 expiresAt 之后才到达的决策', () => {
    expect(
      classifyApprovalDecision(
        { status: 'pending', expiresAt: '2026-08-12T08:00:00.000Z' },
        'approved',
        '2026-08-12T08:00:00.000Z'
      )
    ).toEqual({ kind: 'conflict', status: 'expired' });
    expect(() =>
      assertApprovalCanBeDecided(
        {
          id: 'approval-1',
          status: 'pending',
          expiresAt: '2026-08-12T08:00:00.000Z'
        },
        'approved',
        '2026-08-12T08:00:01.000Z'
      )
    ).toThrowError(
      expect.objectContaining<Partial<DomainInvariantError>>({
        code: 'approval_decision_conflict'
      })
    );
  });

  it('approved Approval 第一次消费成功，同幂等键重试不再次执行', () => {
    const first = prepareApprovalConsumptionSnapshot(createApproval(), {
      requestHash: hash,
      idempotencyKey: 'external-1',
      consumedAt: now
    });
    expect(first.replayed).toBe(false);
    expect(first.approval.consumptionIdempotencyKey).toBe('external-1');

    const replay = prepareApprovalConsumptionSnapshot(first.approval, {
      requestHash: hash,
      idempotencyKey: 'external-1',
      consumedAt: '2026-08-12T08:01:00.000Z'
    });
    expect(replay).toEqual({ approval: first.approval, replayed: true });
  });

  it('拒绝消费未批准、参数哈希变化或已被另一执行消费的 Approval', () => {
    expect(
      classifyApprovalConsumption(createApproval({ status: 'pending' }), {
        requestHash: hash,
        idempotencyKey: 'external-1'
      })
    ).toEqual({ kind: 'not_approved' });
    expect(() =>
      prepareApprovalConsumptionSnapshot(createApproval(), {
        requestHash: 'b'.repeat(64),
        idempotencyKey: 'external-1',
        consumedAt: now
      })
    ).toThrowError(
      expect.objectContaining<Partial<DomainInvariantError>>({
        code: 'approval_request_mismatch'
      })
    );
    expect(() =>
      prepareApprovalConsumptionSnapshot(
        createApproval({ consumedAt: now, consumptionIdempotencyKey: 'external-1' }),
        { requestHash: hash, idempotencyKey: 'external-2', consumedAt: now }
      )
    ).toThrowError(
      expect.objectContaining<Partial<DomainInvariantError>>({
        code: 'approval_already_consumed'
      })
    );
    expect(
      classifyApprovalConsumption(
        createApproval({ consumedAt: now, consumptionIdempotencyKey: 'external-1' }),
        { requestHash: 'b'.repeat(64), idempotencyKey: 'external-1' }
      )
    ).toEqual({ kind: 'request_mismatch' });
    expect(
      classifyApprovalConsumption(createApproval(), {
        requestHash: hash,
        idempotencyKey: 'not-the-target-key'
      })
    ).toEqual({ kind: 'request_mismatch' });
  });
});

describe('Source 与 Artifact 不可变版本链', () => {
  it('ready 内容必须有大小、哈希和对象定位', () => {
    expect(() => assertSourceReadyMetadata(createSource())).not.toThrow();
    expect(() =>
      assertSourceReadyMetadata(createSource({ sha256: undefined }))
    ).toThrowError(
      expect.objectContaining<Partial<DomainInvariantError>>({ code: 'missing_ready_metadata' })
    );
    expect(() => assertArtifactReadyMetadata(createArtifact())).not.toThrow();
    expect(() =>
      assertArtifactReadyMetadata(createArtifact({ mimeType: undefined }))
    ).toThrow(DomainInvariantError);
  });

  it('Source 更新必须创建同租户同 Project 的新版本', () => {
    const previous = createSource();
    expect(() =>
      assertNewSourceRevision(
        previous,
        createSource({ id: 'source-2', previousSourceId: previous.id })
      )
    ).not.toThrow();
    expect(() =>
      assertNewSourceRevision(
        previous,
        createSource({ id: 'source-2', previousSourceId: previous.id, projectId: 'project-2' })
      )
    ).toThrowError(
      expect.objectContaining<Partial<DomainInvariantError>>({ code: 'invalid_source_revision' })
    );
    expect(() =>
      assertNewSourceRevision(
        previous,
        createSource({ id: 'source-2', previousSourceId: previous.id, kind: 'url' })
      )
    ).toThrow(DomainInvariantError);
    expect(() =>
      assertNewSourceRevision(
        previous,
        createSource({
          id: 'source-2',
          previousSourceId: previous.id,
          scope: 'task',
          taskId: 'task-1'
        })
      )
    ).toThrow(DomainInvariantError);
  });

  it('Task scoped Source 修订必须留在同一 Task', () => {
    const previous = createSource({ scope: 'task', taskId: 'task-1' });
    expect(() =>
      assertNewSourceRevision(
        previous,
        createSource({
          id: 'source-2',
          scope: 'task',
          taskId: 'task-1',
          previousSourceId: previous.id
        })
      )
    ).not.toThrow();
    expect(() =>
      assertNewSourceRevision(
        previous,
        createSource({
          id: 'source-2',
          scope: 'task',
          taskId: 'task-2',
          previousSourceId: previous.id
        })
      )
    ).toThrow(DomainInvariantError);
  });

  it('Artifact 修订必须创建同 Task 的新对象并指向 parent', () => {
    const previous = createArtifact();
    expect(() =>
      assertNewArtifactRevision(
        previous,
        createArtifact({
          id: 'artifact-2',
          runId: 'run-2',
          parentArtifactId: previous.id
        })
      )
    ).not.toThrow();
    expect(() =>
      assertNewArtifactRevision(
        previous,
        createArtifact({
          id: 'artifact-2',
          taskId: 'task-2',
          parentArtifactId: previous.id
        })
      )
    ).toThrowError(
      expect.objectContaining<Partial<DomainInvariantError>>({ code: 'invalid_artifact_revision' })
    );
  });
});

describe('租户边界', () => {
  it('允许同组织资源并拒绝跨组织资源', () => {
    expect(() =>
      assertOrganizationBoundary({ organizationId: 'org-1' }, { organizationId: 'org-1' })
    ).not.toThrow();
    expect(() =>
      assertOrganizationBoundary({ organizationId: 'org-1' }, { organizationId: 'org-2' })
    ).toThrowError(
      expect.objectContaining<Partial<DomainInvariantError>>({
        code: 'organization_boundary_violation'
      })
    );
  });
});
