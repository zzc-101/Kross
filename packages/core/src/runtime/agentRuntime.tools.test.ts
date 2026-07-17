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

describe('AgentRuntime tool loops and approvals', () => {
  it('executes model tool calls and asks the LLM for a final answer with tool output', async () => {
      const traceStore = new InMemoryTraceStore();
      const llmClient = new ToolCallingLlmClient();
      const toolGateway = new ToolGateway({ traceStore });
      toolGateway.register({
        name: 'math.add',
        description: '加法',
        risk: 'read',
        parameters: {
          type: 'object',
          properties: {
            a: { type: 'number' },
            b: { type: 'number' }
          },
          required: ['a', 'b']
        },
        inputSchema: z.object({ a: z.number(), b: z.number() }),
        execute: async ({ input }) => ({
          content: String(input.a + input.b),
          summary: `${input.a} + ${input.b} = ${input.a + input.b}`
        })
      });
      const runtime = new AgentRuntime({
        traceStore,
        llmClient,
        contextManager: new InMemoryContextManager(),
        toolGateway
      });

      const result = await runtime.run({
        input: '计算 1 + 2',
        requestedMode: 'auto'
      });

      expect(result.summary).toBe('结果是 3');
      expect(llmClient.requests[0]?.tools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'math.add',
            parameters: expect.objectContaining({ type: 'object' })
          }),
          expect.objectContaining({ name: 'SetMode' })
        ])
      );
      expect(llmClient.requests[1]?.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'tool',
            toolCallId: 'call-1',
            name: 'math.add',
            content: '3'
          })
        ])
      );
      expect(traceStore.events.map((event) => event.type)).toEqual(
        expect.arrayContaining([
          'llm.tool_calls.received',
          'tool_call.started',
          'tool_call.completed',
          'llm.tool_followup.completed'
        ])
      );
    });

  it('continues tool-call iterations until the model returns a final text answer', async () => {
      const traceStore = new InMemoryTraceStore();
      const llmClient = new MultiStepToolCallingLlmClient();
      const toolGateway = new ToolGateway({ traceStore });
      toolGateway.register({
        name: 'math.add',
        description: '加法',
        risk: 'read',
        parameters: { type: 'object', properties: {} },
        inputSchema: z.object({ a: z.number(), b: z.number() }),
        execute: async ({ input }) => ({ content: String(input.a + input.b) })
      });
      toolGateway.register({
        name: 'math.double',
        description: '翻倍',
        risk: 'read',
        parameters: { type: 'object', properties: {} },
        inputSchema: z.object({ value: z.number() }),
        execute: async ({ input }) => ({ content: String(input.value * 2) })
      });
      const runtime = new AgentRuntime({
        traceStore,
        llmClient,
        contextManager: new InMemoryContextManager(),
        toolGateway
      });

      const result = await runtime.run({
        input: '先算 1+2 再翻倍',
        requestedMode: 'auto'
      });

      expect(result.summary).toBe('最终结果是 6');
      expect(llmClient.requests).toHaveLength(3);
      expect(llmClient.requests[2]?.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'tool',
            toolCallId: 'call-2',
            name: 'math.double',
            content: '6'
          })
        ])
      );
    });

  it('soft-lands when non-streaming tool-call iterations exceed the limit', async () => {
      const traceStore = new InMemoryTraceStore();
      const llmClient = new LoopingToolCallingLlmClient();
      const toolGateway = new ToolGateway({ traceStore });
      toolGateway.register({
        name: 'fs.read',
        description: '读文件',
        risk: 'read',
        inputSchema: z.object({ path: z.string() }),
        execute: async () => ({ content: 'file content' })
      });
      const runtime = new AgentRuntime({
        traceStore,
        llmClient,
        toolGateway,
        maxToolIterations: 1
      });

      const result = await runtime.run({
        input: '一直读',
        requestedMode: 'auto'
      });

      // 触顶不再 failed，而是软着陆为 completed 总结
      expect(result.status).toBe('completed');
      expect(result.summary).toMatch(/收尾|上限|停止/);
      expect(traceStore.events.map((event) => event.type)).toEqual(
        expect.arrayContaining([
          'llm.tool_loop.max_iterations',
          'llm.soft_land.completed'
        ])
      );
      expect(
        traceStore.events.some(
          (event) =>
            event.type === 'llm.tool_loop.max_iterations' &&
            event.payload.softLand === true
        )
      ).toBe(true);
    });

  it('pauses for approval on risky tool calls and resumes when approved', async () => {
      const traceStore = new InMemoryTraceStore();
      const llmClient = new WriteToolCallingLlmClient();
      const toolGateway = new ToolGateway({ traceStore });
      toolGateway.register({
        name: 'fs.write',
        description: '写文件',
        risk: 'write',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            content: { type: 'string' }
          },
          required: ['path', 'content']
        },
        inputSchema: z.object({ path: z.string(), content: z.string() }),
        execute: async ({ input }) => ({
          content: `wrote ${input.path}`,
          summary: `wrote ${input.path}`
        })
      });
      const runtime = new AgentRuntime({
        traceStore,
        llmClient,
        contextManager: new InMemoryContextManager(),
        toolGateway
      });

      const pending = await runtime.run({
        input: '写 README',
        requestedMode: 'auto'
      });

      expect(pending.status).toBe('approval-required');
      expect(pending.pendingApproval).toMatchObject({
        runId: pending.runId,
        toolCallId: 'write-1',
        toolName: 'fs.write',
        risk: 'write'
      });
      expect(llmClient.requests).toHaveLength(1);

      const resumed = await runtime.resolveToolApproval({
        runId: pending.runId,
        approved: true
      });

      expect(resumed.status).toBe('completed');
      expect(resumed.summary).toBe('写入完成');
      expect(llmClient.requests).toHaveLength(2);
      expect(
        llmClient.requests[1]?.messages.find(
          (message) => message.role === 'system'
        )?.content
      ).toContain('Auto 模式：');
      expect(traceStore.events.map((event) => event.type)).toEqual(
        expect.arrayContaining([
          'tool_call.approval_required',
          'tool_call.started',
          'tool_call.completed',
          'llm.tool_followup.completed'
        ])
      );
    });

  it('resumes with a rejected observation when risky tool approval is denied', async () => {
      const traceStore = new InMemoryTraceStore();
      const llmClient = new WriteToolCallingLlmClient('已取消写入');
      const toolGateway = new ToolGateway({ traceStore });
      toolGateway.register({
        name: 'fs.write',
        description: '写文件',
        risk: 'write',
        inputSchema: z.object({ path: z.string(), content: z.string() }),
        redactInputForTrace: (input) => {
          const value = input as { path: string; content: string };
          return { path: value.path, contentBytes: Buffer.byteLength(value.content) };
        },
        execute: async () => ({ content: 'should not run' })
      });
      const runtime = new AgentRuntime({
        traceStore,
        llmClient,
        contextManager: new InMemoryContextManager(),
        toolGateway
      });

      const pending = await runtime.run({
        input: '写 README',
        requestedMode: 'auto'
      });
      const resumed = await runtime.resolveToolApproval({
        runId: pending.runId,
        approved: false
      });

      expect(resumed.status).toBe('completed');
      expect(resumed.summary).toBe('已取消写入');
      expect(llmClient.requests[1]?.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'tool',
            toolCallId: 'write-1',
            name: 'fs.write',
            content: expect.stringContaining('rejected by user')
          })
        ])
      );
      expect(traceStore.events.map((event) => event.type)).toContain(
        'tool_call.rejected'
      );
      const rejection = traceStore.events.find(
        (event) => event.type === 'tool_call.rejected'
      );
      expect(rejection?.payload.input).toEqual({
        path: 'README.md',
        contentBytes: 5
      });
      expect(JSON.stringify(rejection)).not.toContain('hello');
    });

  it('pauses for approval when a risky tool call appears in later iterations', async () => {
      const traceStore = new InMemoryTraceStore();
      const llmClient = new ReadThenWriteToolCallingLlmClient();
      const toolGateway = new ToolGateway({ traceStore });
      toolGateway.register({
        name: 'fs.read',
        description: '读文件',
        risk: 'read',
        inputSchema: z.object({ path: z.string() }),
        execute: async () => ({ content: 'file content' })
      });
      toolGateway.register({
        name: 'fs.write',
        description: '写文件',
        risk: 'write',
        inputSchema: z.object({ path: z.string(), content: z.string() }),
        execute: async ({ input }) => ({ content: `wrote ${input.path}` })
      });
      const runtime = new AgentRuntime({
        traceStore,
        llmClient,
        contextManager: new InMemoryContextManager(),
        toolGateway
      });

      const pending = await runtime.run({
        input: '读取后改写 README',
        requestedMode: 'auto'
      });

      expect(pending.status).toBe('approval-required');
      expect(pending.pendingApproval?.toolCallId).toBe('write-1');
      expect(pending.summary).toContain('fs.write');

      const resumed = await runtime.resolveToolApproval({
        runId: pending.runId,
        approved: true
      });

      expect(resumed.status).toBe('completed');
      expect(resumed.summary).toBe('改写完成');
    });

  it('resumes parallel tool calls with every tool result backfilled in order', async () => {
      const traceStore = new InMemoryTraceStore();
      const llmClient = new ParallelToolCallingLlmClient();
      const toolGateway = new ToolGateway({ traceStore });
      toolGateway.register({
        name: 'fs.read',
        description: '读文件',
        risk: 'read',
        inputSchema: z.object({ path: z.string() }),
        execute: async () => ({ content: 'file content' })
      });
      toolGateway.register({
        name: 'fs.write',
        description: '写文件',
        risk: 'write',
        inputSchema: z.object({ path: z.string(), content: z.string() }),
        execute: async ({ input }) => ({ content: `wrote ${input.path}` })
      });
      const runtime = new AgentRuntime({
        traceStore,
        llmClient,
        contextManager: new InMemoryContextManager(),
        toolGateway
      });

      const pending = await runtime.run({
        input: '读并写 README',
        requestedMode: 'auto'
      });

      expect(pending.status).toBe('approval-required');
      expect(pending.pendingApproval?.toolCallId).toBe('write-1');

      const resumed = await runtime.resolveToolApproval({
        runId: pending.runId,
        approved: true
      });

      expect(resumed.status).toBe('completed');
      const followupMessages = llmClient.requests[1]?.messages ?? [];
      expect(followupMessages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'assistant',
            toolCalls: [
              expect.objectContaining({ id: 'read-1' }),
              expect.objectContaining({ id: 'write-1' })
            ]
          }),
          expect.objectContaining({
            role: 'tool',
            toolCallId: 'read-1',
            content: 'file content'
          }),
          expect.objectContaining({
            role: 'tool',
            toolCallId: 'write-1',
            content: 'wrote README.md'
          })
        ])
      );
      const toolCallIds = followupMessages.flatMap((message) =>
        message.role === 'tool' ? [message.toolCallId] : []
      );
      expect(toolCallIds).toEqual(['read-1', 'write-1']);
    });

  it('streams follow-up text after tool approval instead of dumping complete()', async () => {
      const traceStore = new InMemoryTraceStore();
      const llmClient = new WriteToolCallingLlmClient('写入完成');
      const toolGateway = new ToolGateway({ traceStore });
      toolGateway.register({
        name: 'fs.write',
        description: '写文件',
        risk: 'write',
        inputSchema: z.object({ path: z.string(), content: z.string() }),
        execute: async ({ input }) => ({ content: `wrote ${input.path}` })
      });
      const runtime = new AgentRuntime({
        traceStore,
        llmClient,
        toolGateway
      });

      const first = await runtime.run({
        input: '写 README',
        requestedMode: 'auto'
      });
      expect(first.status).toBe('approval-required');

      const events = [];
      for await (const event of runtime.resolveToolApprovalStreaming({
        runId: first.runId,
        approved: true
      })) {
        events.push(event);
      }

      const textDeltas = events
        .filter((event) => event.type === 'text-delta')
        .map((event) => (event.type === 'text-delta' ? event.text : ''));
      expect(textDeltas.length).toBeGreaterThan(0);
      expect(textDeltas.join('')).toBe('写入完成');
      expect(events.at(-1)).toEqual({
        type: 'result',
        result: expect.objectContaining({
          status: 'completed',
          summary: '写入完成'
        })
      });
    });

  it('appends the original user input after tool approval instead of a pseudo message', async () => {
      const traceStore = new InMemoryTraceStore();
      const llmClient = new WriteToolCallingLlmClient('写入完成');
      const contextManager = new InMemoryContextManager();
      const toolGateway = new ToolGateway({ traceStore });
      toolGateway.register({
        name: 'fs.write',
        description: '写文件',
        risk: 'write',
        inputSchema: z.object({ path: z.string(), content: z.string() }),
        execute: async ({ input }) => ({ content: `wrote ${input.path}` })
      });
      const runtime = new AgentRuntime({
        traceStore,
        llmClient,
        contextManager,
        toolGateway
      });

      const pending = await runtime.run({
        input: '写 README',
        requestedMode: 'auto'
      });
      expect(pending.status).toBe('approval-required');
      expect(getStoredConversation(contextManager)).toHaveLength(0);

      const resumed = await runtime.resolveToolApproval({
        runId: pending.runId,
        approved: true
      });
      expect(resumed.status).toBe('completed');

      const history = getStoredConversation(contextManager);
      expect(history).toEqual([
        { role: 'user', content: '写 README' },
        { role: 'assistant', content: '写入完成' }
      ]);
      expect(
        history.some(
          (message) =>
            message.role === 'user' && message.content === '[tool approval]'
        )
      ).toBe(false);
    });

  it('carries the same original user input through chained tool approvals', async () => {
      const traceStore = new InMemoryTraceStore();
      const llmClient = new DoubleWriteApprovalLlmClient();
      const contextManager = new InMemoryContextManager();
      const toolGateway = new ToolGateway({ traceStore });
      toolGateway.register({
        name: 'fs.write',
        description: '写文件',
        risk: 'write',
        inputSchema: z.object({ path: z.string(), content: z.string() }),
        execute: async ({ input }) => ({ content: `wrote ${input.path}` })
      });
      const runtime = new AgentRuntime({
        traceStore,
        llmClient,
        contextManager,
        toolGateway
      });

      const firstPending = await runtime.run({
        input: '连续写两个文件',
        requestedMode: 'auto'
      });
      expect(firstPending.status).toBe('approval-required');

      const secondPending = await runtime.resolveToolApproval({
        runId: firstPending.runId,
        approved: true
      });
      expect(secondPending.status).toBe('approval-required');

      const completed = await runtime.resolveToolApproval({
        runId: secondPending.runId,
        approved: true
      });
      expect(completed.status).toBe('completed');

      const history = getStoredConversation(contextManager);
      expect(history).toEqual([
        { role: 'user', content: '连续写两个文件' },
        { role: 'assistant', content: '两次写入完成' }
      ]);
    });

  it('cancelPendingApprovals records cancelled runs and appends conversation', async () => {
      const traceStore = new InMemoryTraceStore();
      const llmClient = new WriteToolCallingLlmClient();
      const contextManager = new InMemoryContextManager();
      const toolGateway = new ToolGateway({ traceStore });
      toolGateway.register({
        name: 'fs.write',
        description: '写文件',
        risk: 'write',
        inputSchema: z.object({ path: z.string(), content: z.string() }),
        execute: async () => ({ content: 'should not run' })
      });
      const runtime = new AgentRuntime({
        traceStore,
        llmClient,
        contextManager,
        toolGateway
      });

      const pending = await runtime.run({
        input: '写 README',
        requestedMode: 'auto'
      });
      expect(pending.status).toBe('approval-required');

      const cancelledRunIds = await runtime.cancelPendingApprovals('process exit');
      expect(cancelledRunIds).toEqual([pending.runId]);

      const completed = traceStore.events.find(
        (event) =>
          event.runId === pending.runId && event.type === 'run.completed'
      );
      expect(completed?.payload).toMatchObject({
        status: 'cancelled',
        reason: 'process exit'
      });
      expect(String(completed?.payload.summary)).toContain('process exit');

      expect(getStoredConversation(contextManager)).toEqual([
        { role: 'user', content: '写 README' },
        {
          role: 'assistant',
          content: expect.stringContaining('process exit')
        }
      ]);
    });

  it('streams text deltas across tool-call iterations', async () => {
      const traceStore = new InMemoryTraceStore();
      const llmClient = new StreamingToolCallingLlmClient();
      const toolGateway = new ToolGateway({ traceStore });
      toolGateway.register({
        name: 'fs.read',
        description: '读文件',
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

      const events = [];
      for await (const event of runtime.runStreaming({
        input: '查看 README',
        requestedMode: 'auto'
      })) {
        events.push(event);
      }

      const textDeltas = events
        .filter((event) => event.type === 'text-delta')
        .map((event) => (event.type === 'text-delta' ? event.text : ''));
      // 多轮 text-delta 不再注入分隔符（UI 按 turn-start 分气泡）；summary 仍拼接历史
      expect(textDeltas).toEqual(['让我查一下', '文件内容已读取']);
      expect(events.filter((event) => event.type === 'turn-start')).toHaveLength(2);
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'tools-start', count: 1 })
      );
      expect(events.at(-1)).toEqual({
        type: 'result',
        result: expect.objectContaining({
          status: 'completed',
          summary: '让我查一下\n\n文件内容已读取'
        })
      });
      expect(llmClient.streamRequests[1]?.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'tool',
            toolCallId: 'read-1',
            content: 'file content'
          })
        ])
      );
      expect(traceStore.events.map((event) => event.type)).toEqual(
        expect.arrayContaining([
          'llm.tool_calls.received',
          'tool_call.completed',
          'llm.tool_followup.completed'
        ])
      );
    });

  it('soft-lands when streaming tool-call iterations exceed the limit', async () => {
      const traceStore = new InMemoryTraceStore();
      const llmClient = new LoopingStreamingToolClient();
      const toolGateway = new ToolGateway({ traceStore });
      toolGateway.register({
        name: 'fs.read',
        description: '读文件',
        risk: 'read',
        inputSchema: z.object({ path: z.string() }),
        execute: async () => ({ content: 'file content' })
      });
      const runtime = new AgentRuntime({
        traceStore,
        llmClient,
        toolGateway,
        maxToolIterations: 1
      });
      const events = [];

      for await (const event of runtime.runStreaming({
        input: '一直读',
        requestedMode: 'auto'
      })) {
        events.push(event);
      }

      expect(events.at(-1)).toEqual({
        type: 'result',
        result: expect.objectContaining({
          status: 'completed',
          summary: expect.stringMatching(/收尾|上限|停止/)
        })
      });
      expect(traceStore.events.map((event) => event.type)).toEqual(
        expect.arrayContaining([
          'llm.tool_loop.max_iterations',
          'llm.soft_land.completed'
        ])
      );
    });
});
