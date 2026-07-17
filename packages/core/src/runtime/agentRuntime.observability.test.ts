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
});
