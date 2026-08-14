import { describe, expect, it } from 'vitest';

import { tryReadFramedMessage } from './jsonRpcStdio';

describe('tryReadFramedMessage', () => {
  it('parses a single Content-Length framed JSON message', () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    const frame = Buffer.from(
      `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`,
      'utf8'
    );
    const parsed = tryReadFramedMessage(frame);
    expect(parsed?.message).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { ok: true }
    });
    expect(parsed?.rest.length).toBe(0);
  });

  it('returns undefined until the full body arrives', () => {
    const body = '{"a":1}';
    const header = `Content-Length: ${body.length}\r\n\r\n`;
    const partial = Buffer.from(header + body.slice(0, 3), 'utf8');
    expect(tryReadFramedMessage(partial)).toBeUndefined();

    const full = Buffer.from(header + body, 'utf8');
    const parsed = tryReadFramedMessage(full);
    expect(parsed?.message).toEqual({ a: 1 });
  });

  it('leaves trailing bytes for the next frame', () => {
    const body1 = '{"id":1}';
    const body2 = '{"id":2}';
    const frame1 = `Content-Length: ${body1.length}\r\n\r\n${body1}`;
    const frame2 = `Content-Length: ${body2.length}\r\n\r\n${body2}`;
    const buffer = Buffer.from(frame1 + frame2, 'utf8');
    const first = tryReadFramedMessage(buffer);
    expect(first?.message).toEqual({ id: 1 });
    const second = tryReadFramedMessage(first!.rest);
    expect(second?.message).toEqual({ id: 2 });
  });
});
