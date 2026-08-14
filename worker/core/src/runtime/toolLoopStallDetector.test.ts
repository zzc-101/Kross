import { describe, expect, it } from 'vitest';

import type { LlmMessage, LlmToolCall } from '../llm/types';
import { ToolLoopStallDetector } from './toolLoopStallDetector';

function call(input: unknown = { path: 'README.md' }): LlmToolCall[] {
  return [{ id: crypto.randomUUID(), name: 'Read', input }];
}

function result(content = 'same content'): LlmMessage[] {
  return [
    {
      role: 'tool',
      toolCallId: crypto.randomUUID(),
      name: 'Read',
      content
    }
  ];
}

describe('ToolLoopStallDetector', () => {
  it('allows one recovery before declaring an unchanged loop stalled', () => {
    const detector = new ToolLoopStallDetector();

    expect(detector.observe({ calls: call(), results: result() }).state).toBe(
      'progress'
    );
    expect(detector.observe({ calls: call(), results: result() }).state).toBe(
      'repeated'
    );
    expect(detector.observe({ calls: call(), results: result() })).toMatchObject({
      state: 'recover',
      repeatedCount: 2,
      signaturePreview: 'Read'
    });
    expect(detector.observe({ calls: call(), results: result() })).toMatchObject({
      state: 'stalled',
      repeatedCount: 3
    });
  });

  it('treats changed parameters and changed results as progress', () => {
    const detector = new ToolLoopStallDetector({ repeatThreshold: 1 });

    detector.observe({ calls: call(), results: result('pending') });
    expect(
      detector.observe({
        calls: call({ path: 'README.md', offset: 100 }),
        results: result('pending')
      }).state
    ).toBe('progress');
    expect(
      detector.observe({
        calls: call({ path: 'README.md', offset: 100 }),
        results: result('completed')
      }).state
    ).toBe('progress');
  });

  it('normalizes object key order and ignores generated call/result ids', () => {
    const detector = new ToolLoopStallDetector({ repeatThreshold: 1 });

    detector.observe({
      calls: call({ path: 'README.md', offset: 10 }),
      results: result()
    });
    expect(
      detector.observe({
        calls: call({ offset: 10, path: 'README.md' }),
        results: result()
      }).state
    ).toBe('recover');
  });

  it('resets the recovery allowance after genuine progress', () => {
    const detector = new ToolLoopStallDetector({ repeatThreshold: 1 });

    detector.observe({ calls: call(), results: result('a') });
    expect(detector.observe({ calls: call(), results: result('a') }).state).toBe(
      'recover'
    );
    expect(detector.observe({ calls: call(), results: result('b') }).state).toBe(
      'progress'
    );
    expect(detector.observe({ calls: call(), results: result('b') }).state).toBe(
      'recover'
    );
  });
});
