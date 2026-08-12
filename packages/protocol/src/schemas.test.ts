import { describe, expect, it } from 'vitest';

import {
  PROTOCOL_LIMITS,
  PROTOCOL_VERSION,
  approvalDecisionMessageSchema,
  approvalSnapshotSchema,
  artifactCommitMessageSchema,
  artifactReserveMessageSchema,
  artifactSnapshotSchema,
  internalWorkerMessageSchema,
  paginationQuerySchema,
  publicEventEnvelopeSchema,
  runSnapshotSchema,
  runSpecSchema,
  sourceSnapshotSchema,
  taskSnapshotSchema,
  workerRunEventEnvelopeSchema
} from './index';
import { clientCommandSchema } from './legacy';

const now = '2026-08-12T08:00:00.000Z';
const sha256 = 'a'.repeat(64);

describe('Work Protocol v2 resources', () => {
  it('uses v2 and rejects legacy wire versions', () => {
    expect(PROTOCOL_VERSION).toBe(2);
    expect(
      publicEventEnvelopeSchema.safeParse({
        ...publicEnvelope(),
        protocolVersion: 1
      }).success
    ).toBe(false);
  });

  it('validates bounded cursor pagination', () => {
    expect(paginationQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(paginationQuerySchema.parse({ cursor: 'opaque-next', limit: 100 })).toEqual({
      cursor: 'opaque-next',
      limit: 100
    });
    expect(paginationQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(
      paginationQuerySchema.safeParse({
        cursor: 'x'.repeat(PROTOCOL_LIMITS.cursorChars + 1)
      }).success
    ).toBe(false);
  });

  it('validates authoritative Task, Run, Source, Artifact, and Approval snapshots', () => {
    expect(taskSnapshotSchema.parse(taskSnapshot()).id).toBe('task_1');
    expect(runSnapshotSchema.parse(runSnapshot()).status).toBe('running');
    expect(sourceSnapshotSchema.parse(sourceSnapshot()).status).toBe('ready');
    expect(artifactSnapshotSchema.parse(artifactSnapshot()).status).toBe('ready');
    expect(approvalSnapshotSchema.parse(approvalSnapshot()).status).toBe('pending');
  });

  it('rejects oversized inline fields and unbounded unknown payloads', () => {
    expect(
      taskSnapshotSchema.safeParse({
        ...taskSnapshot(),
        objective: 'x'.repeat(PROTOCOL_LIMITS.inlineTextChars + 1)
      }).success
    ).toBe(false);
    expect(
      artifactSnapshotSchema.safeParse({
        ...artifactSnapshot(),
        binary: 'base64-is-not-part-of-the-event-contract'
      }).success
    ).toBe(false);
  });
});

describe('Public Event API v2', () => {
  it('validates replayable SSE envelopes with opaque cursors', () => {
    const parsed = publicEventEnvelopeSchema.parse(publicEnvelope());
    expect(parsed.eventId).toBe('cursor_01');
    expect(parsed.event.type).toBe('run.progress');
  });

  it('accepts task, message, tool, approval, artifact, and notification event families', () => {
    const variants = [
      {
        type: 'task.created',
        data: {
          id: 'task_1', organizationId: 'org_1', projectId: 'project_1',
          type: 'research', status: 'open', title: 'Research', objectivePreview: 'Compare',
          messageCount: 1, createdBy: 'user_1', createdAt: now, updatedAt: now
        }
      },
      {
        type: 'run.message_delta',
        data: {
          organizationId: 'org_1', projectId: 'project_1', taskId: 'task_1',
          runId: 'run_1', messageId: 'message_1', index: 1, delta: 'hello'
        }
      },
      {
        type: 'run.tool_started',
        data: {
          toolCallId: 'tool_1', name: 'search', displayName: 'Search', status: 'running',
          risk: 'low', startedAt: now, organizationId: 'org_1',
          projectId: 'project_1', taskId: 'task_1', runId: 'run_1'
        }
      },
      { type: 'run.approval_requested', data: approvalSnapshot() },
      {
        type: 'artifact.ready',
        data: {
          id: 'artifact_1', organizationId: 'org_1', projectId: 'project_1',
          taskId: 'task_1', runId: 'run_1', kind: 'document', status: 'ready',
          displayName: 'Report.md', mimeType: 'text/markdown', sizeBytes: 12,
          createdAt: now
        }
      },
      {
        type: 'notification.created',
        data: {
          id: 'notification_1', organizationId: 'org_1', type: 'run_completed',
          title: 'Run complete', body: 'Your report is ready.', runId: 'run_1', createdAt: now
        }
      }
    ] as const;

    for (const event of variants) {
      expect(
        publicEventEnvelopeSchema.safeParse({ ...publicEnvelope(), event }).success
      ).toBe(true);
    }
  });

  it('rejects unknown event variants and oversized deltas', () => {
    expect(
      publicEventEnvelopeSchema.safeParse({
        ...publicEnvelope(),
        event: { type: 'workspace.updated', data: {} }
      }).success
    ).toBe(false);
    expect(
      publicEventEnvelopeSchema.safeParse({
        ...publicEnvelope(),
        event: {
          type: 'run.message_delta',
          data: {
            runId: 'run_1', messageId: 'message_1', index: 1,
            organizationId: 'org_1', projectId: 'project_1', taskId: 'task_1',
            delta: 'x'.repeat(PROTOCOL_LIMITS.messageDeltaChars + 1)
          }
        }
      }).success
    ).toBe(false);
  });
});

describe('Internal Worker Protocol v2', () => {
  it('validates immutable RunSpec and worker registration', () => {
    const spec = runSpecSchema.parse(runSpec());
    expect(spec.generation).toBe(3);
    expect(spec.workspace.outputDirectory).toBe('/work/output');

    expect(
      internalWorkerMessageSchema.parse({
        protocolVersion: 2,
        messageId: 'wire_1',
        sentAt: now,
        type: 'worker.registered',
        workerSessionId: 'session_1',
        heartbeatIntervalMs: 5_000,
        runSpec: spec
      }).type
    ).toBe('worker.registered');
  });

  it('uses generation and sequence as explicit event identity', () => {
    const event = workerRunEventEnvelopeSchema.parse({
      protocolVersion: 2,
      runId: 'run_1',
      generation: 3,
      seq: 7,
      timestamp: now,
      event: { type: 'run.progress', phase: 'executing', message: 'Working' }
    });
    expect([event.runId, event.generation, event.seq]).toEqual(['run_1', 3, 7]);
    expect(
      workerRunEventEnvelopeSchema.safeParse({ ...event, seq: 0 }).success
    ).toBe(false);
    expect(
      workerRunEventEnvelopeSchema.safeParse({ ...event, generation: 0 }).success
    ).toBe(false);
  });

  it('validates one-time approval decisions with input digest binding', () => {
    const parsed = approvalDecisionMessageSchema.parse({
      protocolVersion: 2,
      messageId: 'wire_approval_1',
      sentAt: now,
      type: 'approval.decision',
      decisionId: 'decision-key-1',
      runId: 'run_1',
      generation: 3,
      approvalId: 'approval_1',
      decision: 'approved',
      decidedAt: now,
      requestHash: sha256
    });
    expect(parsed.decisionId).toBe('decision-key-1');
  });

  it('validates Artifact reserve and commit without binary event payloads', () => {
    expect(
      artifactReserveMessageSchema.safeParse({
        protocolVersion: 2,
        messageId: 'wire_artifact_1',
        sentAt: now,
        type: 'artifact.reserve',
        idempotencyKey: 'reserve-key-1',
        runId: 'run_1',
        generation: 3,
        taskId: 'task_1',
        kind: 'document',
        displayName: 'Report.md',
        mimeType: 'text/markdown',
        sizeBytes: 12,
        sha256,
        sourceIds: ['source_1']
      }).success
    ).toBe(true);
    expect(
      artifactCommitMessageSchema.safeParse({
        protocolVersion: 2,
        messageId: 'wire_artifact_2',
        sentAt: now,
        type: 'artifact.commit',
        idempotencyKey: 'commit-key-1',
        runId: 'run_1',
        generation: 3,
        artifactId: 'artifact_1',
        sizeBytes: 12,
        sha256
      }).success
    ).toBe(true);
  });

  it('isolates the unfinished Cloud consumers on the fixed legacy v1 shape', () => {
    expect(
      clientCommandSchema.safeParse({
        protocolVersion: 1,
        requestId: 'legacy_request_1',
        type: 'workspace.list'
      }).success
    ).toBe(true);
    expect(
      clientCommandSchema.safeParse({
        protocolVersion: 2,
        requestId: 'legacy_request_1',
        type: 'workspace.list'
      }).success
    ).toBe(false);
  });
});

function publicEnvelope() {
  return {
    protocolVersion: 2,
    eventId: 'cursor_01',
    timestamp: now,
    event: {
      type: 'run.progress',
      data: {
        organizationId: 'org_1', projectId: 'project_1', taskId: 'task_1',
        runId: 'run_1', phase: 'executing', message: 'Working', percent: 25
      }
    }
  } as const;
}

function taskSnapshot() {
  return {
    id: 'task_1', organizationId: 'org_1', projectId: 'project_1', type: 'research',
    status: 'open', title: 'Research', objective: 'Compare the options', constraints: [],
    acceptanceCriteria: ['Citations are included'], messageCount: 1, runCount: 1,
    sourceCount: 1, artifactCount: 0, createdBy: 'user_1', createdAt: now, updatedAt: now
  } as const;
}

function runSnapshot() {
  return {
    id: 'run_1', organizationId: 'org_1', projectId: 'project_1', taskId: 'task_1',
    attempt: 1, status: 'running', mode: 'auto', executionProfile: 'work',
    model: { provider: 'openai', model: 'gpt-test' },
    permissionPolicy: permissionPolicy(), resourceLimits: resourceLimits(),
    usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, durationMs: 0, toolCalls: 0 },
    checkpointAvailable: false, workerGeneration: 3, createdAt: now, queuedAt: now,
    startedAt: now
  } as const;
}

function sourceSnapshot() {
  return {
    id: 'source_1', organizationId: 'org_1', projectId: 'project_1',
    scope: 'task', taskId: 'task_1', kind: 'upload', status: 'ready',
    displayName: 'brief.txt', mimeType: 'text/plain', sizeBytes: 12, sha256,
    origin: { kind: 'upload', originalFileName: 'brief.txt' },
    parsedTextAvailable: true, previewAvailable: true, createdBy: 'user_1',
    createdAt: now
  } as const;
}

function artifactSnapshot() {
  return {
    id: 'artifact_1', organizationId: 'org_1', projectId: 'project_1', taskId: 'task_1',
    runId: 'run_1', kind: 'document', status: 'ready', displayName: 'Report.md',
    mimeType: 'text/markdown', sizeBytes: 12, sha256,
    sourceIds: ['source_1'], previewAvailable: true,
    downloadPath: '/api/v2/artifacts/artifact_1/content', createdAt: now, readyAt: now
  } as const;
}

function approvalSnapshot() {
  return {
    id: 'approval_1', organizationId: 'org_1', projectId: 'project_1', taskId: 'task_1',
    runId: 'run_1', scope: 'run', status: 'pending',
    riskLevel: 'high', actionPreview: 'Send the report to customer@example.com.',
    target: {
      type: 'external_action', actionType: 'email.send',
      idempotencyKey: 'send-report-1', argumentsHash: sha256
    },
    requestedAt: now
  } as const;
}

function resourceLimits() {
  return {
    cpuMillis: 2_000, memoryBytes: 1_073_741_824, maxPids: 512,
    diskBytes: 10_737_418_240, maxDurationMs: 600_000,
    maxSourceBytes: 104_857_600, maxArtifactBytes: 104_857_600,
    maxEventPayloadBytes: 65_536
  } as const;
}

function permissionPolicy() {
  return {
    version: 1,
    allowNetworkAccess: true,
    allowRepositoryWrite: false,
    allowedConnectorScopes: [],
    approvalPolicy: {
      requirePlanApproval: false,
      requireExternalActionApproval: true,
      minimumToolRiskRequiringApproval: 'high',
      allowAdminOrganizationHighRiskApproval: true,
      allowMemberHighRiskApproval: false
    }
  } as const;
}

function runSpec() {
  return {
    protocolVersion: 2,
    organizationId: 'org_1', projectId: 'project_1', taskId: 'task_1', runId: 'run_1',
    generation: 3, leaseId: 'lease_1', leaseExpiresAt: now, issuedAt: now,
    task: {
      type: 'research', title: 'Research', objective: 'Compare the options', constraints: [],
      acceptanceCriteria: ['Citations are included'], messages: []
    },
    sources: [{
      id: 'source_1', kind: 'upload', displayName: 'brief.txt', fileName: 'brief.txt',
      mimeType: 'text/plain', sizeBytes: 12, sha256,
      downloadUrl: 'https://blob.example.test/source_1', downloadHeaders: [], expiresAt: now
    }],
    model: { provider: 'openai', model: 'gpt-test', credentialHandle: 'credential_1' },
    mode: 'auto', executionProfile: 'work',
    policy: {
      permissionPolicy: permissionPolicy(), allowedToolNames: ['search'], connectorInstallationIds: [],
      externalActions: 'require_approval', networkAccess: 'restricted'
    },
    resourceLimits: resourceLimits(),
    workspace: {
      root: '/work', inputDirectory: '/work/input', outputDirectory: '/work/output',
      checkpointDirectory: '/work/checkpoint'
    }
  } as const;
}
