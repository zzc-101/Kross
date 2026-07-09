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
