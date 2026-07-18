import { describe, expect, it } from 'vitest';
import {
  AgentRuntime,
  chunkTextForStream,
  isCasualChatInput,
  parsePlanIntentKind
} from './agentRuntime';
import { InMemoryContextManager, type SessionContext } from '../context/sessionContext';
import type { LlmMessage } from '../llm/types';
import type { TraceEvent } from '../domain';
import type {
  LlmClient,
  LlmRequest,
  LlmResponse,
  LlmStreamChunk
} from '../llm/types';
import { ToolGateway } from '../tools/toolGateway';
import type { TraceStore } from '../trace/traceStore';
import { WorkspaceRoots } from '../workspace/workspaceRoots';
import { z } from 'zod';
import {
  streamFromComplete,
  getStoredConversation,
  InMemoryTraceStore,
  FakeLlmClient,
  FailingLlmClient,
  StreamingLlmClient,
  ThinkingStreamingLlmClient,
  MultiTurnStreamingToolClient,
  ToolCallingLlmClient,
  BuiltinWriteToolCallingLlmClient,
  MultiStepToolCallingLlmClient,
  LoopingToolCallingLlmClient,
  ReadThenWriteToolCallingLlmClient,
  ParallelToolCallingLlmClient,
  StreamingToolCallingLlmClient,
  LoopingStreamingToolClient,
  WriteToolCallingLlmClient,
  DoubleWriteApprovalLlmClient,
  AbortableStreamingLlmClient,
  SingleToolStreamingLlmClient,
  waitForAbort
} from './agentRuntime.testSupport';

describe('AgentRuntime observability', () => {
  it('records a context report before planner LLM calls', async () => {
      const traceStore = new InMemoryTraceStore();
      const llmClient = new FakeLlmClient('ok');
      const runtime = new AgentRuntime({
        traceStore,
        llmClient,
        contextManager: new InMemoryContextManager()
      });

      await runtime.run({
        input: 'hello',
        requestedMode: 'auto'
      });

      const contextEvent = traceStore.events.find(
        (event) => event.type === 'context.built'
      );
      expect(contextEvent?.payload).toMatchObject({
        includedSources: expect.arrayContaining(['session-mode']),
        droppedSources: [],
        report: expect.objectContaining({
          totalChars: expect.any(Number),
          sections: expect.objectContaining({
            system: expect.any(Number),
            history: expect.any(Number)
          })
        })
      });
      expect(llmClient.requests[0]?.metadata).toMatchObject({
        contextReport: expect.objectContaining({
          totalChars: expect.any(Number)
        })
      });
    });

  it('inspects the current session context without calling the LLM', async () => {
      const traceStore = new InMemoryTraceStore();
      const llmClient = new FakeLlmClient('第一轮回复');
      const toolGateway = new ToolGateway();
      toolGateway.register({
        name: 'fs.read',
        description: '读取文件内容',
        risk: 'read',
        inputSchema: z.object({ path: z.string() }),
        execute: async () => ({ content: 'file content' })
      });
      const runtime = new AgentRuntime({
        traceStore,
        llmClient,
        contextManager: new InMemoryContextManager(),
        toolGateway
      });

      await runtime.run({
        input: '第一轮',
        requestedMode: 'auto'
      });
      const beforeInspectCalls = llmClient.requests.length;

      const snapshot = runtime.inspectContext({
        requestedMode: 'auto',
        currentUserInput: ''
      });

      expect(llmClient.requests).toHaveLength(beforeInspectCalls);
      expect(snapshot.mode).toBe('auto');
      expect(
        snapshot.messages.find((message) => message.role === 'system')?.content
      ).toContain('Auto 模式：');
      expect(snapshot.report.sections.history).toBeGreaterThan(0);
      expect(snapshot.report.sections.tools).toBeGreaterThan(0);
      expect(snapshot.report.contributors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'history', section: 'history' }),
          expect.objectContaining({ id: 'tool:fs.read', section: 'tools' })
        ])
      );
    });

  it('lists and inspects traces for /trace command', async () => {
      const traceStore = new InMemoryTraceStore();
      const runtime = new AgentRuntime({
        traceStore,
        llmClient: new FakeLlmClient('计划完成'),
        createRunId: () => 'run-trace-1'
      });

      await runtime.run({
        input: '修复登录 bug',
        requestedMode: 'auto'
      });

      const listed = await runtime.listTraces({ limit: 5 });
      expect(listed[0]).toMatchObject({
        runId: 'run-trace-1',
        status: 'completed',
        mode: 'auto',
        inputPreview: '修复登录 bug'
      });

      const detail = await runtime.inspectTrace('run-trace-1');
      expect(detail?.summaryPreview).toContain('计划完成');

      const listText = await runtime.formatTraceCommand();
      expect(listText).toContain('run-trace-1');
      expect(listText).toContain('修复登录 bug');

      const detailText = await runtime.formatTraceCommand('run-trace-1');
      expect(detailText).toContain('Trace: run-trace-1');
      expect(detailText).toContain('completed');

      const missing = await runtime.formatTraceCommand('run-missing');
      expect(missing).toContain('未找到 run');
    });

  it('fills report.changedFiles from Write/Edit tool calls and formats /diff', async () => {
      const traceStore = new InMemoryTraceStore();
      const llmClient = new BuiltinWriteToolCallingLlmClient();
      const toolGateway = new ToolGateway({ traceStore });
      toolGateway.register({
        name: 'Write',
        description: 'write',
        risk: 'write',
        inputSchema: z.object({
          path: z.string(),
          content: z.string()
        }),
        execute: async () => ({ content: 'ok', summary: 'wrote 5 bytes' })
      });

      const runtime = new AgentRuntime({
        traceStore,
        llmClient,
        toolGateway,
        createRunId: () => 'run-diff-1',
        workspaceRoot: '/tmp/workspace',
        runGit: async (args) => {
          if (args[0] === 'status') {
            return { stdout: '?? src/demo.ts\n', stderr: '' };
          }
          return { stdout: '', stderr: '' };
        }
      });
      // Runtime 会覆盖 gateway 的 approvalPolicy；用 auto 放行 Write
      runtime.setPermissionMode('auto');

      const result = await runtime.run({
        input: '写个文件',
        requestedMode: 'auto'
      });

      expect(result.report.changedFiles).toEqual(['src/demo.ts']);
      expect(result.report.verification).toMatchObject({
        status: 'not-run',
        commands: []
      });

      const completed = (await traceStore.readRun('run-diff-1')).find(
        (event) => event.type === 'run.completed'
      );
      expect(completed?.payload).toMatchObject({
        report: { changedFiles: ['src/demo.ts'] }
      });

      const diffText = await runtime.formatDiffCommand();
      expect(diffText).toContain('run: run-diff-1');
      expect(diffText).toContain('src/demo.ts  [Write]');
      expect(diffText).toContain('?? src/demo.ts');

      const missing = await runtime.formatDiffCommand('run-missing');
      expect(missing).toContain('未找到 run');

      const unsafe = await runtime.formatDiffCommand('../escape');
      expect(unsafe).toContain('无效 runId');
    });

  it('derives a passed verification report from Bash trace evidence', async () => {
      class VerificationLlmClient implements LlmClient {
        readonly provider = 'openai' as const;
        requests: LlmRequest[] = [];

        async complete(request: LlmRequest): Promise<LlmResponse> {
          this.requests.push(request);
          return this.requests.length === 1
            ? {
                provider: this.provider,
                model: 'fake',
                text: '',
                raw: {},
                toolCalls: [
                  {
                    id: 'verify-1',
                    name: 'Bash',
                    input: { command: 'npm test -- --run focused.test.ts' }
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

      const traceStore = new InMemoryTraceStore();
      const llmClient = new VerificationLlmClient();
      const toolGateway = new ToolGateway({ traceStore });
      toolGateway.register({
        name: 'Bash',
        description: 'run command',
        risk: 'execute',
        inputSchema: z.object({ command: z.string() }),
        execute: async () => ({
          content: '1 test passed',
          summary: 'exit=0, 1 line',
          data: { exitCode: 0 }
        })
      });
      const runtime = new AgentRuntime({
        traceStore,
        llmClient,
        toolGateway,
        createRunId: () => 'run-verification-report'
      });
      runtime.setPermissionMode('auto');

      const result = await runtime.run({
        input: '运行测试',
        requestedMode: 'auto'
      });

      expect(result.report.verification).toMatchObject({
        status: 'passed',
        commands: ['npm test']
      });
      expect(result.report.verification.evidence[0]).toContain('exit=0');
      expect(result.report.verification.evidence[0]).toContain('iteration=1');
      const completed = traceStore.events.find(
        (event) => event.type === 'run.completed'
      );
      expect(completed?.payload).toMatchObject({
        report: {
          verification: {
            status: 'passed',
            commands: ['npm test']
          }
        }
      });
      expect(
        traceStore.events
          .filter((event) => event.type === 'run.phase.changed')
          .map((event) => event.payload.phase)
      ).toEqual(['inspect', 'verify', 'review', 'complete']);
      expect(
        traceStore.events.filter(
          (event) => event.type === 'run.verification.started'
        )
      ).toHaveLength(1);
      expect(
        traceStore.events.filter(
          (event) => event.type === 'run.verification.completed'
        )[0]?.payload
      ).toMatchObject({ status: 'passed', commandCount: 1 });
    });

  it('does not let final model text override a failed verification command', async () => {
      let requests = 0;
      const llmClient: LlmClient = {
        provider: 'openai',
        async complete(): Promise<LlmResponse> {
          requests += 1;
          return requests === 1
            ? {
                provider: 'openai',
                model: 'fake',
                text: '',
                raw: {},
                toolCalls: [
                  {
                    id: 'verify-failed',
                    name: 'Bash',
                    input: { command: 'npm run typecheck' }
                  }
                ]
              }
            : {
                provider: 'openai',
                model: 'fake',
                text: '所有检查都通过了',
                raw: {}
              };
        },
        async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
          yield* streamFromComplete(await this.complete(request));
        }
      };
      const traceStore = new InMemoryTraceStore();
      const toolGateway = new ToolGateway({ traceStore });
      toolGateway.register({
        name: 'Bash',
        description: 'run command',
        risk: 'execute',
        inputSchema: z.object({ command: z.string() }),
        execute: async () => ({
          content: 'Type error',
          summary: 'exit=2, 1 line',
          data: { exitCode: 2 }
        })
      });
      const runtime = new AgentRuntime({ traceStore, llmClient, toolGateway });
      runtime.setPermissionMode('auto');

      const result = await runtime.run({
        input: '检查类型',
        requestedMode: 'auto'
      });

      expect(result.summary).toBe('所有检查都通过了');
      expect(result.report.verification).toMatchObject({
        status: 'failed',
        commands: ['npm run typecheck'],
        reason: expect.stringContaining('verification command failed')
      });
      expect(result.report.verification.evidence[0]).toContain('exit=2');
    });

  it('asks once for post-mutation verification before allowing an unverified close', async () => {
    const llmClient = new ScriptedVerificationGateClient([
      toolResponse('write-1', 'Write', {
        path: 'src/gate.ts',
        content: 'export const gate = true;'
      }),
      textResponse('已经完成'),
      textResponse('当前环境无法运行验证')
    ]);
    const traceStore = new InMemoryTraceStore();
    const toolGateway = createVerificationGateGateway(traceStore);
    const runtime = new AgentRuntime({
      traceStore,
      llmClient,
      toolGateway,
      createRunId: () => 'run-verification-followup'
    });
    runtime.setPermissionMode('auto');

    const result = await runtime.run({
      input: '修改 gate 实现',
      requestedMode: 'auto'
    });

    expect(llmClient.requests).toHaveLength(3);
    expect(
      llmClient.requests[2]?.messages.find((message) => message.role === 'system')
        ?.content
    ).toContain('Harness 验证指令');
    expect(result).toMatchObject({
      status: 'completed',
      summary: '当前环境无法运行验证',
      report: {
        verification: { status: 'not-run' },
        risks: expect.arrayContaining([
          expect.stringContaining('没有可信的验证通过证据')
        ])
      }
    });
    expect(
      traceStore.events.filter(
        (event) => event.type === 'run.verification.followup'
      )
    ).toHaveLength(1);
    expect(
      traceStore.events.filter(
        (event) => event.type === 'run.verification.exhausted'
      )
    ).toHaveLength(1);
  });

  it('completes normally when the follow-up runs a passing check after mutation', async () => {
    const llmClient = new ScriptedVerificationGateClient([
      toolResponse('write-1', 'Write', {
        path: 'src/gate.ts',
        content: 'export const gate = true;'
      }),
      textResponse('已经完成'),
      toolResponse('test-1', 'Bash', { command: 'npm test' }),
      textResponse('修改与验证均已完成')
    ]);
    const traceStore = new InMemoryTraceStore();
    const runtime = new AgentRuntime({
      traceStore,
      llmClient,
      toolGateway: createVerificationGateGateway(traceStore)
    });
    runtime.setPermissionMode('auto');

    const result = await runtime.run({
      input: '修改并验证 gate 实现',
      requestedMode: 'auto'
    });

    expect(llmClient.requests).toHaveLength(4);
    expect(result.report.verification).toMatchObject({
      status: 'passed',
      commands: ['npm test']
    });
    expect(result.report.risks).not.toEqual(
      expect.arrayContaining([expect.stringContaining('未验证风险')])
    );
    expect(
      traceStore.events
        .filter((event) => event.type === 'run.phase.changed')
        .map((event) => event.payload.phase)
    ).toEqual(['inspect', 'act', 'review', 'verify', 'review', 'complete']);
  });

  it('reports an explicitly requested but unavailable check as not-run', async () => {
    const traceStore = new InMemoryTraceStore();
    const llmClient = new FakeLlmClient('当前没有可用的命令工具');
    const runtime = new AgentRuntime({
      traceStore,
      llmClient,
      toolGateway: new ToolGateway({ traceStore })
    });

    const result = await runtime.run({
      input: '请运行 `npm test`',
      requestedMode: 'auto'
    });

    expect(llmClient.requests).toHaveLength(2);
    expect(result.report.verification).toMatchObject({
      status: 'not-run',
      reason: expect.stringContaining('npm test')
    });
    expect(result.report.risks).toEqual(
      expect.arrayContaining([expect.stringContaining('npm test')])
    );
  });
});

class ScriptedVerificationGateClient implements LlmClient {
  readonly provider = 'openai' as const;
  readonly requests: LlmRequest[] = [];

  constructor(private readonly responses: LlmResponse[]) {}

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    return this.responses[this.requests.length - 1] ?? textResponse('结束');
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    yield* streamFromComplete(await this.complete(request));
  }
}

function toolResponse(
  id: string,
  name: string,
  input: Record<string, unknown>
): LlmResponse {
  return {
    provider: 'openai',
    model: 'fake',
    text: '',
    raw: {},
    toolCalls: [{ id, name, input }]
  };
}

function textResponse(text: string): LlmResponse {
  return { provider: 'openai', model: 'fake', text, raw: {} };
}

function createVerificationGateGateway(traceStore: TraceStore): ToolGateway {
  const gateway = new ToolGateway({ traceStore });
  gateway.register({
    name: 'Write',
    description: 'write file',
    risk: 'write',
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    execute: async () => ({ content: 'written', summary: 'wrote 20 bytes' })
  });
  gateway.register({
    name: 'Bash',
    description: 'run command',
    risk: 'execute',
    inputSchema: z.object({ command: z.string() }),
    execute: async () => ({
      content: 'tests passed',
      summary: 'exit=0, 1 line',
      data: { exitCode: 0 }
    })
  });
  return gateway;
}
