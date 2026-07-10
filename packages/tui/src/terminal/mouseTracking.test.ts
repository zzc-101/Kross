import { describe, expect, it, vi } from 'vitest';

import {
  filterMouseSequences,
  parseMouseWheelChunk,
  stripMouseArtifactsFromInput,
  installMouseInputFilter,
  uninstallMouseInputFilter,
  subscribeWheel
} from './mouseTracking';
import { EventEmitter } from 'node:events';

describe('parseMouseWheelChunk / filterMouseSequences', () => {
  it('parses SGR wheel up/down', () => {
    const up = parseMouseWheelChunk('\x1b[<64;10;5M');
    expect(up.events).toEqual([
      { direction: 'up', steps: 1, col: 10, row: 5 }
    ]);
    expect(up.rest).toBe('');

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

  it('strips non-wheel SGR mouse reports (e.g. button 98) without leaking', () => {
    // 用户报告的乱码来源：1015/兼容模式下的 ESC[98;60;21M
    const { events, rest, carry } = filterMouseSequences(
      'hello\x1b[98;60;21Mworld\x1b[<0;1;1M!'
    );
    expect(events).toEqual([]);
    expect(rest).toBe('helloworld!');
    expect(carry).toBe('');
  });

  it('strips SGR click/drag and keeps surrounding keystrokes', () => {
    const { rest, events, clicks } = filterMouseSequences(
      'ab\x1b[<0;12;8M\x1b[<32;12;9M\x1b[<3;12;9mcd'
    );
    expect(events).toEqual([]);
    // left press becomes a click event (still stripped from stdin rest)
    expect(clicks).toEqual([{ col: 12, row: 8 }]);
    expect(rest).toBe('abcd');
  });

  it('carries incomplete mouse CSI across chunks', () => {
    const first = filterMouseSequences('x\x1b[<64;1');
    expect(first.rest).toBe('x');
    expect(first.events).toEqual([]);
    expect(first.carry).toBe('\x1b[<64;1');

    const second = filterMouseSequences(first.carry + ';2Myz');
    expect(second.events[0]?.direction).toBe('up');
    expect(second.rest).toBe('yz');
    expect(second.carry).toBe('');
  });

  it('does not treat SGR color codes without < as mouse', () => {
    // ESC[0;31;40m 是颜色，不是鼠标
    const { rest, events } = filterMouseSequences('\x1b[0;31;40mred');
    expect(events).toEqual([]);
    expect(rest).toBe('\x1b[0;31;40mred');
  });
});

describe('stripMouseArtifactsFromInput', () => {
  it('removes leaked residues after ESC was consumed', () => {
    expect(stripMouseArtifactsFromInput('hi[98;60;21Mthere')).toBe('hithere');
    expect(stripMouseArtifactsFromInput('x[<64;1;1My')).toBe('xy');
    expect(stripMouseArtifactsFromInput('normal text')).toBe('normal text');
  });
});

describe('installMouseInputFilter', () => {
  it('filters mouse CSI before downstream data listeners and emits wheel', () => {
    const stdin = new EventEmitter() as EventEmitter & {
      emit: (event: string | symbol, ...args: unknown[]) => boolean;
    };
    // minimal ReadStream-like
    const received: string[] = [];
    const wheels: string[] = [];

    installMouseInputFilter(stdin as unknown as NodeJS.ReadStream);
    const unsub = subscribeWheel((e) => wheels.push(e.direction));
    stdin.on('data', (chunk: Buffer | string) => {
      received.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });

    stdin.emit('data', Buffer.from('a\x1b[<64;2;3Mb\x1b[98;1;1Mc', 'utf8'));

    expect(wheels).toEqual(['up']);
    expect(received.join('')).toBe('abc');

    unsub();
    uninstallMouseInputFilter();
  });

  it('swallows pure mouse chunks so Ink sees nothing', () => {
    const stdin = new EventEmitter() as EventEmitter & {
      emit: (event: string | symbol, ...args: unknown[]) => boolean;
    };
    const spy = vi.fn();
    installMouseInputFilter(stdin as unknown as NodeJS.ReadStream);
    stdin.on('data', spy);

    stdin.emit('data', Buffer.from('\x1b[<65;1;1M\x1b[98;60;21M', 'utf8'));
    expect(spy).not.toHaveBeenCalled();

    uninstallMouseInputFilter();
  });
});
