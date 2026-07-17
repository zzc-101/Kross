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

describe('isCasualChatInput', () => {
  it('recognizes greetings and rejects real tasks', () => {
    expect(isCasualChatInput('你好')).toBe(true);
    expect(isCasualChatInput('hello!')).toBe(true);
    expect(isCasualChatInput('修复登录 bug')).toBe(false);
    expect(isCasualChatInput('先规划再实现认证')).toBe(false);
  });
});

describe('chunkTextForStream', () => {
  it('splits long text while preserving short text', () => {
    expect(chunkTextForStream('abcdefgh', 3)).toEqual([
      'abc',
      'def',
      'gh'
    ]);
    expect(chunkTextForStream('short', 64)).toEqual(['short']);
  });
});

describe('parsePlanIntentKind', () => {
  it('parses chat and plan kind from JSON', () => {
    expect(
      parsePlanIntentKind('{"kind":"chat","reason":"greeting"}')
    ).toEqual({ kind: 'chat', reason: 'greeting' });
    expect(
      parsePlanIntentKind('```json\n{"kind":"plan","reason":"task"}\n```')
    ).toEqual({ kind: 'plan', reason: 'task' });
  });
});
