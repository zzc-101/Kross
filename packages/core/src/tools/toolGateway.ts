import { ZodError, type z } from 'zod';

import type { TraceEvent } from '../domain';
import type { TraceStore } from '../trace/traceStore';

export type ToolRisk = 'read' | 'write' | 'execute' | 'network';

export interface ToolMetadata {
  name: string;
  description: string;
  risk: ToolRisk;
}

export interface ToolExecutionContext<TInput> {
  runId: string;
  toolName: string;
  input: TInput;
}

export interface ToolResult {
  status: 'completed';
  content: string;
  data?: unknown;
}

export interface ToolHandlerResult {
  status?: 'completed';
  content: string;
  data?: unknown;
}

export interface ToolDefinition<TInput = unknown> extends ToolMetadata {
  inputSchema: z.ZodType<TInput>;
  execute(context: ToolExecutionContext<TInput>): Promise<ToolHandlerResult>;
}

export interface ToolCallInput {
  runId: string;
  name: string;
  input: unknown;
  approved?: boolean;
}

export interface ToolGatewayOptions {
  traceStore?: TraceStore;
  now?: () => Date;
}

export class ToolGateway {
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly now: () => Date;

  constructor(private readonly options: ToolGatewayOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  register<TInput>(definition: ToolDefinition<TInput>): void {
    if (this.tools.has(definition.name)) {
      throw new Error(`Tool already registered: ${definition.name}`);
    }
    this.tools.set(definition.name, definition as ToolDefinition);
  }

  listTools(): ToolMetadata[] {
    return [...this.tools.values()].map(({ name, description, risk }) => ({
      name,
      description,
      risk
    }));
  }

  async call(input: ToolCallInput): Promise<ToolResult> {
    const definition = this.tools.get(input.name);
    if (!definition) {
      throw new ToolNotFoundError(input.name);
    }

    if (requiresApproval(definition.risk) && input.approved !== true) {
      await this.record(input.runId, 'tool_call.approval_required', {
        toolName: input.name,
        risk: definition.risk
      });
      throw new ToolPermissionError(input.name, definition.risk);
    }

    const parsedInput = parseInput(definition, input.input);

    await this.record(input.runId, 'tool_call.started', {
      toolName: input.name,
      risk: definition.risk,
      input: parsedInput
    });

    try {
      const rawResult = await definition.execute({
        runId: input.runId,
        toolName: input.name,
        input: parsedInput
      });
      const result: ToolResult = {
        status: 'completed',
        ...rawResult
      };
      await this.record(input.runId, 'tool_call.completed', {
        toolName: input.name,
        status: result.status,
        contentPreview: result.content.slice(0, 240)
      });
      return result;
    } catch (error) {
      await this.record(input.runId, 'tool_call.failed', {
        toolName: input.name,
        message: error instanceof Error ? error.message : String(error)
      });
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
    readonly risk: ToolRisk
  ) {
    super(`Tool requires approval: ${toolName} (${risk})`);
    this.name = 'ToolPermissionError';
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

function requiresApproval(risk: ToolRisk): boolean {
  return risk !== 'read';
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
