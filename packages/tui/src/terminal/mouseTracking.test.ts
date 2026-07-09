import { describe, expect, it } from 'vitest';

import { parseMouseWheelChunk } from './mouseTracking';

describe('parseMouseWheelChunk', () => {
  it('parses SGR wheel up/down', () => {
    const up = parseMouseWheelChunk('\x1b[<64;10;5M');
    expect(up.events).toEqual([
      { direction: 'up', steps: 1, col: 10, row: 5 }
    ]);

    const down = parseMouseWheelChunk('\x1b[<65;3;8M');
    expect(down.events[0]?.direction).toBe('down');
  });

  it('parses multiple wheel events in one chunk', () => {
    const { events } = parseMouseWheelChunk(
      '\x1b[<64;1;1M\x1b[<64;1;1M\x1b[<65;1;1M'
    );
    expect(events.map((e) => e.direction)).toEqual(['up', 'up', 'down']);
  });

  it('parses legacy X10 wheel encoding', () => {
    // button 64 → char 96 '`'; col 1 → '!', row 1 → '!'
    const chunk = `\x1b[M${String.fromCharCode(32 + 64)}${String.fromCharCode(33)}${String.fromCharCode(33)}`;
    const { events } = parseMouseWheelChunk(chunk);
    expect(events[0]?.direction).toBe('up');
  });
});
