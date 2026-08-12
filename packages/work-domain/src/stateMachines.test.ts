import { describe, expect, it } from 'vitest';

import { DomainInvariantError } from './errors';
import {
  approvalStatuses,
  artifactStatuses,
  runStatuses,
  scheduleStatuses,
  sourceStatuses,
  taskStatuses
} from './schemas';
import {
  approvalStatusTransitions,
  artifactStatusTransitions,
  assertApprovalStatusTransition,
  assertArtifactStatusTransition,
  assertRunStatusTransition,
  assertScheduleStatusTransition,
  assertSourceStatusTransition,
  assertTaskStatusTransition,
  canTransitionApprovalStatus,
  canTransitionArtifactStatus,
  canTransitionRunStatus,
  canTransitionScheduleStatus,
  canTransitionSourceStatus,
  canTransitionTaskStatus,
  isRunActive,
  isRunTerminal,
  runStatusTransitions,
  scheduleStatusTransitions,
  sourceStatusTransitions,
  taskStatusTransitions
} from './stateMachines';

describe('Run 状态机', () => {
  it.each([
    ['queued', 'provisioning'],
    ['queued', 'cancelled'],
    ['provisioning', 'running'],
    ['provisioning', 'cancelling'],
    ['provisioning', 'failed'],
    ['running', 'waiting_for_approval'],
    ['running', 'cancelling'],
    ['running', 'completed'],
    ['running', 'failed'],
    ['running', 'cancelled'],
    ['waiting_for_approval', 'running'],
    ['waiting_for_approval', 'cancelling'],
    ['waiting_for_approval', 'failed'],
    ['waiting_for_approval', 'cancelled'],
    ['cancelling', 'cancelled'],
    ['cancelling', 'failed']
  ] as const)('允许 %s → %s', (from, to) => {
    expect(canTransitionRunStatus(from, to)).toBe(true);
    expect(() => assertRunStatusTransition(from, to)).not.toThrow();
  });

  it.each(['completed', 'failed', 'cancelled'] as const)('终态 %s 不可逆', (status) => {
    expect(runStatusTransitions[status]).toEqual([]);
    expect(isRunTerminal(status)).toBe(true);
    expect(isRunActive(status)).toBe(false);
    expect(() => assertRunStatusTransition(status, 'running')).toThrowError(
      expect.objectContaining<Partial<DomainInvariantError>>({
        code: 'invalid_status_transition'
      })
    );
  });

  it.each([
    'queued',
    'provisioning',
    'running',
    'waiting_for_approval',
    'cancelling'
  ] as const)('把 %s 视为活跃状态', (status) => {
    expect(isRunActive(status)).toBe(true);
    expect(isRunTerminal(status)).toBe(false);
  });

  it('拒绝跳过调度阶段和同状态伪迁移', () => {
    expect(canTransitionRunStatus('queued', 'running')).toBe(false);
    expect(canTransitionRunStatus('running', 'running')).toBe(false);
  });

  it('完整 Run 状态矩阵与声明的迁移表一致', () => {
    for (const from of runStatuses) {
      for (const to of runStatuses) {
        expect(canTransitionRunStatus(from, to), `${from} → ${to}`).toBe(
          runStatusTransitions[from].includes(to as never)
        );
      }
    }
  });
});

describe('其他领域状态机', () => {
  it('允许 Task 完成后因新消息重新打开，但 Archived 不可逆', () => {
    expect(canTransitionTaskStatus('open', 'completed')).toBe(true);
    expect(canTransitionTaskStatus('completed', 'open')).toBe(true);
    expect(taskStatusTransitions.archived).toEqual([]);
    expect(() => assertTaskStatusTransition('archived', 'open')).toThrow(DomainInvariantError);
  });

  it('允许 Source 解析失败后重试，但删除后不可逆', () => {
    expect(canTransitionSourceStatus('uploading', 'processing')).toBe(true);
    expect(canTransitionSourceStatus('processing', 'ready')).toBe(true);
    expect(canTransitionSourceStatus('failed', 'processing')).toBe(true);
    expect(sourceStatusTransitions.deleted).toEqual([]);
    expect(() => assertSourceStatusTransition('deleted', 'processing')).toThrow(
      DomainInvariantError
    );
  });

  it('Approval 只能从 pending 做一次终结性决策', () => {
    for (const status of ['approved', 'rejected', 'expired', 'cancelled'] as const) {
      expect(canTransitionApprovalStatus('pending', status)).toBe(true);
      expect(approvalStatusTransitions[status]).toEqual([]);
      expect(() => assertApprovalStatusTransition(status, 'pending')).toThrow(
        DomainInvariantError
      );
    }
  });

  it('Artifact 就绪或失败后不可覆盖，只能删除', () => {
    expect(canTransitionArtifactStatus('pending', 'ready')).toBe(true);
    expect(canTransitionArtifactStatus('pending', 'failed')).toBe(true);
    expect(canTransitionArtifactStatus('ready', 'pending')).toBe(false);
    expect(canTransitionArtifactStatus('failed', 'pending')).toBe(false);
    expect(artifactStatusTransitions.deleted).toEqual([]);
    expect(() => assertArtifactStatusTransition('deleted', 'ready')).toThrow(
      DomainInvariantError
    );
  });

  it('Schedule 可以暂停和恢复，但删除后不可逆', () => {
    expect(canTransitionScheduleStatus('active', 'paused')).toBe(true);
    expect(canTransitionScheduleStatus('paused', 'active')).toBe(true);
    expect(scheduleStatusTransitions.deleted).toEqual([]);
    expect(() => assertScheduleStatusTransition('deleted', 'active')).toThrow(
      DomainInvariantError
    );
  });

  it('所有其他状态机的完整矩阵与声明一致', () => {
    const cases = [
      [taskStatuses, taskStatusTransitions, canTransitionTaskStatus],
      [sourceStatuses, sourceStatusTransitions, canTransitionSourceStatus],
      [approvalStatuses, approvalStatusTransitions, canTransitionApprovalStatus],
      [artifactStatuses, artifactStatusTransitions, canTransitionArtifactStatus],
      [scheduleStatuses, scheduleStatusTransitions, canTransitionScheduleStatus]
    ] as const;

    for (const [statuses, transitions, canTransition] of cases) {
      for (const from of statuses) {
        for (const to of statuses) {
          expect(
            (canTransition as (source: string, target: string) => boolean)(from, to),
            `${from} → ${to}`
          ).toBe(
            (transitions as Readonly<Record<string, readonly string[]>>)[from]?.includes(to) ??
              false
          );
        }
      }
    }
  });
});
