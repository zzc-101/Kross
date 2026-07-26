import type { TraceEvent } from '../domain';
import type { ToolRisk } from '../tools/toolGateway';

export type ExperimentalLifecycleHookEventType =
  | 'run.started'
  | 'run.completed'
  | 'tool.started'
  | 'tool.completed'
  | 'tool.failed'
  | 'tool.cancelled'
  | 'tool.denied'
  | 'tool.approval.required'
  | 'context.compacted';

export interface ExperimentalLifecycleHookEvent {
  version: 1;
  type: ExperimentalLifecycleHookEventType;
  runId: string;
  timestamp: string;
  tool?: Readonly<{
    name: string;
    risk?: ToolRisk;
  }>;
  outcome?: string;
}

export interface ExperimentalLifecycleHookContext {
  signal: AbortSignal;
}

export type ExperimentalLifecycleHook = (
  event: Readonly<ExperimentalLifecycleHookEvent>,
  context: ExperimentalLifecycleHookContext
) => void | Promise<void>;

export interface ExperimentalLifecycleHookDiagnostic {
  code: 'hook.timeout' | 'hook.error' | 'hook.dropped';
  hookIndex?: number;
  eventType: ExperimentalLifecycleHookEventType;
  message: string;
}

export interface ExperimentalLifecycleHooksOptions {
  hooks: readonly ExperimentalLifecycleHook[];
  /** Per-hook deadline. The AbortSignal is cancelled on timeout. Default 1000. */
  timeoutMs?: number;
  /** Maximum dispatched events still awaiting hooks. Default 16. */
  maxPendingEvents?: number;
  /** Maximum accepted events in a rolling one-second window. Default 50. */
  maxEventsPerSecond?: number;
  onDiagnostic?: (diagnostic: ExperimentalLifecycleHookDiagnostic) => void;
  /** Test clock. */
  now?: () => number;
}

/**
 * Notification-only lifecycle hook dispatcher.
 *
 * Events are derived from Trace but omit inputs, outputs, content previews,
 * summaries and arbitrary payload fields. Hooks run out of band and cannot
 * affect the Agent result.
 */
export class ExperimentalLifecycleHooks {
  private readonly hooks: readonly ExperimentalLifecycleHook[];
  private readonly timeoutMs: number;
  private readonly maxPendingEvents: number;
  private readonly maxEventsPerSecond: number;
  private readonly now: () => number;
  private readonly pending = new Set<Promise<void>>();
  private windowStartedAt: number;
  private windowEvents = 0;
  private closed = false;

  constructor(private readonly options: ExperimentalLifecycleHooksOptions) {
    this.hooks = [...options.hooks];
    this.timeoutMs = positiveInteger(options.timeoutMs, 1_000);
    this.maxPendingEvents = positiveInteger(options.maxPendingEvents, 16);
    this.maxEventsPerSecond = positiveInteger(
      options.maxEventsPerSecond,
      50
    );
    this.now = options.now ?? Date.now;
    this.windowStartedAt = this.now();
  }

  notify(trace: TraceEvent): void {
    if (this.closed || this.hooks.length === 0) return;
    const event = toLifecycleEvent(trace);
    if (!event) return;
    if (!this.acceptRateLimit(event.type)) return;
    if (this.pending.size >= this.maxPendingEvents) {
      this.diagnose({
        code: 'hook.dropped',
        eventType: event.type,
        message: 'lifecycle hook event dropped: pending limit reached'
      });
      return;
    }

    const job = Promise.all(
      this.hooks.map((hook, index) => this.runHook(hook, index, event))
    ).then(() => undefined);
    this.pending.add(job);
    void job.finally(() => {
      this.pending.delete(job);
    });
  }

  async flush(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
  }

  private acceptRateLimit(type: ExperimentalLifecycleHookEventType): boolean {
    const now = this.now();
    if (now - this.windowStartedAt >= 1_000) {
      this.windowStartedAt = now;
      this.windowEvents = 0;
    }
    if (this.windowEvents >= this.maxEventsPerSecond) {
      this.diagnose({
        code: 'hook.dropped',
        eventType: type,
        message: 'lifecycle hook event dropped: rate limit reached'
      });
      return false;
    }
    this.windowEvents += 1;
    return true;
  }

  private runHook(
    hook: ExperimentalLifecycleHook,
    hookIndex: number,
    event: Readonly<ExperimentalLifecycleHookEvent>
  ): Promise<void> {
    const controller = new AbortController();
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        if (settled) return;
        controller.abort(new Error('lifecycle hook timeout'));
        this.diagnose({
          code: 'hook.timeout',
          hookIndex,
          eventType: event.type,
          message: `lifecycle hook timed out after ${this.timeoutMs}ms`
        });
        finish();
      }, this.timeoutMs);
      timer.unref?.();

      Promise.resolve()
        .then(() => hook(event, { signal: controller.signal }))
        .then(finish, () => {
          if (!settled) {
            this.diagnose({
              code: 'hook.error',
              hookIndex,
              eventType: event.type,
              message: 'lifecycle hook failed'
            });
          }
          finish();
        });
    });
  }

  private diagnose(diagnostic: ExperimentalLifecycleHookDiagnostic): void {
    try {
      this.options.onDiagnostic?.(Object.freeze({ ...diagnostic }));
    } catch {
      // Diagnostics must not affect Runtime or other hooks.
    }
  }
}

function toLifecycleEvent(
  trace: TraceEvent
): Readonly<ExperimentalLifecycleHookEvent> | undefined {
  const type = mapTraceType(trace.type);
  if (!type) return undefined;
  const toolName =
    typeof trace.payload.toolName === 'string'
      ? trace.payload.toolName.slice(0, 200)
      : undefined;
  const risk = isToolRisk(trace.payload.risk)
    ? trace.payload.risk
    : undefined;
  const outcome =
    typeof trace.payload.status === 'string'
      ? trace.payload.status.slice(0, 80)
      : undefined;
  const tool = toolName
    ? Object.freeze({
        name: toolName,
        ...(risk ? { risk } : {})
      })
    : undefined;
  return Object.freeze({
    version: 1 as const,
    type,
    runId: trace.runId,
    timestamp: trace.timestamp,
    ...(tool ? { tool } : {}),
    ...(outcome ? { outcome } : {})
  });
}

function mapTraceType(
  type: string
): ExperimentalLifecycleHookEventType | undefined {
  switch (type) {
    case 'run.started':
    case 'run.completed':
    case 'context.compacted':
      return type;
    case 'tool_call.started':
      return 'tool.started';
    case 'tool_call.completed':
      return 'tool.completed';
    case 'tool_call.failed':
      return 'tool.failed';
    case 'tool_call.cancelled':
      return 'tool.cancelled';
    case 'tool_call.denied':
      return 'tool.denied';
    case 'tool_call.approval_required':
      return 'tool.approval.required';
    default:
      return undefined;
  }
}

function isToolRisk(value: unknown): value is ToolRisk {
  return (
    value === 'read' ||
    value === 'write' ||
    value === 'execute' ||
    value === 'network'
  );
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}
