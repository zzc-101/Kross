import { throwIfAborted } from '../abort';
import type { LlmMessage, LlmToolCall, LlmToolDefinition } from '../llm/types';
import type { ToolGateway, ToolMetadata } from '../tools/toolGateway';

/** Convert tool metadata to LLM tool definitions; empty → undefined. */
export function toLlmTools(
  tools: ToolMetadata[]
): LlmToolDefinition[] | undefined {
  if (tools.length === 0) {
    return undefined;
  }
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters
  }));
}

/** Stable JSON for signature comparison; falls back to String on throw. */
export function stableJson(value: unknown): string {
  try {
    return JSON.stringify(normalizeJson(value)) ?? String(value);
  } catch {
    return String(value);
  }
}

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeJson);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalizeJson(child)])
    );
  }
  return value;
}

/** Signature of a tool-call batch for stall detection (name+input, order-sensitive). */
export function toolCallsSignature(calls: LlmToolCall[]): string {
  return calls.map((call) => `${call.name}:${stableJson(call.input)}`).join('|');
}

export const DEFAULT_MAX_PARALLEL_READ_TOOLS = 4;

/**
 * Execute independent, pre-approved read calls concurrently while preserving
 * result order. Write/execute/network/MCP/process calls remain ordered.
 */
export async function executeScheduledToolCalls(input: {
  runId: string;
  gateway: ToolGateway;
  calls: LlmToolCall[];
  tools?: ToolMetadata[];
  iteration?: number;
  signal?: AbortSignal;
  maxParallelReads?: number;
}): Promise<LlmMessage[]> {
  const out: LlmMessage[] = [];
  const queue = [...input.calls];
  const metadata = new Map(
    (input.tools ?? input.gateway.listTools()).map((tool) => [tool.name, tool])
  );
  const maxParallelReads = Math.max(
    1,
    input.maxParallelReads ?? DEFAULT_MAX_PARALLEL_READ_TOOLS
  );

  while (queue.length > 0) {
    throwIfAborted(input.signal);
    const first = queue[0]!;
    const parallel: LlmToolCall[] = [];
    while (parallel.length < maxParallelReads && queue.length > 0) {
      const candidate = queue[0]!;
      const tool = metadata.get(candidate.name);
      if (!isIndependentRead(tool)) break;
      const inspection = input.gateway.inspectCall(
        candidate.name,
        candidate.input
      );
      if (
        inspection.approval.action !== 'allow' ||
        inspection.tool.risk !== 'read'
      ) {
        break;
      }
      parallel.push(queue.shift()!);
    }
    const batch = parallel.length > 0 ? parallel : [queue.shift() ?? first];
    const results = await Promise.all(
      batch.map((call) =>
        input.gateway.call({
          runId: input.runId,
          name: call.name,
          input: call.input,
          callId: call.id,
          iteration: input.iteration,
          returnErrors: true,
          signal: input.signal
        })
      )
    );
    for (let index = 0; index < batch.length; index += 1) {
      const call = batch[index]!;
      const result = results[index]!;
      out.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: result.content
      });
    }
  }
  return out;
}

/** Backward-compatible name; scheduling is now risk-aware. */
export const executeSequentialToolCalls = executeScheduledToolCalls;

export function isIndependentRead(tool?: ToolMetadata): boolean {
  return Boolean(
    tool &&
    tool.risk === 'read' &&
    !tool.category?.startsWith('mcp:') &&
    tool.category !== 'process'
  );
}
