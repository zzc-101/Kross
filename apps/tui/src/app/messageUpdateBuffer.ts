export interface MessageUpdateBuffer {
  enqueue(messageId: number, text: string): void;
  flush(): void;
  cancel(): void;
}

export interface MessageUpdateBufferOptions {
  onFlush(updates: Map<number, string>): void;
  schedule?: (callback: () => void) => unknown;
  cancel?: (handle: unknown) => void;
}

export function createMessageUpdateBuffer(
  options: MessageUpdateBufferOptions
): MessageUpdateBuffer {
  const schedule =
    options.schedule ??
    ((callback: () => void) => setTimeout(callback, 32));
  const cancel =
    options.cancel ??
    ((handle: unknown) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>));
  const pending = new Map<number, string>();
  let scheduled = false;
  let handle: unknown;

  const drain = (): void => {
    if (pending.size === 0) {
      return;
    }
    const updates = new Map(pending);
    pending.clear();
    options.onFlush(updates);
  };

  const scheduledFlush = (): void => {
    scheduled = false;
    handle = undefined;
    drain();
  };

  return {
    enqueue(messageId, text) {
      pending.set(messageId, text);
      if (scheduled) {
        return;
      }
      scheduled = true;
      handle = schedule(scheduledFlush);
    },
    flush() {
      if (scheduled) {
        cancel(handle);
        scheduled = false;
        handle = undefined;
      }
      drain();
    },
    cancel() {
      if (scheduled) {
        cancel(handle);
      }
      scheduled = false;
      handle = undefined;
      pending.clear();
    }
  };
}
