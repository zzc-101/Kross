import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createScrollScheduler } from './scrollSchedule';

describe('createScrollScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces multiple enqueues into one flush', () => {
    const onFlush = vi.fn();
    const scheduler = createScrollScheduler(onFlush);

    scheduler.enqueue(3);
    scheduler.enqueue(2);
    scheduler.enqueue(-1);
    expect(onFlush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(20);
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith(4);
  });

  it('drains a large trackpad burst through intermediate frames', () => {
    const deltas: number[] = [];
    const scheduler = createScrollScheduler((delta) => deltas.push(delta));

    scheduler.enqueue(18);
    vi.advanceTimersByTime(20);

    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toBeGreaterThan(0);
    expect(deltas[0]).toBeLessThan(18);

    vi.advanceTimersByTime(200);
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.reduce((sum, delta) => sum + delta, 0)).toBe(18);
  });

  it('cancel drops pending delta', () => {
    const onFlush = vi.fn();
    const scheduler = createScrollScheduler(onFlush);
    scheduler.enqueue(5);
    scheduler.cancel();
    vi.advanceTimersByTime(20);
    expect(onFlush).not.toHaveBeenCalled();
  });

  it('ignores zero delta', () => {
    const onFlush = vi.fn();
    const scheduler = createScrollScheduler(onFlush);
    scheduler.enqueue(0);
    vi.advanceTimersByTime(20);
    expect(onFlush).not.toHaveBeenCalled();
  });
});
