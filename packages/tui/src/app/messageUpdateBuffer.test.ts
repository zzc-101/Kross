import { describe, expect, it, vi } from 'vitest';

import { createMessageUpdateBuffer } from './messageUpdateBuffer';

describe('createMessageUpdateBuffer', () => {
  it('flushes the latest text for each message once per scheduled frame', () => {
    let scheduled: (() => void) | undefined;
    const onFlush = vi.fn();
    const buffer = createMessageUpdateBuffer({
      onFlush,
      schedule: (callback) => {
        scheduled = callback;
        return 1;
      },
      cancel: vi.fn()
    });

    buffer.enqueue(7, 'a');
    buffer.enqueue(7, 'ab');
    buffer.enqueue(8, 'thinking');

    expect(onFlush).not.toHaveBeenCalled();
    scheduled?.();
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith(
      new Map([
        [7, 'ab'],
        [8, 'thinking']
      ])
    );
  });
});
