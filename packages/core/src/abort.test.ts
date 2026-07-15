import { describe, expect, it } from 'vitest';

import {
  OperationAbortedError,
  abortReason,
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
