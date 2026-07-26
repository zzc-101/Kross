import { traceEventSchema, type AgentMode, type TraceEvent } from '../domain';
import {
  buildTraceDetail,
  type RunTraceDetail,
  type RunTraceSummary
} from './traceSummary';

export const TRACE_REPLAY_VERSION = 1;

export const TRACE_REPLAY_EVENT_TYPES = [
  'approval.required',
  'conductor.execution.started',
  'conductor.review.completed',
  'conductor.review.evidence',
  'conductor.review.started',
  'conductor.validation.completed',
  'conductor.validation.evidence',
  'conductor.validation.started',
  'conductor.worker.attempt.completed',
  'conductor.worker.attempt.started',
  'conductor.worker.blocked',
  'conductor.worker.replan.completed',
  'conductor.worker.replan.started',
  'conductor.worker.retry',
  'context.built',
  'context.compacted',
  'llm.planner.completed',
  'llm.planner.failed',
  'llm.soft_land.completed',
  'llm.subagent.completed',
  'llm.subagent.stall_recovery',
  'llm.subagent.stalled',
  'llm.subagent.turn',
  'llm.tool_calls.received',
  'llm.tool_followup.completed',
  'llm.tool_loop.max_iterations',
  'llm.tool_loop.stall_detected',
  'llm.tool_loop.stall_recovery',
  'llm.tool_loop.stalled',
  'mode.detected',
  'plan.created',
  'plan.intent',
  'planner.started',
  'review.completed',
  'run.awaiting_approval',
  'run.completed',
  'run.interrupted',
  'run.phase.changed',
  'run.started',
  'run.verification.completed',
  'run.verification.exhausted',
  'run.verification.followup',
  'run.verification.started',
  'subagent.cancelled',
  'subagent.completed',
  'subagent.failed',
  'subagent.started',
  'tool_call.approval_required',
  'tool_call.cancelled',
  'tool_call.completed',
  'tool_call.denied',
  'tool_call.failed',
  'tool_call.rejected',
  'tool_call.retry',
  'tool_call.started'
] as const;

export type TraceReplayEventType =
  (typeof TRACE_REPLAY_EVENT_TYPES)[number];

export type TraceReplayErrorCode =
  | 'empty'
  | 'invalid-event'
  | 'wrong-run'
  | 'duplicate-id'
  | 'out-of-order'
  | 'unknown-event'
  | 'missing-start'
  | 'duplicate-start'
  | 'event-after-completion'
  | 'invalid-payload'
  | 'missing-tool-start'
  | 'duplicate-tool-terminal';

export class TraceReplayError extends Error {
  constructor(
    readonly code: TraceReplayErrorCode,
    message: string,
    readonly eventIndex?: number,
    readonly eventId?: string
  ) {
    super(message);
    this.name = 'TraceReplayError';
  }
}

export interface TraceReplayFrame {
  index: number;
  eventId: string;
  eventType: TraceReplayEventType;
  timestamp: string;
  status: string;
  mode?: AgentMode;
  phase?: string;
  activeToolCalls: number;
}

export interface TraceReplayResult {
  version: typeof TRACE_REPLAY_VERSION;
  runId: string;
  eventCount: number;
  status: string;
  mode?: AgentMode;
  phase?: string;
  frames: TraceReplayFrame[];
  summary: RunTraceSummary;
  detail: RunTraceDetail;
}

const KNOWN_TYPES = new Set<string>(TRACE_REPLAY_EVENT_TYPES);
const TOOL_TERMINALS = new Set([
  'tool_call.completed',
  'tool_call.failed'
]);

/**
 * Strictly replay one main-run Trace into derived state.
 * This function is pure and never executes tools or other external effects.
 */
export function replayTraceEvents(
  expectedRunId: string,
  inputEvents: readonly TraceEvent[]
): TraceReplayResult {
  if (inputEvents.length === 0) {
    throw new TraceReplayError('empty', `Trace is empty: ${expectedRunId}`);
  }

  const events = inputEvents.map((event, index) => {
    const parsed = traceEventSchema.safeParse(event);
    if (!parsed.success) {
      throw replayError(
        'invalid-event',
        `Invalid Trace event at index ${index}`,
        index,
        event?.id
      );
    }
    return parsed.data;
  });
  const ids = new Set<string>();
  const activeTools = new Map<
    string,
    { toolName: string; terminal: boolean }
  >();
  let legacyToolSequence = 0;
  let previousTimestamp = Number.NEGATIVE_INFINITY;
  let started = false;
  let completed = false;
  let status = 'pending';
  let mode: AgentMode | undefined;
  let phase: string | undefined;
  const frames: TraceReplayFrame[] = [];

  for (const [index, event] of events.entries()) {
    if (event.runId !== expectedRunId) {
      throw replayError(
        'wrong-run',
        `Trace event belongs to ${event.runId}, expected ${expectedRunId}`,
        index,
        event.id
      );
    }
    if (ids.has(event.id)) {
      throw replayError(
        'duplicate-id',
        `Duplicate Trace event id: ${event.id}`,
        index,
        event.id
      );
    }
    ids.add(event.id);
    const timestamp = Date.parse(event.timestamp);
    if (timestamp < previousTimestamp) {
      throw replayError(
        'out-of-order',
        `Trace timestamp moved backwards at ${event.id}`,
        index,
        event.id
      );
    }
    previousTimestamp = timestamp;
    if (!KNOWN_TYPES.has(event.type)) {
      throw replayError(
        'unknown-event',
        `Unknown Trace event type: ${event.type}`,
        index,
        event.id
      );
    }
    if (completed) {
      throw replayError(
        'event-after-completion',
        `Trace event appears after run.completed: ${event.type}`,
        index,
        event.id
      );
    }
    if (index === 0 && event.type !== 'run.started') {
      throw replayError(
        'missing-start',
        'Trace must begin with run.started',
        index,
        event.id
      );
    }

    switch (event.type as TraceReplayEventType) {
      case 'run.started':
        if (started) {
          throw replayError(
            'duplicate-start',
            'Trace contains more than one run.started event',
            index,
            event.id
          );
        }
        requireStringPayload(event, 'input', index);
        started = true;
        status = 'running';
        break;
      case 'run.awaiting_approval':
        status = 'approval-required';
        break;
      case 'run.completed':
        status = requireStringPayload(event, 'status', index);
        completed = true;
        break;
      case 'mode.detected': {
        const nextMode = requireStringPayload(event, 'mode', index);
        if (
          nextMode !== 'auto' &&
          nextMode !== 'plan' &&
          nextMode !== 'conductor'
        ) {
          throw replayError(
            'invalid-payload',
            `Invalid mode in ${event.id}: ${nextMode}`,
            index,
            event.id
          );
        }
        mode = nextMode;
        break;
      }
      case 'run.phase.changed':
        phase = requireStringPayload(event, 'phase', index);
        break;
      case 'tool_call.started': {
        const toolName = requireStringPayload(event, 'toolName', index);
        const callId = optionalStringPayload(event, 'callId');
        const key = callId ?? `legacy:${toolName}:${legacyToolSequence++}`;
        if (activeTools.has(key)) {
          throw replayError(
            'invalid-payload',
            `Duplicate active tool call: ${key}`,
            index,
            event.id
          );
        }
        activeTools.set(key, { toolName, terminal: false });
        break;
      }
      case 'tool_call.completed':
      case 'tool_call.failed': {
        const toolName = requireStringPayload(event, 'toolName', index);
        const callId = optionalStringPayload(event, 'callId');
        const key =
          callId ??
          [...activeTools].find(
            ([, tool]) => tool.toolName === toolName && !tool.terminal
          )?.[0];
        if (!key || !activeTools.has(key)) {
          throw replayError(
            'missing-tool-start',
            `Tool terminal event has no matching start: ${toolName}`,
            index,
            event.id
          );
        }
        const tool = activeTools.get(key)!;
        if (tool.terminal) {
          throw replayError(
            'duplicate-tool-terminal',
            `Tool call already reached a terminal state: ${key}`,
            index,
            event.id
          );
        }
        tool.terminal = true;
        break;
      }
      case 'tool_call.retry': {
        const callId = optionalStringPayload(event, 'callId');
        if (callId && !activeTools.has(callId)) {
          throw replayError(
            'missing-tool-start',
            `Tool retry has no matching start: ${callId}`,
            index,
            event.id
          );
        }
        requireStringPayload(event, 'toolName', index);
        break;
      }
      case 'tool_call.cancelled': {
        const callId = optionalStringPayload(event, 'callId');
        const toolName = requireStringPayload(event, 'toolName', index);
        const key =
          callId ??
          [...activeTools].find(
            ([, tool]) => tool.toolName === toolName && !tool.terminal
          )?.[0];
        if (key && activeTools.has(key)) {
          activeTools.get(key)!.terminal = true;
        }
        break;
      }
      case 'tool_call.approval_required':
      case 'tool_call.denied':
      case 'tool_call.rejected':
        requireStringPayload(event, 'toolName', index);
        break;
      default:
        break;
    }

    frames.push({
      index,
      eventId: event.id,
      eventType: event.type as TraceReplayEventType,
      timestamp: event.timestamp,
      status,
      mode,
      phase,
      activeToolCalls: [...activeTools.values()].filter(
        (tool) => !tool.terminal
      ).length
    });
  }

  if (!started) {
    throw new TraceReplayError(
      'missing-start',
      'Trace does not contain run.started'
    );
  }
  const detail = buildTraceDetail(expectedRunId, events);
  if (!detail) {
    throw new TraceReplayError(
      'empty',
      `Trace is empty: ${expectedRunId}`
    );
  }
  return {
    version: TRACE_REPLAY_VERSION,
    runId: expectedRunId,
    eventCount: events.length,
    status,
    mode,
    phase,
    frames,
    summary: detail,
    detail
  };
}

export function formatTraceReplay(result: TraceReplayResult): string {
  const visibleFrames = result.frames.slice(-40);
  return [
    `### Trace Replay：${result.runId}`,
    `- version: ${result.version}`,
    `- events: ${result.eventCount}`,
    `- status: ${result.status}`,
    ...(result.mode ? [`- mode: ${result.mode}`] : []),
    ...(result.phase ? [`- phase: ${result.phase}`] : []),
    '',
    '### 派生时间线',
    ...visibleFrames.map(
      (frame) =>
        `${frame.index + 1}. \`${frame.eventType}\` → ${frame.status}` +
        `${frame.phase ? ` · phase=${frame.phase}` : ''}` +
        ` · activeTools=${frame.activeToolCalls}`
    ),
    ...(result.frames.length > visibleFrames.length
      ? [`仅显示最后 ${visibleFrames.length} 个状态帧。`]
      : []),
    '',
    '回放仅派生状态，不会重新执行工具、Git 或其他外部副作用。'
  ].join('\n');
}

function requireStringPayload(
  event: TraceEvent,
  field: string,
  index: number
): string {
  const value = event.payload[field];
  if (typeof value !== 'string') {
    throw replayError(
      'invalid-payload',
      `Trace event ${event.type} requires payload.${field}`,
      index,
      event.id
    );
  }
  return value;
}

function optionalStringPayload(
  event: TraceEvent,
  field: string
): string | undefined {
  const value = event.payload[field];
  return typeof value === 'string' && value ? value : undefined;
}

function replayError(
  code: TraceReplayErrorCode,
  message: string,
  eventIndex: number,
  eventId?: string
): TraceReplayError {
  return new TraceReplayError(code, message, eventIndex, eventId);
}
