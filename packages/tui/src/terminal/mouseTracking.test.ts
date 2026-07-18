import { describe, expect, it, vi } from 'vitest';

import {
  filterMouseSequences,
  stripMouseArtifactsFromInput,
  installMouseInputFilter,
  subscribeClick,
  subscribePointer,
  uninstallMouseInputFilter,
  subscribeWheel
} from './mouseTracking';
import { EventEmitter } from 'node:events';

describe('filterMouseSequences', () => {
  it('parses SGR wheel up/down', () => {
    const up = filterMouseSequences('\x1b[<64;10;5M');
    expect(up.events).toEqual([
      { direction: 'up', steps: 1, col: 10, row: 5 }
    ]);
    expect(up.rest).toBe('');

    const down = filterMouseSequences('\x1b[<65;3;8M');
    expect(down.events[0]?.direction).toBe('down');
  });

  it('parses multiple wheel events in one chunk', () => {
    const { events } = filterMouseSequences(
      '\x1b[<64;1;1M\x1b[<64;1;1M\x1b[<65;1;1M'
    );
    expect(events.map((e) => e.direction)).toEqual(['up', 'up', 'down']);
  });

  it('parses legacy X10 wheel encoding', () => {
    const chunk = `\x1b[M${String.fromCharCode(32 + 64)}${String.fromCharCode(33)}${String.fromCharCode(33)}`;
    const { events } = filterMouseSequences(chunk);
    expect(events[0]?.direction).toBe('up');
  });

  it('strips non-wheel SGR mouse reports without leaking', () => {
    const { events, rest, carry } = filterMouseSequences(
      'hello\x1b[98;60;21Mworld\x1b[<0;1;1M!'
    );
    expect(events).toEqual([]);
    expect(rest).toBe('helloworld!');
    expect(carry).toBe('');
  });

  it('emits left-button down/drag/up and strips them from stdin rest', () => {
    const { rest, events, pointers } = filterMouseSequences(
      'ab\x1b[<0;12;8M\x1b[<32;12;9M\x1b[<0;12;9mcd'
    );
    expect(events).toEqual([]);
    expect(pointers).toEqual([
      { phase: 'down', col: 12, row: 8 },
      { phase: 'drag', col: 12, row: 9 },
      { phase: 'up', col: 12, row: 9 }
    ]);
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
    const dataListener = vi.fn();
    stdin.on('data', dataListener);

    const wheels: Array<{ direction: string }> = [];
    const unsub = subscribeWheel((e) => wheels.push(e));
    installMouseInputFilter(stdin as unknown as NodeJS.ReadStream);

    stdin.emit('data', 'hi\x1b[<64;2;3Mthere');
    expect(dataListener).toHaveBeenCalled();
    const payloads = dataListener.mock.calls.map((c) => String(c[0]));
    expect(payloads.join('')).toContain('hi');
    expect(payloads.join('')).toContain('there');
    expect(payloads.join('')).not.toContain('64');
    expect(wheels.some((w) => w.direction === 'up')).toBe(true);

    unsub();
    uninstallMouseInputFilter();
  });

  it('dispatches a click only after a non-drag mouse release', () => {
    const stdin = new EventEmitter() as EventEmitter & {
      emit: (event: string | symbol, ...args: unknown[]) => boolean;
    };
    const pointers: string[] = [];
    const clicks: Array<{ col: number; row: number }> = [];
    const unsubPointer = subscribePointer((event) => pointers.push(event.phase));
    const unsubClick = subscribeClick((event) => clicks.push(event));
    installMouseInputFilter(stdin as unknown as NodeJS.ReadStream);

    stdin.emit('data', '\x1b[<0;4;5M\x1b[<0;4;5m');
    expect(pointers).toEqual(['down', 'up']);
    expect(clicks).toEqual([{ col: 4, row: 5 }]);

    stdin.emit(
      'data',
      '\x1b[<0;8;9M\x1b[<32;9;9M\x1b[<0;9;9m'
    );
    expect(pointers.slice(-3)).toEqual(['down', 'drag', 'up']);
    expect(clicks).toHaveLength(1);

    unsubPointer();
    unsubClick();
    uninstallMouseInputFilter();
  });
});
