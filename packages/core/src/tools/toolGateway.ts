import { ZodError, type z } from 'zod';

import type { TraceEvent } from '../domain';
import type { TraceStore } from '../trace/traceStore';

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
  timeoutMs?: number;
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
  approved?: boolean;
  returnErrors?: boolean;
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
}

export class ToolGateway {
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly now: () => Date;
  private approvalPolicy: ToolApprovalPolicy;
  private readonly maxSummaryChars: number;

  constructor(private readonly options: ToolGatewayOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.approvalPolicy = options.approvalPolicy ?? defaultApprovalPolicy;
    this.maxSummaryChars = options.maxSummaryChars ?? 240;
  }

  setApprovalPolicy(policy: ToolApprovalPolicy): void {
    this.approvalPolicy = policy;
  }

  getApprovalPolicy(): ToolApprovalPolicy {
    return this.approvalPolicy;
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
    const definition = this.tools.get(input.name);
    if (!definition) {
      throw new ToolNotFoundError(input.name);
    }

    const parsedInput = parseInput(definition, input.input);
    const approval = this.approvalPolicy({
      tool: toMetadata(definition),
      input: parsedInput
    });
    const callMeta = {
      toolName: input.name,
      risk: definition.risk,
      ...(input.callId ? { callId: input.callId } : {})
    };

    if (approval.action === 'deny') {
      await this.record(input.runId, 'tool_call.denied', {
        ...callMeta,
        reason: approval.reason
      });
      throw new ToolPermissionError(
        input.name,
        definition.risk,
        approval.reason,
        'deny'
      );
    }
    if (approval.action === 'ask' && input.approved !== true) {
      await this.record(input.runId, 'tool_call.approval_required', {
        ...callMeta,
        reason: approval.reason,
        input: parsedInput
      });
      throw new ToolPermissionError(
        input.name,
        definition.risk,
        approval.reason,
        'ask'
      );
    }

    const startedAt = this.now().getTime();
    await this.record(input.runId, 'tool_call.started', {
      ...callMeta,
      input: parsedInput
    });

    try {
      const rawResult = await executeWithTimeout(definition, {
        runId: input.runId,
        toolName: input.name,
        input: parsedInput
      }, this.options.defaultTimeoutMs);
      const result: ToolResult = {
        ...rawResult,
        status: 'completed',
        summary: summarizeResult(definition, rawResult, this.maxSummaryChars)
      };
      await this.record(input.runId, 'tool_call.completed', {
        ...callMeta,
        status: result.status,
        contentPreview: result.content.slice(0, 240),
        summary: result.summary,
        durationMs: this.now().getTime() - startedAt
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed: ToolResult = {
        status: 'failed',
        content: `Tool ${input.name} failed: ${message}`,
        summary: `failed: ${message}`
      };
      await this.record(input.runId, 'tool_call.failed', {
        ...callMeta,
        status: failed.status,
        message,
        summary: failed.summary,
        durationMs: this.now().getTime() - startedAt
      });
      if (input.returnErrors === true) {
        return failed;
      }
      throw error;
    }
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
      payload
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

function toMetadata(definition: ToolDefinition): ToolMetadata {
  const { name, description, risk, category, parameters } = definition;
  return {
    name,
    description,
    risk,
    category,
    parameters
  };
}

async function executeWithTimeout<TInput>(
  definition: ToolDefinition<TInput>,
  context: Omit<ToolExecutionContext<TInput>, 'signal'>,
  defaultTimeoutMs?: number
): Promise<ToolHandlerResult> {
  const timeoutMs = definition.timeoutMs ?? defaultTimeoutMs;
  const controller = new AbortController();
  const execution = definition.execute({
    ...context,
    signal: controller.signal
  });

  if (timeoutMs === undefined) {
    return execution;
  }

  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      execution,
      new Promise<ToolHandlerResult>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new ToolTimeoutError(definition.name, timeoutMs));
        }, timeoutMs);
      })
    ]);
  } finally {
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
