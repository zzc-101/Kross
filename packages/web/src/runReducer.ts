import type {
  ApprovalSummary,
  ArtifactSummary,
  PublicEventEnvelope,
  PublicToolCall,
  RunSummary,
  TaskMessage
} from '@kross/protocol';

export interface RunViewState {
  run?: RunSummary;
  progress?: { phase: string; message: string; percent?: number };
  messages: TaskMessage[];
  drafts: Record<string, string>;
  tools: Record<string, PublicToolCall>;
  approvals: ApprovalSummary[];
  artifacts: ArtifactSummary[];
  lastEventId?: string;
}

export const initialRunViewState: RunViewState = {
  messages: [], drafts: {}, tools: {}, approvals: [], artifacts: []
};

export type RunViewAction = PublicEventEnvelope | { kind: 'snapshot'; run: RunSummary };

export function reducePublicEvent(state: RunViewState, envelope: RunViewAction): RunViewState {
  if ('kind' in envelope) return { ...state, run: envelope.run };
  if (state.lastEventId === envelope.eventId) return state;
  const { event } = envelope;
  const next = { ...state, lastEventId: envelope.eventId };
  switch (event.type) {
    case 'run.queued': return { ...next, run: event.data };
    case 'run.status_changed':
      return state.run?.id === event.data.runId
        ? { ...next, run: { ...state.run, status: event.data.status } as RunSummary }
        : next;
    case 'run.progress':
      return { ...next, progress: { phase: event.data.phase, message: event.data.message, percent: event.data.percent } };
    case 'run.message_delta':
      return { ...next, drafts: { ...state.drafts, [event.data.messageId]: `${state.drafts[event.data.messageId] ?? ''}${event.data.delta}` } };
    case 'run.message_created':
      return { ...next, messages: upsert(state.messages, event.data), drafts: omit(state.drafts, event.data.id) };
    case 'run.tool_started':
    case 'run.tool_completed':
      return { ...next, tools: { ...state.tools, [event.data.toolCallId]: event.data } };
    case 'run.approval_requested':
      return {
        ...next,
        approvals: upsert(state.approvals, {
          id: event.data.id,
          organizationId: event.data.organizationId,
          projectId: event.data.projectId,
          taskId: event.data.taskId,
          runId: event.data.runId,
          kind: event.data.target.type,
          scope: event.data.scope,
          riskLevel: event.data.riskLevel,
          actionPreview: event.data.actionPreview,
          status: 'pending',
          requestedAt: event.data.requestedAt,
          expiresAt: event.data.expiresAt
        })
      };
    case 'approval.decided':
      return { ...next, approvals: upsert(state.approvals, event.data) };
    case 'artifact.ready':
      return { ...next, artifacts: upsert(state.artifacts, event.data) };
    case 'run.completed': return { ...next, run: event.data, progress: undefined };
    default: return next;
  }
}

function upsert<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  return index < 0 ? [...items, item] : items.map((candidate, position) => position === index ? item : candidate);
}

function omit(record: Record<string, string>, key: string): Record<string, string> {
  const { [key]: _removed, ...rest } = record;
  return rest;
}
