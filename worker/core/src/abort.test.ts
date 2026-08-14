import { describe, expect, it } from 'vitest';

import {
  OperationAbortedError,
  abortReason,
  abortableAsyncIterable,
  isOperationAborted,
  raceAbort
} from './abort';

describe('raceAbort', () => {
  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('already'));
    await expect(
      raceAbort(new Promise(() => undefined), controller.signal)
    ).rejects.toThrow('already');
  });

  it('rejects a hanging promise when abort fires later', async () => {
    const controller = new AbortController();
    const hanging = new Promise<string>(() => undefined);
    const raced = raceAbort(hanging, controller.signal);
    queueMicrotask(() => controller.abort(new Error('用户按下 Esc')));
    await expect(raced).rejects.toThrow('用户按下 Esc');
  });

  it('resolves normally when the promise finishes first', async () => {
    const controller = new AbortController();
    await expect(
      raceAbort(Promise.resolve('ok'), controller.signal)
    ).resolves.toBe('ok');
  });

  it('rejects on idle timeout even without a signal', async () => {
    await expect(
      raceAbort(new Promise(() => undefined), undefined, {
        idleMs: 20,
        idleMessage: 'idle'
      })
    ).rejects.toThrow('idle');
  });
});

describe('abortableAsyncIterable', () => {
  it('stops yielding when abort fires between chunks', async () => {
    const controller = new AbortController();
    async function* source() {
      yield 1;
      await new Promise<void>(() => undefined); // hang
      yield 2;
    }

    const collected: number[] = [];
    const iter = abortableAsyncIterable(source(), controller.signal);
    const run = (async () => {
      for await (const value of iter) {
        collected.push(value);
        controller.abort(new Error('stop-iter'));
      }
    })();

    await expect(run).rejects.toThrow('stop-iter');
    expect(collected).toEqual([1]);
  });
});

describe('isOperationAborted', () => {
  it('treats signal.aborted as cancel even for wrapped errors', () => {
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    expect(isOperationAborted(new Error('wrapped'), controller.signal)).toBe(
      true
    );
  });

  it('recognizes OperationAbortedError / AbortError by name', () => {
    expect(isOperationAborted(new OperationAbortedError('x'))).toBe(true);
    const err = new Error('y');
    err.name = 'AbortError';
    expect(isOperationAborted(err)).toBe(true);
    expect(isOperationAborted(new Error('nope'))).toBe(false);
  });

  it('abortReason prefers signal.reason Error', () => {
    const controller = new AbortController();
    const reason = new Error('esc');
    controller.abort(reason);
    expect(abortReason(controller.signal)).toBe(reason);
  });
});
