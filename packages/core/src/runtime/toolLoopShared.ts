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

/** Execute tool calls sequentially via gateway (returnErrors: true). */
export async function executeSequentialToolCalls(input: {
  runId: string;
  gateway: ToolGateway;
  calls: LlmToolCall[];
  iteration?: number;
  signal?: AbortSignal;
}): Promise<LlmMessage[]> {
  const out: LlmMessage[] = [];
  for (const call of input.calls) {
    throwIfAborted(input.signal);
    const result = await input.gateway.call({
      runId: input.runId,
      name: call.name,
      input: call.input,
      callId: call.id,
      iteration: input.iteration,
      returnErrors: true,
      signal: input.signal
    });
    out.push({
      role: 'tool',
      toolCallId: call.id,
      name: call.name,
      content: result.content
    });
  }
  return out;
}
