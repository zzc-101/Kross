import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { LlmClient, LlmRequest, LlmStreamChunk } from '../llm/types';
import { renderAgentExecutionPrompt } from '../prompts';
import { ToolGateway } from '../tools/toolGateway';
import {
  createCodingAgentExecutionProfile,
  type AgentCompletionAssessment,
  type AgentCompletionPolicyContext,
  type AgentExecutionProfile
} from './agentExecutionProfile';
import { AgentRuntime } from './agentRuntime';
import {
  FakeLlmClient,
  InMemoryTraceStore,
  streamFromComplete
} from './agentRuntime.testSupport';

class WriteThenFinishClient implements LlmClient {
  readonly provider = 'openai' as const;
  readonly requests: LlmRequest[] = [];

  async complete(request: LlmRequest) {
    this.requests.push(request);
    return this.requests.length === 1
      ? {
          provider: this.provider,
          model: 'fake',
          text: '',
          raw: {},
          toolCalls: [
            {
              id: 'write-1',
              name: 'Write',
              input: {
                path: 'src/profile.ts',
                content: 'export const profile = true;'
              }
            }
          ]
        }
      : {
          provider: this.provider,
          model: 'fake',
          text: '任务完成',
          raw: {}
        };
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    yield* streamFromComplete(await this.complete(request));
  }
}

class VerifyThenFinishClient implements LlmClient {
  readonly provider = 'openai' as const;
  private callCount = 0;

  async complete(request: LlmRequest) {
    this.callCount += 1;
    return this.callCount === 1
      ? {
          provider: this.provider,
          model: 'fake',
          text: '',
          raw: {},
          toolCalls: [
            {
              id: 'verify-1',
              name: 'Bash',
              input: { command: 'npm test' }
            }
          ]
        }
      : {
          provider: this.provider,
          model: 'fake',
          text: '验证完成',
          raw: {}
        };
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    yield* streamFromComplete(await this.complete(request));
  }
}

function createWriteGateway(traceStore: InMemoryTraceStore): ToolGateway {
  const gateway = new ToolGateway({ traceStore });
  gateway.register({
    name: 'Write',
    description: 'write a file',
    risk: 'write',
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    execute: async () => ({ content: 'written', summary: 'wrote file' })
  });
  return gateway;
}

function createWorkProfile(
  assess: (
    context: AgentCompletionPolicyContext
  ) => AgentCompletionAssessment = vi.fn(() => ({
    required: true,
    satisfied: true,
    status: 'passed' as const,
    reason: 'Artifact contract passed.'
  }))
): AgentExecutionProfile {
  return {
    id: 'work-test',
    buildSystemPrompt: ({ phase, defaultPrompt }) =>
      `WORK PROFILE (${phase})\n${defaultPrompt}`,
    createCompletionPolicy: () => ({
      id: 'artifact-contract',
      assessWithoutTools: true,
      assess,
      finalizeResult: ({ result }) => ({
        ...result,
        report: {
          ...result.report,
          evidence: [...result.report.evidence, 'artifact-contract=passed']
        }
      }),
      buildSatisfiedPrompt: () => 'Artifact contract passed; finish now.'
    }),
    createReviewPolicy: () => ({
      supportsConductor: false,
      unsupportedReason: 'Work review is not implemented.'
    }),
    getContextSources: () => ({
      remove: ['session-mode'],
      sources: [
        {
          id: 'work-contract',
          kind: 'user',
          title: 'Work contract',
          content: 'Produce a reviewable artifact.',
          pinned: true
        }
      ]
    }),
    describeProgress: (event) => ({ label: `work:${event.type}` }),
    getToolPolicy: () => ({
      isToolVisible: (tool) => tool.name !== 'CodingOnly',
      observeCodingVerificationLifecycle: false
    })
  };
}

describe('AgentExecutionProfile', () => {
  it('keeps omitted and explicit Coding profiles prompt/result equivalent', async () => {
    const implicitClient = new FakeLlmClient('完成');
    const explicitClient = new FakeLlmClient('完成');
    const implicit = new AgentRuntime({
      traceStore: new InMemoryTraceStore(),
      llmClient: implicitClient,
      createRunId: () => 'run-equivalent'
    });
    const explicit = new AgentRuntime({
      traceStore: new InMemoryTraceStore(),
      llmClient: explicitClient,
      executionProfile: createCodingAgentExecutionProfile(),
      createRunId: () => 'run-equivalent'
    });

    const [implicitResult, explicitResult] = await Promise.all([
      implicit.run({ input: '解释当前实现', requestedMode: 'auto' }),
      explicit.run({ input: '解释当前实现', requestedMode: 'auto' })
    ]);

    expect(implicit.getExecutionProfileId()).toBe('coding');
    expect(explicit.getExecutionProfileId()).toBe('coding');
    expect(implicitClient.requests[0]?.messages).toEqual(
      explicitClient.requests[0]?.messages
    );
    expect(implicitClient.requests[0]?.messages[0]).toMatchObject({
      role: 'system'
    });
    expect(implicitClient.requests[0]?.messages[0]?.content).toContain(
      renderAgentExecutionPrompt({
        sessionMode: 'auto',
        mode: 'auto'
      })
    );
    expect(implicitResult).toEqual(explicitResult);
  });

  it('isolates custom prompt, context, completion, and review policies', async () => {
    const assess = vi.fn(() => ({
      required: true,
      satisfied: true,
      status: 'passed' as const,
      reason: 'Artifact contract passed.'
    }));
    const workClient = new FakeLlmClient('已生成交付物');
    const codingClient = new FakeLlmClient('普通编码回复');
    const work = new AgentRuntime({
      traceStore: new InMemoryTraceStore(),
      llmClient: workClient,
      executionProfile: createWorkProfile(assess)
    });
    const coding = new AgentRuntime({
      traceStore: new InMemoryTraceStore(),
      llmClient: codingClient
    });

    const workResult = await work.run({
      input: '生成报告',
      requestedMode: 'auto'
    });
    await coding.run({ input: '解释代码', requestedMode: 'auto' });

    const workMessages = workClient.requests[0]?.messages ?? [];
    const codingMessages = codingClient.requests[0]?.messages ?? [];
    expect(work.getExecutionProfileId()).toBe('work-test');
    expect(
      work.describeProgress({
        id: 'event-1',
        runId: 'run-1',
        type: 'run.started',
        timestamp: new Date().toISOString(),
        payload: {}
      })
    ).toEqual({ label: 'work:run.started' });
    expect(workMessages[0]?.content).toContain('WORK PROFILE (agent)');
    expect(
      workMessages.some((message) => message.content.includes('Work contract'))
    ).toBe(true);
    expect(
      workMessages.some((message) =>
        message.content.includes('当前会话 Mode')
      )
    ).toBe(false);
    expect(codingMessages[0]?.content).not.toContain('WORK PROFILE');
    expect(
      codingMessages.some((message) =>
        message.content.includes('Work contract')
      )
    ).toBe(false);
    expect(assess).toHaveBeenCalledOnce();
    expect(workResult.report.evidence).toContain('artifact-contract=passed');

    const unsupported = await work.run({
      input: '让指挥家执行',
      requestedMode: 'conductor'
    });
    expect(unsupported).toMatchObject({
      status: 'failed',
      summary: 'Work review is not implemented.'
    });
  });

  it('only subtracts profile-hidden tools while Coding keeps all gateway tools visible', async () => {
    const createGateway = () => {
      const gateway = new ToolGateway();
      for (const name of ['Shared', 'CodingOnly']) {
        gateway.register({
          name,
          description: name,
          risk: 'read',
          inputSchema: z.object({}),
          execute: async () => ({ content: name })
        });
      }
      return gateway;
    };
    const workClient = new FakeLlmClient('work done');
    const codingClient = new FakeLlmClient('coding done');
    const work = new AgentRuntime({
      traceStore: new InMemoryTraceStore(),
      llmClient: workClient,
      toolGateway: createGateway(),
      executionProfile: createWorkProfile()
    });
    const coding = new AgentRuntime({
      traceStore: new InMemoryTraceStore(),
      llmClient: codingClient,
      toolGateway: createGateway()
    });

    await work.run({ input: '生成报告', requestedMode: 'auto' });
    await coding.run({ input: '修改代码', requestedMode: 'auto' });

    expect(workClient.requests[0]?.tools?.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['Shared', 'SetMode'])
    );
    expect(workClient.requests[0]?.tools?.map((tool) => tool.name)).not.toContain(
      'CodingOnly'
    );
    expect(codingClient.requests[0]?.tools?.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['Shared', 'CodingOnly', 'SetMode'])
    );

    const inspected = work.inspectContext({ requestedMode: 'auto' });
    expect(inspected.report.contributors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'tool:Shared' }),
        expect.objectContaining({ id: 'tool:SetMode' })
      ])
    );
    expect(
      inspected.report.contributors.some(
        (contributor) => contributor.id === 'tool:CodingOnly'
      )
    ).toBe(false);
  });

  it('nests and bounds JSON-safe completion metadata without overwriting event fields', async () => {
    const circular: Record<string, unknown> = {
      iteration: 999,
      attempt: 999,
      status: 'overwritten',
      reason: 'overwritten',
      long: 'x'.repeat(800),
      bigint: 12n,
      ignored: () => undefined,
      array: Array.from({ length: 80 }, (_, index) => index)
    };
    circular.self = circular;
    const profile = createWorkProfile(
      vi.fn(() => ({
        required: true,
        satisfied: false,
        status: 'not-run' as const,
        reason: 'Artifact is missing.',
        metadata: circular
      }))
    );
    const traceStore = new InMemoryTraceStore();
    const runtime = new AgentRuntime({
      traceStore,
      llmClient: new FakeLlmClient('过早完成'),
      executionProfile: profile,
      createRunId: () => 'run-metadata'
    });

    const result = await runtime.run({
      input: '生成交付物',
      requestedMode: 'auto'
    });

    expect(result.status).toBe('failed');
    const followup = traceStore.events.find(
      (event) => event.type === 'run.completion.followup'
    );
    expect(followup?.payload).toMatchObject({
      iteration: 1,
      attempt: 1,
      status: 'not-run',
      reason: 'Artifact is missing.',
      metadata: {
        iteration: 999,
        attempt: 999,
        status: 'overwritten',
        reason: 'overwritten',
        bigint: '12',
        self: '[circular]'
      }
    });
    const metadata = followup?.payload.metadata as Record<string, unknown>;
    expect(String(metadata.long)).toHaveLength(500);
    expect(metadata.array).toHaveLength(24);
    expect(metadata).not.toHaveProperty('ignored');
    expect(() => JSON.stringify(followup?.payload)).not.toThrow();
  });

  it('lets non-Coding profiles disable Coding verification lifecycle events', async () => {
    const traceStore = new InMemoryTraceStore();
    const gateway = new ToolGateway({ traceStore });
    gateway.register({
      name: 'Bash',
      description: 'run command',
      risk: 'execute',
      inputSchema: z.object({ command: z.string() }),
      execute: async () => ({
        content: 'passed',
        summary: 'exit=0',
        data: { exitCode: 0 }
      })
    });
    const runtime = new AgentRuntime({
      traceStore,
      llmClient: new VerifyThenFinishClient(),
      toolGateway: gateway,
      executionProfile: createWorkProfile()
    });

    const result = await runtime.run({
      input: '验证生成物',
      requestedMode: 'auto'
    });

    expect(result.status).toBe('completed');
    expect(
      traceStore.events.some((event) =>
        event.type.startsWith('run.verification.')
      )
    ).toBe(false);
  });

  it('clears a persisted Conductor gate when the profile cannot review it', () => {
    const runtime = new AgentRuntime({
      traceStore: new InMemoryTraceStore(),
      executionProfile: createWorkProfile()
    });

    expect(
      runtime.restoreWorkState({
        version: 1,
        todos: [],
        sessionMode: 'conductor',
        pendingModeExecution: {
          kind: 'conductor',
          goal: '生成报告',
          mode: 'conductor',
          plan: {
            goal: '生成报告',
            tasks: [
              {
                id: 'report',
                title: '生成报告',
                prompt: '完成报告'
              }
            ]
          }
        }
      })
    ).toBe(false);
    expect(runtime.getPendingModeExecution()).toBeUndefined();
  });

  it('keeps the injected profile prompt after tool approval resumes', async () => {
    const llmClient = new WriteThenFinishClient();
    const traceStore = new InMemoryTraceStore();
    const toolGateway = createWriteGateway(traceStore);
    const runtime = new AgentRuntime({
      traceStore,
      llmClient,
      toolGateway,
      executionProfile: createWorkProfile()
    });
    toolGateway.setApprovalPolicy(() => ({ action: 'ask' }));

    const pending = await runtime.run({
      input: '生成需要确认的文件',
      requestedMode: 'auto'
    });
    expect(pending.status).toBe('approval-required');

    const completed = await runtime.resolveToolApproval({
      runId: pending.runId,
      approved: true
    });

    expect(completed.status).toBe('completed');
    expect(llmClient.requests).toHaveLength(2);
    for (const request of llmClient.requests) {
      expect(
        request.messages.find((message) => message.role === 'system')?.content
      ).toContain('WORK PROFILE (agent)');
    }
  });

  it('does not weaken Coding verification when another runtime bypasses it', async () => {
    const codingClient = new WriteThenFinishClient();
    const codingTrace = new InMemoryTraceStore();
    const coding = new AgentRuntime({
      traceStore: codingTrace,
      llmClient: codingClient,
      toolGateway: createWriteGateway(codingTrace)
    });

    const workClient = new WriteThenFinishClient();
    const workTrace = new InMemoryTraceStore();
    const work = new AgentRuntime({
      traceStore: workTrace,
      llmClient: workClient,
      toolGateway: createWriteGateway(workTrace),
      executionProfile: createWorkProfile()
    });

    const [codingResult, workResult] = await Promise.all([
      coding.run({ input: '修改代码', requestedMode: 'auto' }),
      work.run({ input: '生成 TypeScript 交付物', requestedMode: 'auto' })
    ]);

    expect(codingResult).toMatchObject({
      status: 'failed',
      report: { verification: { status: 'not-run' } }
    });
    expect(
      codingTrace.events.filter(
        (event) => event.type === 'run.verification.followup'
      )
    ).toHaveLength(1);
    expect(workResult).toMatchObject({
      status: 'completed',
      report: {
        changedFiles: ['src/profile.ts'],
        evidence: expect.arrayContaining(['artifact-contract=passed'])
      }
    });
    expect(
      workTrace.events.some(
        (event) => event.type === 'run.verification.followup'
      )
    ).toBe(false);
  });
});
