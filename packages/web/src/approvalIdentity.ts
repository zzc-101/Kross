import type { SessionSnapshot } from '@kross/protocol/legacy';

type PendingApproval = NonNullable<SessionSnapshot['pendingApproval']>;

export function approvalIdentity(
  approval: Pick<PendingApproval, 'runId' | 'toolCallId'>
): string {
  return `${approval.runId}:${approval.toolCallId}`;
}
