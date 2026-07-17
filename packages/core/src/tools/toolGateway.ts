import { ZodError, type z } from 'zod';

import {
  abortMessage,
  abortReason,
  isOperationAborted,
  throwIfAborted
} from '../abort';
import type { TraceEvent } from '../domain';
import type { TraceStore } from '../trace/traceStore';
import {
  errorMessage,
  formatToolFailureObservation,
  resolveToolRetryPolicy,
  retryBackoffMs,
  type ToolAttemptFailure,
  type ToolRetryPolicy
} from './toolRetry';

export type { ToolRetryPolicy } from './toolRetry';

export type ToolRisk = 'read' | 'write' | 'execute' | 'network';
export type ToolApprovalAction = 'allow' | 'ask' | 'deny';

export interface ToolMetadata {
  name: string;
  description: string;
  risk: ToolRisk;
  category?: string;
  parameters?: Record<string, unknown>;
}

export interface ToolListContext {
  mode?: string;
}

export interface ToolExecutionContext<TInput> {
  runId: string;
  toolName: string;
  input: TInput;
  signal: AbortSignal;
}

export interface ToolResult {
  status: 'completed' | 'failed';
  content: string;
  summary: string;
  data?: unknown;
}

export interface ToolHandlerResult {
  status?: 'completed';
  content: string;
  summary?: string;
  data?: unknown;
}

export interface ToolDefinition<TInput = unknown> extends ToolMetadata {
  inputSchema: z.ZodType<TInput>;
  /** Override the static metadata risk after input validation. */
  resolveRisk?(input: TInput): ToolRisk;
  /** Return a secret-safe representation used only for trace/approval UI. */
  redactInputForTrace?: (input: unknown) => unknown;
  timeoutMs?: number;
  /**
   * 工具级重试策略。
   * - false：禁止重试
   * - 对象：覆盖默认 maxAttempts / backoff / retryOn
   * - 省略：使用 Gateway 默认（瞬时错误最多 2 次 attempt）
   */
  retry?: ToolRetryPolicy | false;
  enabled?: (context: ToolListContext) => boolean;
  summarize?: (result: ToolHandlerResult) => string;
  execute(context: ToolExecutionContext<TInput>): Promise<ToolHandlerResult>;
}

export interface ToolCallInput {
  runId: string;
  name: string;
  input: unknown;
  /** 与模型 tool_call id 对齐，便于 UI/trace 关联 started/completed。 */
  callId?: string;
  /** Current agent tool-loop iteration, when available. */
  iteration?: number;
  approved?: boolean;
  returnErrors?: boolean;
  /** 当前 agent run 的取消信号，会与工具超时信号合并。 */
  signal?: AbortSignal;
  /**
   * 调用级重试覆盖。
   * - false：本次强制不重试
   * - 对象：覆盖工具/网关策略
   */
  retry?: ToolRetryPolicy | false;
}

export interface ToolApprovalDecision {
  action: ToolApprovalAction;
  reason?: string;
}

export interface ToolApprovalPolicyContext<TInput = unknown> {
  tool: ToolMetadata;
  input: TInput;
}

export type ToolApprovalPolicy = (
  context: ToolApprovalPolicyContext
) => ToolApprovalDecision;

export interface ToolGatewayOptions {
  traceStore?: TraceStore;
  now?: () => Date;
  approvalPolicy?: ToolApprovalPolicy;
  defaultTimeoutMs?: number;
  maxSummaryChars?: number;
  /** completed 事件 contentPreview 最大字符，供 TUI 展开预览（默认 4000） */
  maxContentPreviewChars?: number;
  /**
   * Gateway 默认重试策略。
   * - false：全局关闭（工具仍可单独开启）
   * - 对象：覆盖 DEFAULT_TOOL_RETRY_POLICY 字段
   */
  defaultRetry?: ToolRetryPolicy | false;
  /** 测试可注入；默认 setTimeout。 */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Merged into every tool_call.* payload (e.g. `{ isSubagent: true }` so TUI
   * can hard-filter subagent traffic from the main transcript).
   */
  tracePayloadExtras?: Record<string, unknown>;
}

export class ToolGateway {
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly now: () => Date;
  private approvalPolicy: ToolApprovalPolicy;
  private readonly maxSummaryChars: number;
  private readonly maxContentPreviewChars: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: ToolGatewayOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.approvalPolicy = options.approvalPolicy ?? defaultApprovalPolicy;
    this.maxSummaryChars = options.maxSummaryChars ?? 240;
    this.maxContentPreviewChars = options.maxContentPreviewChars ?? 4000;
    this.sleep = options.sleep ?? defaultSleep;
  }

  setApprovalPolicy(policy: ToolApprovalPolicy): void {
    this.approvalPolicy = policy;
  }

  getApprovalPolicy(): ToolApprovalPolicy {
    return this.approvalPolicy;
  }

  /** Return the same validated, secret-safe input representation used by trace events. */
  formatInputForTrace(name: string, input: unknown): unknown {
    const definition = this.tools.get(name);
    if (!definition) throw new ToolNotFoundError(name);
    const parsedInput = parseInput(definition, input);
    return definition.redactInputForTrace
      ? definition.redactInputForTrace(parsedInput)
      : parsedInput;
  }

  register<TInput>(definition: ToolDefinition<TInput>): void {
    if (this.tools.has(definition.name)) {
      throw new Error(`Tool already registered: ${definition.name}`);
    }
    this.tools.set(definition.name, definition as ToolDefinition);
  }

  listTools(context: ToolListContext = {}): ToolMetadata[] {
    return [...this.tools.values()]
      .filter((tool) => tool.enabled?.(context) ?? true)
      .map(({ name, description, risk, category, parameters }) => ({
      name,
      description,
      risk,
      category,
      parameters
    }));
  }

  async call(input: ToolCallInput): Promise<ToolResult> {
    throwIfAborted(input.signal);
    const definition = this.tools.get(input.name);
    if (!definition) {
      throw new ToolNotFoundError(input.name);
    }

    const parsedInput = parseInput(definition, input.input);
    const risk = definition.resolveRisk?.(parsedInput) ?? definition.risk;
    const traceInput = definition.redactInputForTrace
      ? definition.redactInputForTrace(parsedInput)
      : parsedInput;
    const approval = this.approvalPolicy({
      tool: toMetadata(definition, risk),
      input: parsedInput
    });
    const callMeta = {
      toolName: input.name,
      risk,
      ...(input.callId ? { callId: input.callId } : {}),
      ...(input.iteration !== undefined ? { iteration: input.iteration } : {})
    };

    if (approval.action === 'deny') {
      await this.record(input.runId, 'tool_call.denied', {
        ...callMeta,
        reason: approval.reason
      });
      throw new ToolPermissionError(
        input.name,
        risk,
        approval.reason,
        'deny'
      );
    }
    if (approval.action === 'ask' && input.approved !== true) {
      await this.record(input.runId, 'tool_call.approval_required', {
        ...callMeta,
        reason: approval.reason,
        input: traceInput
      });
      throw new ToolPermissionError(
        input.name,
        risk,
        approval.reason,
        'ask'
      );
    }

    const retryPolicy = resolveToolRetryPolicy({
      callRetry: input.retry,
      definitionRetry: definition.retry,
      gatewayRetry: this.options.defaultRetry
    });

    const startedAt = this.now().getTime();
    await this.record(input.runId, 'tool_call.started', {
      ...callMeta,
      input: traceInput,
      maxAttempts: retryPolicy.maxAttempts
    });

    const failures: ToolAttemptFailure[] = [];
    let lastError: unknown;

    for (let attempt = 1; attempt <= retryPolicy.maxAttempts; attempt += 1) {
      try {
        throwIfAborted(input.signal);
        const rawResult = await executeWithTimeout(
          definition,
          {
            runId: input.runId,
            toolName: input.name,
            input: parsedInput
          },
          this.options.defaultTimeoutMs,
          input.signal
        );
        throwIfAborted(input.signal);
        const attemptMeta = {
          attempts: attempt,
          maxAttempts: retryPolicy.maxAttempts,
          retried: attempt > 1
        };
        const mergedData =
          rawResult.data !== undefined
            ? { ...(asRecord(rawResult.data) ?? { value: rawResult.data }), ...attemptMeta }
            : attemptMeta;
        const result: ToolResult = {
          ...rawResult,
          status: 'completed',
          summary: summarizeResult(definition, rawResult, this.maxSummaryChars),
          data: mergedData
        };
        await this.record(input.runId, 'tool_call.completed', {
          ...callMeta,
          status: result.status,
          contentPreview: result.content.slice(0, this.maxContentPreviewChars),
          summary: result.summary,
          durationMs: this.now().getTime() - startedAt,
          ...attemptMeta,
          data: result.data
        });
        return result;
      } catch (error) {
        if (isOperationAborted(error, input.signal)) {
          const message = abortMessage(input.signal);
          await this.record(input.runId, 'tool_call.cancelled', {
            ...callMeta,
            status: 'cancelled',
            message,
            summary: 'cancelled by user',
            durationMs: this.now().getTime() - startedAt,
            attempts: attempt,
            maxAttempts: retryPolicy.maxAttempts
          });
          throw abortReason(input.signal, message);
        }

        lastError = error;
        const message = errorMessage(error);
        failures.push({ attempt, message });

        const canRetry =
          attempt < retryPolicy.maxAttempts && retryPolicy.retryOn(error, attempt);

        if (canRetry) {
          const delayMs = retryBackoffMs(retryPolicy, attempt);
          await this.record(input.runId, 'tool_call.retry', {
            ...callMeta,
            attempt,
            maxAttempts: retryPolicy.maxAttempts,
            message,
            retryable: true,
            nextDelayMs: delayMs
          });
          if (delayMs > 0) {
            await sleepWithSignal(this.sleep, delayMs, input.signal);
          }
          continue;
        }

        // 不可重试或已耗尽
        if (attempt < retryPolicy.maxAttempts) {
          await this.record(input.runId, 'tool_call.retry', {
            ...callMeta,
            attempt,
            maxAttempts: retryPolicy.maxAttempts,
            message,
            retryable: false,
            nextDelayMs: 0
          });
        }

        const observation = formatToolFailureObservation({
          toolName: input.name,
          failures,
          maxAttempts: retryPolicy.maxAttempts
        });
        const failed: ToolResult = {
          status: 'failed',
          content: observation.content,
          summary: observation.summary,
          data: observation.data
        };
        await this.record(input.runId, 'tool_call.failed', {
          ...callMeta,
          status: failed.status,
          message,
          summary: failed.summary,
          durationMs: this.now().getTime() - startedAt,
          attempts: failures.length,
          maxAttempts: retryPolicy.maxAttempts,
          retried: failures.length > 1,
          data: failed.data
        });
        if (input.returnErrors === true) {
          return failed;
        }
        throw error;
      }
    }

    // 理论上不会到达
    const fallbackMessage = errorMessage(lastError);
    const failed: ToolResult = {
      status: 'failed',
      content: `Tool ${input.name} failed: ${fallbackMessage}`,
      summary: `failed: ${fallbackMessage}`
    };
    if (input.returnErrors === true) {
      return failed;
    }
    throw lastError instanceof Error ? lastError : new Error(fallbackMessage);
  }

  private async record(
    runId: string,
    type: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    if (!this.options.traceStore) {
      return;
    }

    const event: TraceEvent = {
      id: `${runId}-${type}-${this.now().getTime()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`,
      runId,
      type,
      timestamp: this.now().toISOString(),
      payload: {
        ...(this.options.tracePayloadExtras ?? {}),
        ...payload
      }
    };
    await this.options.traceStore.append(event);
  }
}

export class ToolNotFoundError extends Error {
  constructor(readonly toolName: string) {
    super(`Tool not found: ${toolName}`);
    this.name = 'ToolNotFoundError';
  }
}

export class ToolPermissionError extends Error {
  constructor(
    readonly toolName: string,
    readonly risk: ToolRisk,
    readonly reason?: string,
    readonly action: Exclude<ToolApprovalAction, 'allow'> = 'ask'
  ) {
    super(
      reason
        ? `Tool blocked: ${toolName} (${risk}) - ${reason}`
        : `Tool requires approval: ${toolName} (${risk})`
    );
    this.name = 'ToolPermissionError';
  }
}

export class ToolTimeoutError extends Error {
  constructor(
    readonly toolName: string,
    readonly timeoutMs: number
  ) {
    super(`Tool timed out: ${toolName} after ${timeoutMs}ms`);
    this.name = 'ToolTimeoutError';
  }
}

export class ToolValidationError extends Error {
  constructor(
    readonly toolName: string,
    readonly zodError: ZodError
  ) {
    super(`Invalid input for tool: ${toolName}`);
    this.name = 'ToolValidationError';
  }
}

function parseInput<TInput>(
  definition: ToolDefinition<TInput>,
  input: unknown
): TInput {
  try {
    return definition.inputSchema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ToolValidationError(definition.name, error);
    }
    throw error;
  }
}

function defaultApprovalPolicy(context: ToolApprovalPolicyContext): ToolApprovalDecision {
  return context.tool.risk === 'read'
    ? { action: 'allow' }
    : { action: 'ask', reason: `${context.tool.risk} tool requires approval` };
}

function toMetadata(
  definition: ToolDefinition,
  resolvedRisk: ToolRisk = definition.risk
): ToolMetadata {
  const { name, description, category, parameters } = definition;
  return {
    name,
    description,
    risk: resolvedRisk,
    category,
    parameters
  };
}

async function executeWithTimeout<TInput>(
  definition: ToolDefinition<TInput>,
  context: Omit<ToolExecutionContext<TInput>, 'signal'>,
  defaultTimeoutMs?: number,
  externalSignal?: AbortSignal
): Promise<ToolHandlerResult> {
  throwIfAborted(externalSignal);
  const timeoutMs = definition.timeoutMs ?? defaultTimeoutMs;
  const controller = new AbortController();
  let rejectExternalAbort: ((reason?: unknown) => void) | undefined;
  const externalAbort = new Promise<ToolHandlerResult>((_, reject) => {
    rejectExternalAbort = reject;
  });
  const onExternalAbort = () => {
    const reason = abortReason(externalSignal);
    controller.abort(reason);
    rejectExternalAbort?.(reason);
  };
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
  if (externalSignal?.aborted) {
    onExternalAbort();
  }

  const execution = Promise.resolve().then(() =>
    definition.execute({
      ...context,
      signal: controller.signal
    })
  );
  // abort/timeout 先 settle 时 execution 仍可能后续 reject → 防止 unhandledRejection
  void execution.catch(() => {});
  let timer: NodeJS.Timeout | undefined;
  const races: Promise<ToolHandlerResult>[] = [execution];
  if (externalSignal) {
    races.push(externalAbort);
  }
  if (timeoutMs !== undefined) {
    races.push(
      new Promise<ToolHandlerResult>((_, reject) => {
        timer = setTimeout(() => {
          const error = new ToolTimeoutError(definition.name, timeoutMs);
          controller.abort(error);
          reject(error);
        }, timeoutMs);
      })
    );
  }

  try {
    return await Promise.race(races);
  } finally {
    externalSignal?.removeEventListener('abort', onExternalAbort);
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function summarizeResult(
  definition: ToolDefinition,
  result: ToolHandlerResult,
  maxChars: number
): string {
  const summary = result.summary ?? definition.summarize?.(result) ?? result.content;
  return summary.length > maxChars ? `${summary.slice(0, maxChars)}...` : summary;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function sleepWithSignal(
  sleep: (ms: number) => Promise<void>,
  ms: number,
  signal?: AbortSignal
): Promise<void> {
  throwIfAborted(signal);
  if (!signal) {
    await sleep(ms);
    return;
  }

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<void>((_, reject) => {
    onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await Promise.race([sleep(ms), aborted]);
  } finally {
    if (onAbort) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}
