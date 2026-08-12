import { DomainInvariantError } from './errors';
import type {
  ApprovalStatus,
  ArtifactStatus,
  RunStatus,
  ScheduleStatus,
  SourceStatus,
  TaskStatus
} from './types';

type TransitionMap<Status extends string> = Readonly<Record<Status, readonly Status[]>>;

function canTransition<Status extends string>(
  transitions: TransitionMap<Status>,
  from: Status,
  to: Status
): boolean {
  return transitions[from].includes(to);
}

function assertTransition<Status extends string>(
  entity: string,
  transitions: TransitionMap<Status>,
  from: Status,
  to: Status
): void {
  if (!canTransition(transitions, from, to)) {
    throw new DomainInvariantError(
      'invalid_status_transition',
      `${entity} cannot transition from ${from} to ${to}`,
      { entity, from, to }
    );
  }
}

export const runStatusTransitions = {
  queued: ['provisioning', 'cancelled'],
  provisioning: ['running', 'cancelling', 'failed'],
  running: ['waiting_for_approval', 'cancelling', 'completed', 'failed', 'cancelled'],
  waiting_for_approval: ['running', 'cancelling', 'failed', 'cancelled'],
  cancelling: ['cancelled', 'failed'],
  completed: [],
  failed: [],
  cancelled: []
} as const satisfies TransitionMap<RunStatus>;

export const taskStatusTransitions = {
  open: ['completed', 'cancelled', 'archived'],
  completed: ['open', 'archived'],
  cancelled: ['open', 'archived'],
  archived: []
} as const satisfies TransitionMap<TaskStatus>;

export const sourceStatusTransitions = {
  uploading: ['processing', 'failed', 'deleted'],
  processing: ['ready', 'failed', 'deleted'],
  ready: ['deleted'],
  failed: ['processing', 'deleted'],
  deleted: []
} as const satisfies TransitionMap<SourceStatus>;

export const approvalStatusTransitions = {
  pending: ['approved', 'rejected', 'expired', 'cancelled'],
  approved: [],
  rejected: [],
  expired: [],
  cancelled: []
} as const satisfies TransitionMap<ApprovalStatus>;

export const artifactStatusTransitions = {
  pending: ['ready', 'failed', 'deleted'],
  ready: ['deleted'],
  failed: ['deleted'],
  deleted: []
} as const satisfies TransitionMap<ArtifactStatus>;

export const scheduleStatusTransitions = {
  active: ['paused', 'deleted'],
  paused: ['active', 'deleted'],
  deleted: []
} as const satisfies TransitionMap<ScheduleStatus>;

export const activeRunStatuses = [
  'queued',
  'provisioning',
  'running',
  'waiting_for_approval',
  'cancelling'
] as const satisfies readonly RunStatus[];

export const terminalRunStatuses = [
  'completed',
  'failed',
  'cancelled'
] as const satisfies readonly RunStatus[];

export function isRunActive(status: RunStatus): boolean {
  return (activeRunStatuses as readonly RunStatus[]).includes(status);
}

export function isRunTerminal(status: RunStatus): boolean {
  return (terminalRunStatuses as readonly RunStatus[]).includes(status);
}

export function canTransitionRunStatus(from: RunStatus, to: RunStatus): boolean {
  return canTransition(runStatusTransitions, from, to);
}

export function assertRunStatusTransition(from: RunStatus, to: RunStatus): void {
  assertTransition('Run', runStatusTransitions, from, to);
}

export function canTransitionTaskStatus(from: TaskStatus, to: TaskStatus): boolean {
  return canTransition(taskStatusTransitions, from, to);
}

export function assertTaskStatusTransition(from: TaskStatus, to: TaskStatus): void {
  assertTransition('Task', taskStatusTransitions, from, to);
}

export function canTransitionSourceStatus(from: SourceStatus, to: SourceStatus): boolean {
  return canTransition(sourceStatusTransitions, from, to);
}

export function assertSourceStatusTransition(from: SourceStatus, to: SourceStatus): void {
  assertTransition('Source', sourceStatusTransitions, from, to);
}

export function canTransitionApprovalStatus(from: ApprovalStatus, to: ApprovalStatus): boolean {
  return canTransition(approvalStatusTransitions, from, to);
}

export function assertApprovalStatusTransition(from: ApprovalStatus, to: ApprovalStatus): void {
  assertTransition('Approval', approvalStatusTransitions, from, to);
}

export function canTransitionArtifactStatus(from: ArtifactStatus, to: ArtifactStatus): boolean {
  return canTransition(artifactStatusTransitions, from, to);
}

export function assertArtifactStatusTransition(from: ArtifactStatus, to: ArtifactStatus): void {
  assertTransition('Artifact', artifactStatusTransitions, from, to);
}

export function canTransitionScheduleStatus(from: ScheduleStatus, to: ScheduleStatus): boolean {
  return canTransition(scheduleStatusTransitions, from, to);
}

export function assertScheduleStatusTransition(from: ScheduleStatus, to: ScheduleStatus): void {
  assertTransition('Schedule', scheduleStatusTransitions, from, to);
}
