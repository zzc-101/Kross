import { describe, expect, it } from 'vitest';

import { parseSse } from './eventStream';

describe('parseSse', () => {
  it('parses split frames, comments and multi-line data', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(': heartbeat\n\nid: cursor-1\ndata: {"a":'));
        controller.enqueue(encoder.encode('1}\n\ndata: first\ndata: second\n\n'));
        controller.close();
      }
    });
    const messages = [];
    for await (const message of parseSse(stream)) messages.push(message);
    expect(messages).toEqual([
      { id: 'cursor-1', data: '{"a":1}' },
      { data: 'first\nsecond' }
    ]);
  });
});
