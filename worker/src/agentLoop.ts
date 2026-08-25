import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';

import type { AgentResult } from '../core/src/domain';
import type { AgentRunStreamEvent } from '../core/src/runtime/agentRuntimeTypes';

import { createPersistentAgentHost, type AgentHostHandle } from './coreRuntimeFactory';
import { ConversationRuntimeRegistry } from './conversationRuntimeRegistry';
import { createWorkerLogger } from './logger';
import { extractMemories } from './memoryExtract';
import { loadMemoryContextSources, writeMemoryFiles } from './memoryFiles';
import type {
  AgentContextUsage,
  AgentControlTransport,
  AgentStreamEvent,
  AgentTokenUsage
} from './transport';
import { handleWorkspaceCommand, writeMcpConfig } from './workspaceCommands';

const TOOL_CLIP_CHARS = 8_000;

export interface AgentLoopOptions {
  workspaceRoot: string;
  processEnv: Record<string, string | undefined>;
  transport: AgentControlTransport;
  sleep?: (ms: number) => Promise<void>;
  shouldStop?: () => boolean;
  signal?: AbortSignal;
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
  const log = createWorkerLogger({
    agentId: options.processEnv.KROSS_AGENT_ID,
    nodeId: options.processEnv.KROSS_NODE_ID
  });
  const registered = await options.transport.register();
  log.info('Worker registered', { idleMs: registered.idleMs });
  const settings = await options.transport.fetchSettings().catch((): {
    mcpServers: Record<string, unknown>;
    userMarkdown?: string;
    memoryMarkdown?: string;
  } => ({ mcpServers: {} }));
  await writeMcpConfig(options.workspaceRoot, settings.mcpServers);
  await writeMemoryFiles(options.workspaceRoot, settings.userMarkdown, settings.memoryMarkdown);
  const runtimes = new ConversationRuntimeRegistry();
  let modelEnv: Record<string, string | undefined> = { ...options.processEnv };
  options.transport.onCommand(async (command) => {
    try {
      if (command.name === 'memory.extract') {
        return { ok: true, payload: await extractMemories(modelEnv, command.payload) };
      }
      const payload = await handleWorkspaceCommand(options.workspaceRoot, command);
      if (command.name === 'mcp.save') {
        await runtimes.reloadMcp();
      }
      return { ok: true, payload };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  const minted = await options.transport.mintModelEnvironment();
  modelEnv = { ...options.processEnv, ...minted };
  let currentModelId = '';
  const delay = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  let sleeping = false;
  let inFlightJobs = 0;
  let activeJob: { id: string; leaseId: string; abort: AbortController } | undefined;
  const heartbeats = (async () => {
    while (!options.shouldStop?.() && !sleeping) {
      let heartbeat: Awaited<ReturnType<AgentControlTransport['heartbeat']>>;
      try {
        heartbeat = await options.transport.heartbeat(activeJob);
      } catch (error) {
        log.warn('Agent heartbeat failed; transport will reconnect', {
          error: error instanceof Error ? error.message : String(error)
        });
        await delay(1_000);
        continue;
      }
      if (activeJob && !heartbeat.leaseValid) {
        activeJob.abort.abort(new Error('Agent job lease is no longer active'));
      }
      if (heartbeat.shouldSleep) {
        if (inFlightJobs > 0) {
          log.info('Ignoring idle sleep request while a job is in flight', { inFlightJobs });
          await delay(heartbeat.heartbeatIntervalMs);
          continue;
        }
        sleeping = true;
        log.info('Worker sleeping due to idle timeout');
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
      inFlightJobs += 1;
      const jobAbort = new AbortController();
      activeJob = { id: job.id, leaseId: job.leaseId, abort: jobAbort };
      const runSignal = options.signal
        ? AbortSignal.any([options.signal, jobAbort.signal])
        : jobAbort.signal;
      try {
        log.info('Claimed conversation job', { conversationId: job.conversationId });
        const nextSkillKey = job.skill ? `${job.skill.id}@${job.skill.revision}` : '';
        const modelKey = job.modelId ?? '';
        const signature = `${modelKey}\u0000${nextSkillKey}`;
        if (modelKey !== currentModelId) {
          const nextEnv = await options.transport.mintModelEnvironment(job.modelId);
          modelEnv = { ...options.processEnv, ...nextEnv };
          currentModelId = modelKey;
        }
        const jobModelEnv = modelEnv;
        const host = await runtimes.acquire({
          conversationId: job.conversationId,
          signature,
          history: job.history,
          create: () =>
            createPersistentAgentHost({
              workspaceRoot: options.workspaceRoot,
              env: jobModelEnv,
              activeSkill: job.skill,
              memoryContextSources: loadMemoryContextSources(options.workspaceRoot)
            })
        });
        const reply = await runTurn(
          host,
          options.transport,
          job,
          job.content,
          runSignal
        );
        await options.transport.postReply({
          userMessageId: job.id,
          agentMessageId: job.agentMessageId,
          leaseId: job.leaseId,
          content: reply.content,
          status: reply.status,
          parts: reply.parts,
          ...(reply.usage ? { usage: reply.usage } : {}),
          ...(reply.contextUsage ? { contextUsage: reply.contextUsage } : {}),
          ...(reply.errorSummary ? { errorSummary: reply.errorSummary } : {})
        });
        log.info('Finished conversation job', {
          conversationId: job.conversationId,
          status: reply.status
        });
      } catch (error) {
        const summary = error instanceof Error ? error.message : String(error);
        log.warn('Agent turn failed', { conversationId: job.conversationId, error: summary });
        if (jobAbort.signal.aborted) {
          log.warn('Discarding stale job result after lease loss', { conversationId: job.conversationId });
          continue;
        }
        await options.transport.postReply({
          userMessageId: job.id,
          agentMessageId: job.agentMessageId,
          leaseId: job.leaseId,
          content: '',
          status: 'failed',
          errorSummary: summary
        });
      } finally {
        activeJob = undefined;
        inFlightJobs -= 1;
      }
    }
  } finally {
    options.transport.close();
    await heartbeats.catch(() => undefined);
    await runtimes.close();
  }
}

async function runTurn(
  host: AgentHostHandle,
  transport: AgentControlTransport,
  job: { id: string; agentMessageId: string; leaseId: string },
  input: string,
  signal?: AbortSignal
): Promise<{
  content: string;
  status: 'done' | 'failed';
  errorSummary?: string;
  parts: MessagePart[];
  usage?: AgentTokenUsage;
  contextUsage?: AgentContextUsage;
}> {
  const parts: MessagePart[] = [];
  const emit = async (event: AgentStreamEvent) => {
    await transport.postEvents({
      userMessageId: job.id,
      agentMessageId: job.agentMessageId,
      leaseId: job.leaseId,
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

  let result = await consume(host.runtime.runStreaming({ input, signal }));
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
      leaseId: job.leaseId,
      content: text.trim(),
      status: 'processing',
      parts
    });
    const decision = await transport.waitForApproval(result.runId);
    markApprovalResolved(parts, pending.toolCallId, decision.approved);
    result = await consume(host.runtime.resolveToolApprovalStreaming({
      runId: result.runId,
      approved: decision.approved,
      ...(decision.reason ? { reason: decision.reason } : {}),
      signal
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
    return {
      content: (result.summary || text).trim(),
      status: 'done',
      parts,
      usage: await readUsage(host, result.runId),
      contextUsage: readContextUsage(host)
    };
  }
  return {
    content: (result.summary || text).trim(),
    status: 'failed',
    errorSummary: result.summary || 'Agent turn failed',
    parts,
    usage: await readUsage(host, result.runId),
    contextUsage: readContextUsage(host)
  };
}

function readContextUsage(host: AgentHostHandle): AgentContextUsage {
  const usage = host.runtime.getContextUsage();
  return {
    usedTokens: usage.usedTokens,
    contextWindow: usage.contextWindow,
    ratio: usage.headerRatio
  };
}

async function readUsage(host: AgentHostHandle, runId: string): Promise<AgentTokenUsage | undefined> {
  const usage = await host.runtime.getRunUsage(runId).catch(() => undefined);
  if (!usage) return undefined;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    reasoningTokens: usage.reasoningTokens,
    estimatedCostUsd: usage.estimatedCostUsd,
    llmCalls: usage.calls,
    durationMs: usage.durationMs
  };
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
  await mkdir(join(root, '.kross'), { recursive: true });
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
