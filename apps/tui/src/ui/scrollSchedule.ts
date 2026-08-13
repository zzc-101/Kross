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
    const delta = takeFrameDelta(pending);
    pending -= delta;
    if (delta !== 0) {
      onFlush(delta);
    }
    if (pending !== 0) {
      schedule();
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

/**
 * 小位移立即响应，大位移保留 2-3 行的中间帧；极大突发先折叠超额部分，
 * 避免触摸板松手后仍长时间惯性排队。
 */
export function takeFrameDelta(pending: number): number {
  if (pending === 0) {
    return 0;
  }
  const sign = pending > 0 ? 1 : -1;
  const amount = Math.abs(pending);
  if (amount <= 5) {
    return pending;
  }

  const collapsed = Math.max(0, amount - 30);
  const animated = Math.min(amount, 30);
  const step = animated < 12 ? 2 : 3;
  return sign * (collapsed + step);
}
