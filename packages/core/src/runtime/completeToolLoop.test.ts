import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createSessionContext } from '../context/sessionContext';
import type { LlmClient, LlmRequest, LlmResponse, LlmStreamChunk } from '../llm/types';
import { renderPrompt } from '../prompts';
import {
  ToolGateway,
  type ToolDefinition,
  type ToolMetadata
} from '../tools/toolGateway';
import { runCompleteToolLoop } from './completeToolLoop';

function createNoopTool(): ToolDefinition<{ note?: string }> {
  return {
    name: 'Noop',
    description: 'No-op tool for tests',
    risk: 'read',
    category: 'test',
    inputSchema: z.object({
      note: z.string().optional()
    }),
    parameters: {
      type: 'object',
      properties: {
        note: { type: 'string' }
      }
    },
    async execute() {
      return { content: 'noop-ok', summary: 'noop' };
    }
  };
}

function createGatewayWithNoop(): {
  gateway: ToolGateway;
  tools: ToolMetadata[];
} {
  const gateway = new ToolGateway({
    approvalPolicy: () => ({ action: 'allow' })
  });
  const tool = createNoopTool();
  gateway.register(tool);
  return {
    gateway,
    tools: [
      {
        name: tool.name,
        description: tool.description,
        risk: tool.risk,
        category: tool.category,
        parameters: tool.parameters
      }
    ]
  };
}

class SequenceLlmClient implements LlmClient {
  readonly provider = 'openai' as const;
  readonly requests: LlmRequest[] = [];
  private index = 0;

  constructor(private readonly responses: LlmResponse[]) {}

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    const response = this.responses[this.index] ?? this.responses.at(-1);
    this.index += 1;
    if (!response) {
      throw new Error('SequenceLlmClient: no scripted responses');
    }
    return response;
  }

  async *stream(_request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    yield { type: 'done' };
  }
}

function textResponse(text: string): LlmResponse {
  return {
    provider: 'openai',
    model: 'fake',
    text,
    raw: {}
  };
}

function toolCallResponse(
  calls: Array<{ id: string; name: string; input: unknown }>,
  text = ''
): LlmResponse {
  return {
    provider: 'openai',
    model: 'fake',
    text,
    raw: {},
    toolCalls: calls
  };
}

describe('runCompleteToolLoop', () => {
  it('returns assistant text when there are no tool calls', async () => {
    const { gateway, tools } = createGatewayWithNoop();
    const llm = new SequenceLlmClient([
      textResponse('All done. Findings: none.')
    ]);
    const sessionContext = createSessionContext({ client: llm });

    const summary = await runCompleteToolLoop({
      runId: 'complete-1',
      prompt: 'do a quick check',
      systemPrompt: 'You are a test subagent.',
      llmClient: llm,
      gateway,
      tools,
      sessionContext,
      maxIterations: 5
    });

    expect(summary).toBe('All done. Findings: none.');
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]?.temperature).toBe(0.2);
    expect(llm.requests[0]?.metadata?.purpose).toBe('subagent');
    expect(llm.requests[0]?.tools?.some((t) => t.name === 'Noop')).toBe(true);
  });

  it('soft-lands when max iterations is hit with continuous tool calls', async () => {
    const { gateway, tools } = createGatewayWithNoop();
    const llm = new SequenceLlmClient([
      toolCallResponse([
        { id: 'c1', name: 'Noop', input: { note: 'a' } }
      ]),
      toolCallResponse([
        { id: 'c2', name: 'Noop', input: { note: 'b' } }
      ]),
      // soft-land complete (no tools)
      textResponse('Soft land summary for parent.')
    ]);
    const sessionContext = createSessionContext({ client: llm });

    const summary = await runCompleteToolLoop({
      runId: 'complete-max',
      prompt: 'keep calling tools',
      systemPrompt: 'You are a test subagent.',
      llmClient: llm,
      gateway,
      tools,
      sessionContext,
      maxIterations: 2
    });

    expect(summary).toBe('Soft land summary for parent.');
    // 2 loop iterations + 1 soft-land
    expect(llm.requests).toHaveLength(3);
    const soft = llm.requests[2];
    expect(soft?.tools).toBeUndefined();
    expect(soft?.metadata?.purpose).toBe('subagent-soft-land');
    const softUser = soft?.messages.filter((m) => m.role === 'user').at(-1);
    expect(softUser?.content).toBe(renderPrompt('subagent.softLand.user'));
  });

  it('stops on repeated identical tool signatures (stall)', async () => {
    const { gateway, tools } = createGatewayWithNoop();
    // same signature three turns → stall on third (count >= 2)
    const sameCall = { id: 'c-same', name: 'Noop', input: { note: 'loop' } };
    const llm = new SequenceLlmClient([
      toolCallResponse([{ ...sameCall, id: 'c1' }], ''),
      toolCallResponse([{ ...sameCall, id: 'c2' }], ''),
      toolCallResponse([{ ...sameCall, id: 'c3' }], '')
    ]);
    const sessionContext = createSessionContext({ client: llm });
    const stalled: Array<{ iteration: number; signaturePreview: string }> = [];

    const summary = await runCompleteToolLoop({
      runId: 'complete-stall',
      prompt: 'repeat forever',
      systemPrompt: 'You are a test subagent.',
      llmClient: llm,
      gateway,
      tools,
      sessionContext,
      maxIterations: 20,
      onStalled: async (info) => {
        stalled.push(info);
      }
    });

    expect(summary).toBe(renderPrompt('subagent.summary.stalled'));
    expect(llm.requests.length).toBe(3);
    expect(stalled).toHaveLength(1);
    expect(stalled[0]?.iteration).toBe(3);
    expect(stalled[0]?.signaturePreview).toContain('Noop');
  });
});
