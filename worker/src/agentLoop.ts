import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';

import type { AgentResult } from '../core/src/domain';
import type { AgentRunStreamEvent } from '../core/src/runtime/agentRuntimeTypes';

import { createPersistentAgentHost, type AgentHostHandle } from './coreRuntimeFactory';
import { createPersonalAgentProfile } from './runtime/workExecutionProfile';
import type { AgentControlTransport, AgentStreamEvent } from './transport';

const TOOL_CLIP_CHARS = 8_000;

export interface AgentLoopOptions {
  workspaceRoot: string;
  processEnv: Record<string, string | undefined>;
  transport: AgentControlTransport;
  sleep?: (ms: number) => Promise<void>;
  shouldStop?: () => boolean;
}

type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | {
      type: 'tool';
      id: string;
      name: string;
      input?: unknown;
      result?: string;
      status: 'running' | 'approval-required' | 'done' | 'failed';
      approval?: {
        id: string;
        risk: string;
        reason?: string;
        inputPreview?: string;
        approved?: boolean;
      };
    };

export async function runAgentLoop(options: AgentLoopOptions): Promise<void> {
  await ensureWorkspaceLayout(options.workspaceRoot);
  const registered = await options.transport.register();
  const minted = await options.transport.mintModelEnvironment();
  const host: AgentHostHandle = await createPersistentAgentHost({
    workspaceRoot: options.workspaceRoot,
    env: { ...options.processEnv, ...minted },
    executionProfile: createPersonalAgentProfile()
  });
  const delay = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  let sleeping = false;
  const heartbeats = (async () => {
    while (!options.shouldStop?.() && !sleeping) {
      const heartbeat = await options.transport.heartbeat();
      if (heartbeat.shouldSleep) {
        sleeping = true;
        await options.transport.sleep();
        return;
      }
      await delay(heartbeat.heartbeatIntervalMs);
    }
  })();
  try {
    while (!options.shouldStop?.() && !sleeping) {
      const job = await options.transport.claimJob();
      if (!job) {
        break;
      }
      try {
        const reply = await runTurn(host, options.transport, job, formatTurnInput(job.content, job.history));
        await options.transport.postReply({
          userMessageId: job.id,
          agentMessageId: job.agentMessageId,
          content: reply.content,
          status: reply.status,
          parts: reply.parts,
          ...(reply.errorSummary ? { errorSummary: reply.errorSummary } : {})
        });
      } catch (error) {
        const summary = error instanceof Error ? error.message : String(error);
        await options.transport.postReply({
          userMessageId: job.id,
          agentMessageId: job.agentMessageId,
          content: '',
          status: 'failed',
          errorSummary: summary
        });
      }
    }
  } finally {
    options.transport.close();
    await heartbeats.catch(() => undefined);
    await host.close();
  }
}

async function runTurn(
  host: AgentHostHandle,
  transport: AgentControlTransport,
  job: { id: string; agentMessageId: string },
  input: string
): Promise<{
  content: string;
  status: 'done' | 'failed';
  errorSummary?: string;
  parts: MessagePart[];
}> {
  const parts: MessagePart[] = [];
  const emit = async (event: AgentStreamEvent) => {
    await transport.postEvents({
      userMessageId: job.id,
      agentMessageId: job.agentMessageId,
      events: [event]
    });
  };

  let text = '';
  const consume = async (stream: AsyncIterable<AgentRunStreamEvent>): Promise<AgentResult | undefined> => {
    let streamResult: AgentResult | undefined;
    for await (const event of stream) {
      if (event.type === 'text-delta' && typeof event.text === 'string' && event.text) {
        text += event.text;
        appendText(parts, event.text);
        await emit({ type: 'text-delta', text: event.text });
      } else if (event.type === 'thinking-delta' && typeof (event as { text?: string }).text === 'string') {
        const thinking = (event as { text: string }).text;
        appendReasoning(parts, thinking);
        await emit({ type: 'thinking-delta', text: thinking });
      } else if (event.type === 'tool-call') {
        const call = event;
        upsertTool(parts, call.id, call.name, call.input, 'running');
        await emit({
          type: 'tool-call',
          id: call.id,
          name: call.name,
          input: clipJson(call.input)
        });
      } else if (event.type === 'tool-result') {
        const tool = event;
        const ok = tool.ok !== false;
        completeTool(parts, tool.id, tool.name, clipText(tool.content), ok);
        await emit({
          type: 'tool-result',
          id: tool.id,
          name: tool.name,
          content: clipText(tool.content),
          ok
        });
      } else if (event.type === 'result' && event.result) {
        streamResult = event.result;
      }
    }
    return streamResult;
  };

  let result = await consume(host.runtime.runStreaming({ input, requestedMode: 'auto' }));
  while (result?.status === 'approval-required') {
    const pending = result.pendingApproval;
    if (!pending) {
      return {
        content: text.trim(),
        status: 'failed',
        errorSummary: 'Agent requested approval without approval details',
        parts
      };
    }
    markToolApproval(parts, pending.toolCallId, {
      id: result.runId,
      risk: pending.risk,
      reason: pending.reason,
      inputPreview: pending.inputPreview
    });
    await transport.postReply({
      userMessageId: job.id,
      agentMessageId: job.agentMessageId,
      content: text.trim(),
      status: 'processing',
      parts
    });
    const decision = await transport.waitForApproval(result.runId);
    markApprovalResolved(parts, pending.toolCallId, decision.approved);
    result = await consume(host.runtime.resolveToolApprovalStreaming({
      runId: result.runId,
      approved: decision.approved,
      ...(decision.reason ? { reason: decision.reason } : {})
    }));
  }

  if (!result) {
    return {
      content: text.trim(),
      status: text.trim() ? 'done' : 'failed',
      errorSummary: text.trim() ? undefined : 'Agent finished without a result',
      parts
    };
  }
  if (result.status === 'completed' || result.status === 'cancelled') {
    return { content: (result.summary || text).trim(), status: 'done', parts };
  }
  return {
    content: (result.summary || text).trim(),
    status: 'failed',
    errorSummary: result.summary || 'Agent turn failed',
    parts
  };
}

function formatTurnInput(
  content: string,
  history: Array<{ role: string; content: string }>
): string {
  if (history.length === 0) return content;
  const prior = history
    .map((turn) => `${turn.role === 'agent' ? 'assistant' : turn.role}: ${turn.content}`)
    .join('\n\n');
  return `Conversation so far:\n\n${prior}\n\nCurrent user message:\n${content}`;
}

function appendText(parts: MessagePart[], text: string): void {
  const last = parts[parts.length - 1];
  if (last?.type === 'text') {
    last.text += text;
    return;
  }
  parts.push({ type: 'text', text });
}

function appendReasoning(parts: MessagePart[], text: string): void {
  const last = parts[parts.length - 1];
  if (last?.type === 'reasoning') {
    last.text += text;
    return;
  }
  parts.push({ type: 'reasoning', text });
}

function upsertTool(
  parts: MessagePart[],
  id: string,
  name: string,
  input: unknown,
  status: 'running' | 'done' | 'failed'
): void {
  const existing = parts.find((part) => part.type === 'tool' && part.id === id);
  if (existing && existing.type === 'tool') {
    existing.name = name;
    existing.status = status;
    return;
  }
  parts.push({ type: 'tool', id, name, input: clipJson(input), status });
}

function markToolApproval(
  parts: MessagePart[],
  toolCallId: string,
  approval: { id: string; risk: string; reason?: string; inputPreview?: string }
): void {
  const existing = parts.find((part) => part.type === 'tool' && part.id === toolCallId);
  if (!existing || existing.type !== 'tool') return;
  existing.status = 'approval-required';
  existing.approval = approval;
}

function markApprovalResolved(parts: MessagePart[], toolCallId: string, approved: boolean): void {
  const existing = parts.find((part) => part.type === 'tool' && part.id === toolCallId);
  if (!existing || existing.type !== 'tool' || !existing.approval) return;
  existing.approval.approved = approved;
  existing.status = 'running';
}

function completeTool(parts: MessagePart[], id: string, name: string, result: string, ok: boolean): void {
  const existing = parts.find((part) => part.type === 'tool' && part.id === id);
  if (existing && existing.type === 'tool') {
    existing.name = name;
    existing.result = result;
    existing.status = ok ? 'done' : 'failed';
    return;
  }
  parts.push({ type: 'tool', id, name, result, status: ok ? 'done' : 'failed' });
}

function clipText(value: string): string {
  if (value.length <= TOOL_CLIP_CHARS) return value;
  return `${value.slice(0, TOOL_CLIP_CHARS)}\n...`;
}

function clipJson(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return clipText(value);
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length <= TOOL_CLIP_CHARS) return value;
    return clipText(serialized);
  } catch {
    return undefined;
  }
}

async function ensureWorkspaceLayout(root: string): Promise<void> {
  await mkdir(join(root, 'files'), { recursive: true });
  await mkdir(join(root, 'memory'), { recursive: true });
  await mkdir(join(root, 'skills'), { recursive: true });
  await writeIfMissing(join(root, 'USER.md'), '# User\n\nDescribe preferences for this Agent.\n');
  await writeIfMissing(join(root, 'MEMORY.md'), '# Memory\n\nLong-term notes for this Agent.\n');
}

async function writeIfMissing(path: string, content: string): Promise<void> {
  try {
    await access(path);
  } catch {
    await writeFile(path, content, { encoding: 'utf8', mode: 0o600 });
  }
}
