/**
 * 终端/Node 下合并滚动更新：一帧只 flush 一次，避免触控板每事件 setState。
 * 优先 requestAnimationFrame；不可用时退回 ~16ms setTimeout。
 */

export type ScrollFrameCallback = (delta: number) => void;

export interface ScrollScheduler {
  /** 累加 delta（上滚为正、下滚为负，与 App.scrollBy 约定一致） */
  enqueue(delta: number): void;
  /** 取消防抖中的待处理帧 */
  cancel(): void;
}

type RafHandle = number;

function getRaf(): {
  schedule: (cb: () => void) => RafHandle;
  cancel: (handle: RafHandle) => void;
} {
  const g = globalThis as typeof globalThis & {
    requestAnimationFrame?: (cb: (time: number) => void) => number;
    cancelAnimationFrame?: (handle: number) => void;
  };

  if (
    typeof g.requestAnimationFrame === 'function' &&
    typeof g.cancelAnimationFrame === 'function'
  ) {
    const schedule = g.requestAnimationFrame.bind(g);
    const cancel = g.cancelAnimationFrame.bind(g);
    return {
      schedule: (cb) => schedule(() => cb()),
      cancel
    };
  }

  return {
    schedule: (cb) => setTimeout(cb, 16) as unknown as RafHandle,
    cancel: (handle) => {
      clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
    }
  };
}

export function createScrollScheduler(
  onFlush: ScrollFrameCallback
): ScrollScheduler {
  let pending = 0;
  let handle: RafHandle | null = null;
  const raf = getRaf();

  const clearHandle = (): void => {
    if (handle === null) {
      return;
    }
    raf.cancel(handle);
    handle = null;
  };

  const flush = (): void => {
    handle = null;
    const delta = pending;
    pending = 0;
    if (delta !== 0) {
      onFlush(delta);
    }
  };

  const schedule = (): void => {
    if (handle !== null) {
      return;
    }
    handle = raf.schedule(flush);
  };

  return {
    enqueue(delta: number) {
      if (delta === 0) {
        return;
      }
      pending += delta;
      schedule();
    },
    cancel() {
      clearHandle();
      pending = 0;
    }
  };
}
