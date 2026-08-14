import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';

import type { AgentResult } from '@kross/core';

import { createPersistentAgentHost, type AgentHostHandle } from './coreRuntimeFactory';
import { createPersonalAgentProfile } from './runtime/workExecutionProfile';
import type { AgentControlTransport } from './transport';

export interface AgentLoopOptions {
  workspaceRoot: string;
  processEnv: Record<string, string | undefined>;
  transport: AgentControlTransport;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  shouldStop?: () => boolean;
}

export async function runAgentLoop(options: AgentLoopOptions): Promise<void> {
  await ensureWorkspaceLayout(options.workspaceRoot);
  const registered = await options.transport.register();
  const minted = await options.transport.mintModelEnvironment();
  const host: AgentHostHandle = await createPersistentAgentHost({
    workspaceRoot: options.workspaceRoot,
    env: { ...options.processEnv, ...minted },
    executionProfile: createPersonalAgentProfile()
  });
  const pollMs = options.pollMs ?? Math.min(registered.heartbeatIntervalMs, 2_000);
  const delay = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  try {
    while (!options.shouldStop?.()) {
      const heartbeat = await options.transport.heartbeat();
      if (heartbeat.shouldSleep) {
        await options.transport.sleep();
        return;
      }
      const job = await options.transport.claimJob();
      if (!job) {
        await delay(pollMs);
        continue;
      }
      try {
        const reply = await runTurn(host, formatTurnInput(job.content, job.history));
        await options.transport.postReply({
          userMessageId: job.id,
          content: reply.content,
          status: reply.status,
          ...(reply.errorSummary ? { errorSummary: reply.errorSummary } : {})
        });
      } catch (error) {
        const summary = error instanceof Error ? error.message : String(error);
        await options.transport.postReply({
          userMessageId: job.id,
          content: '',
          status: 'failed',
          errorSummary: summary
        });
      }
    }
  } finally {
    await host.close();
  }
}

async function runTurn(host: AgentHostHandle, input: string): Promise<{
  content: string;
  status: 'done' | 'failed';
  errorSummary?: string;
}> {
  let text = '';
  let result: AgentResult | undefined;
  for await (const event of host.runtime.runStreaming({ input, requestedMode: 'auto' })) {
    if (event.type === 'text-delta' && typeof event.text === 'string') text += event.text;
    if (event.type === 'result' && event.result) result = event.result;
  }
  if (!result) {
    return { content: text.trim(), status: text.trim() ? 'done' : 'failed', errorSummary: text.trim() ? undefined : 'Agent finished without a result' };
  }
  if (result.status === 'approval-required') {
    const preview = result.pendingApproval?.inputPreview || result.pendingApproval?.toolName || result.summary;
    return {
      content: `This turn needs approval before it can continue: ${preview}`,
      status: 'done'
    };
  }
  if (result.status === 'completed' || result.status === 'cancelled') {
    return { content: (result.summary || text).trim(), status: 'done' };
  }
  return {
    content: (result.summary || text).trim(),
    status: 'failed',
    errorSummary: result.summary || 'Agent turn failed'
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
