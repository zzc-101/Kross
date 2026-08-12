import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  approvalSchema,
  artifactSchema,
  completeSourceUploadInputSchema,
  createProjectInputSchema,
  createScheduleInputSchema,
  createSourceInputSchema,
  createTaskInputSchema,
  finalizeSourceInputSchema,
  identifierSchema,
  runSchema,
  runEventSchema,
  scheduleSchema,
  sourceSchema,
  taskSchema,
  taskMessageSchema
} from './schemas';
import type {
  Approval,
  Artifact,
  ConnectorInstallation,
  Membership,
  Organization,
  Project,
  Run,
  RunEvent,
  Schedule,
  Source,
  Task,
  TaskMessage
} from './types';

const hash = 'a'.repeat(64);

describe('Work Domain schema', () => {
  it('keeps opaque identifiers compatible with Protocol resource IDs', () => {
    expect(identifierSchema.safeParse('run_123-abc').success).toBe(true);
    expect(identifierSchema.safeParse('run/../../../tenant-b').success).toBe(false);
    expect(identifierSchema.safeParse('包含空格').success).toBe(false);
    expect(identifierSchema.safeParse(`r${'x'.repeat(128)}`).success).toBe(false);
  });
  it('公开全部核心实体类型', () => {
    expectTypeOf<Organization>().toBeObject();
    expectTypeOf<Membership>().toBeObject();
    expectTypeOf<Project>().toBeObject();
    expectTypeOf<Source>().toBeObject();
    expectTypeOf<Task>().toBeObject();
    expectTypeOf<TaskMessage>().toBeObject();
    expectTypeOf<Run>().toBeObject();
    expectTypeOf<RunEvent>().toBeObject();
    expectTypeOf<Approval>().toBeObject();
    expectTypeOf<Artifact>().toBeObject();
    expectTypeOf<ConnectorInstallation>().toBeObject();
    expectTypeOf<Schedule>().toBeObject();
  });

  it('Project kind 决定 repository binding 是否必需', () => {
    expect(
      createProjectInputSchema.safeParse({
        kind: 'general',
        name: '市场研究',
        defaultPermissionPolicy: {
          version: 1,
          allowNetworkAccess: true,
          allowRepositoryWrite: false,
          allowedConnectorScopes: [],
          approvalPolicy: {
            requirePlanApproval: false,
            requireExternalActionApproval: true,
            minimumToolRiskRequiringApproval: 'high',
            allowAdminOrganizationHighRiskApproval: false,
            allowMemberHighRiskApproval: false
          }
        },
        defaultTaskType: 'research'
      }).success
    ).toBe(true);
    expect(
      createProjectInputSchema.safeParse({
        kind: 'repository',
        name: '代码仓库',
        defaultPermissionPolicy: {
          version: 1,
          allowNetworkAccess: true,
          allowRepositoryWrite: true,
          allowedConnectorScopes: [],
          approvalPolicy: {
            requirePlanApproval: false,
            requireExternalActionApproval: true,
            minimumToolRiskRequiringApproval: 'high',
            allowAdminOrganizationHighRiskApproval: false,
            allowMemberHighRiskApproval: false
          }
        },
        defaultTaskType: 'coding'
      }).success
    ).toBe(false);
  });

  it('Task scoped Source 必须携带 taskId，project scoped Source 拒绝多余 taskId', () => {
    const base = {
      projectId: 'project-1',
      kind: 'upload',
      displayName: 'input.pdf',
      origin: { label: '用户上传' }
    };
    expect(createSourceInputSchema.safeParse({ ...base, scope: 'task' }).success).toBe(false);
    expect(
      createSourceInputSchema.safeParse({ ...base, scope: 'task', taskId: 'task-1' }).success
    ).toBe(true);
    expect(
      createSourceInputSchema.safeParse({ ...base, scope: 'project', taskId: 'task-1' }).success
    ).toBe(false);
    expect(
      createSourceInputSchema.safeParse({
        ...base,
        scope: 'project',
        blobKey: 'server-only',
        externalLocator: 'server-only'
      }).success
    ).toBe(false);
  });

  it('上传 complete 与内部 finalize 输入和浏览器 create 分离', () => {
    expect(
      completeSourceUploadInputSchema.safeParse({
        sourceId: 'source-1',
        sizeBytes: 100,
        sha256: hash
      }).success
    ).toBe(true);
    expect(
      finalizeSourceInputSchema.safeParse({
        sourceId: 'source-1',
        status: 'ready',
        sizeBytes: 100,
        sha256: hash,
        blobKey: 'sources/source-1'
      }).success
    ).toBe(true);
    expect(
      finalizeSourceInputSchema.safeParse({
        sourceId: 'source-1',
        status: 'ready',
        sizeBytes: 100,
        sha256: hash
      }).success
    ).toBe(false);
  });

  it('Task 和 TaskMessage 保持结构化输入契约', () => {
    expect(
      createTaskInputSchema.safeParse({
        projectId: 'project-1',
        type: 'document',
        title: '生成报告',
        objective: '生成一份项目报告',
        constraints: [],
        acceptanceCriteria: ['包含摘要']
      }).success
    ).toBe(true);
    expect(
      taskMessageSchema.safeParse({
        id: 'message-1',
        organizationId: 'org-1',
        projectId: 'project-1',
        taskId: 'task-1',
        role: 'user',
        content: [
          { type: 'text', text: '请总结' },
          { type: 'source_reference', sourceId: 'source-1' }
        ],
        createdBy: 'user-1',
        createdAt: '2026-08-12T08:00:00.000Z'
      }).success
    ).toBe(true);

    const task = {
      id: 'task-1',
      organizationId: 'org-1',
      projectId: 'project-1',
      type: 'general',
      title: '研究任务',
      objective: '给出结论',
      constraints: [],
      acceptanceCriteria: [],
      status: 'completed',
      createdBy: 'user-1',
      createdAt: '2026-08-12T08:00:00.000Z',
      updatedAt: '2026-08-12T09:00:00.000Z'
    };
    expect(taskSchema.safeParse(task).success).toBe(false);
    expect(
      taskSchema.safeParse({ ...task, completedAt: '2026-08-12T09:00:00.000Z' })
        .success
    ).toBe(true);
  });

  it('RunEvent 只接受 JSON payload，并要求幂等序号信息', () => {
    const valid = {
      eventId: 'event-1',
      organizationId: 'org-1',
      projectId: 'project-1',
      taskId: 'task-1',
      runId: 'run-1',
      workerGeneration: 1,
      seq: 1,
      type: 'run.queued',
      timestamp: '2026-08-12T08:00:00.000Z',
      payload: { sourceIds: ['source-1'] }
    };
    expect(runEventSchema.safeParse(valid).success).toBe(true);
    expect(runEventSchema.safeParse({ ...valid, payload: { invalid: undefined } }).success).toBe(
      false
    );
    expect(runEventSchema.safeParse({ ...valid, seq: 0 }).success).toBe(false);
  });

  it('Source ready 状态必须带完整不可变内容元数据', () => {
    const source = {
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
      createdAt: '2026-08-12T08:00:00.000Z'
    };
    expect(sourceSchema.safeParse(source).success).toBe(true);
    expect(sourceSchema.safeParse({ ...source, sha256: undefined }).success).toBe(false);
    expect(
      sourceSchema.safeParse({ ...source, blobKey: undefined, externalLocator: undefined }).success
    ).toBe(false);
  });

  it('Run schema 校验 active/terminal 时间和 failure 字段', () => {
    const run = {
      id: 'run-1',
      organizationId: 'org-1',
      projectId: 'project-1',
      taskId: 'task-1',
      attempt: 1,
      status: 'queued',
      mode: 'auto',
      model: { provider: 'openai', model: 'gpt-5' },
      executionProfile: 'work',
      permissionPolicy: {
        version: 1,
        allowNetworkAccess: true,
        allowRepositoryWrite: false,
        allowedConnectorScopes: [],
        approvalPolicy: {
          requirePlanApproval: false,
          requireExternalActionApproval: true,
          minimumToolRiskRequiringApproval: 'high',
          allowAdminOrganizationHighRiskApproval: false,
          allowMemberHighRiskApproval: false
        }
      },
      resourceLimits: {
        cpuMillis: 1000,
        memoryBytes: 1024,
        maxPids: 10,
        diskBytes: 1024,
        maxDurationMs: 60_000,
        maxSourceBytes: 1024,
        maxArtifactBytes: 1024,
        maxEventPayloadBytes: 1024
      },
      selectedSourceIds: [],
      queuedAt: '2026-08-12T08:00:00.000Z',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
        durationMs: 0,
        toolCalls: 0
      },
      createdBy: 'user-1',
      createdAt: '2026-08-12T08:00:00.000Z'
    };
    expect(runSchema.safeParse(run).success).toBe(true);
    expect(runSchema.safeParse({ ...run, finishedAt: '2026-08-12T08:01:00.000Z' }).success).toBe(
      false
    );
    expect(runSchema.safeParse({ ...run, status: 'running' }).success).toBe(false);
    expect(
      runSchema.safeParse({
        ...run,
        status: 'completed',
        startedAt: '2026-08-12T08:01:00.000Z',
        finishedAt: '2026-08-12T08:02:00.000Z'
      }).success
    ).toBe(true);
    expect(
      runSchema.safeParse({
        ...run,
        status: 'completed',
        startedAt: '2026-08-12T08:01:00.000Z'
      }).success
    ).toBe(false);
    expect(
      runSchema.safeParse({
        ...run,
        status: 'failed',
        finishedAt: '2026-08-12T08:02:00.000Z'
      }).success
    ).toBe(false);
    expect(runSchema.safeParse({ ...run, failureCode: 'provider_error' }).success).toBe(false);
    expect(
      runSchema.safeParse({
        ...run,
        status: 'completed',
        startedAt: '2026-08-12T08:02:00.000Z',
        finishedAt: '2026-08-12T08:01:00.000Z'
      }).success
    ).toBe(false);
  });

  it('Approval 和 ready Artifact 形状拒绝无效哈希', () => {
    const approval = {
      id: 'approval-1',
      organizationId: 'org-1',
      projectId: 'project-1',
      taskId: 'task-1',
      runId: 'run-1',
      kind: 'tool',
      scope: 'run',
      status: 'pending',
      riskLevel: 'high',
      actionPreview: '执行工具',
      target: {
        type: 'tool',
        toolCallId: 'tool-call-1',
        toolName: 'browser.click',
        argumentsHash: hash
      },
      requestHash: hash,
      requestedAt: '2026-08-12T08:00:00.000Z'
    };
    expect(approvalSchema.safeParse(approval).success).toBe(true);
    expect(approvalSchema.safeParse({ ...approval, requestHash: 'invalid' }).success).toBe(false);
    expect(
      approvalSchema.safeParse({
        ...approval,
        kind: 'plan',
        target: { type: 'plan', planDigest: hash }
      }).success
    ).toBe(true);
    expect(approvalSchema.safeParse({ ...approval, kind: 'plan' }).success).toBe(false);

    const approved = {
      ...approval,
      status: 'approved',
      decidedBy: 'user-1',
      decidedAt: '2026-08-12T08:01:00.000Z',
      decisionIdempotencyKey: 'decision-1'
    };
    expect(approvalSchema.safeParse(approved).success).toBe(true);
    expect(approvalSchema.safeParse({ ...approved, decidedBy: undefined }).success).toBe(false);
    expect(
      approvalSchema.safeParse({
        ...approval,
        decidedBy: 'user-1',
        decidedAt: '2026-08-12T08:01:00.000Z',
        decisionIdempotencyKey: 'decision-1'
      }).success
    ).toBe(false);
    expect(
      approvalSchema.safeParse({ ...approved, consumedAt: '2026-08-12T08:02:00.000Z' }).success
    ).toBe(false);
    expect(
      approvalSchema.safeParse({
        ...approved,
        consumedAt: '2026-08-12T08:02:00.000Z',
        consumptionIdempotencyKey: 'consume-1'
      }).success
    ).toBe(true);
    expect(
      approvalSchema.safeParse({
        ...approved,
        status: 'rejected',
        consumedAt: '2026-08-12T08:02:00.000Z',
        consumptionIdempotencyKey: 'consume-1'
      }).success
    ).toBe(false);

    const artifact = {
      id: 'artifact-1',
      organizationId: 'org-1',
      projectId: 'project-1',
      taskId: 'task-1',
      runId: 'run-1',
      kind: 'document',
      status: 'ready',
      displayName: 'report.md',
      mimeType: 'text/markdown',
      sizeBytes: 123,
      sha256: hash,
      blobKey: 'artifacts/artifact-1',
      sourceIds: [],
      createdAt: '2026-08-12T08:00:00.000Z'
    };
    expect(artifactSchema.safeParse(artifact).success).toBe(true);
    expect(artifactSchema.safeParse({ ...artifact, sha256: 'BAD' }).success).toBe(false);
    expect(artifactSchema.safeParse({ ...artifact, blobKey: undefined }).success).toBe(false);
  });

  it('Schedule 默认 draft_only，且持久化实体仍要求显式策略', () => {
    const input = {
      projectId: 'project-1',
      name: '每日报告',
      taskTemplate: {
        type: 'research',
        title: '每日研究',
        objective: '汇总每日变化',
        constraints: [],
        acceptanceCriteria: ['包含来源']
      },
      sourceIds: [],
      connectorInstallationIds: [],
      trigger: { type: 'cron', expression: '0 9 * * *', timezone: 'Asia/Shanghai' },
      concurrencyPolicy: 'skip'
    };
    expect(createScheduleInputSchema.parse(input).externalActionPolicy).toBe('draft_only');
    expect(scheduleSchema.safeParse(input).success).toBe(false);
  });
});
