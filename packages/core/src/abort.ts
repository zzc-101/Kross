export class OperationAbortedError extends Error {
  constructor(message = 'Operation aborted') {
    super(message);
    this.name = 'AbortError';
  }
}

export function abortReason(
  signal: AbortSignal | undefined,
  fallback = 'Operation aborted'
): Error {
  if (signal?.reason instanceof Error) {
    return signal.reason;
  }
  if (signal?.reason !== undefined) {
    return new OperationAbortedError(String(signal.reason));
  }
  return new OperationAbortedError(fallback);
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortReason(signal);
  }
}

/**
 * 取消可能被 provider 包装成普通 Error；只要对应 signal 已中止，
 * 上层就必须把它识别为取消，而不是运行失败。
 */
export function isOperationAborted(
  error: unknown,
  signal?: AbortSignal
): boolean {
  if (signal?.aborted) {
    return true;
  }
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error instanceof OperationAbortedError)
  );
}

export function abortMessage(
  signal: AbortSignal | undefined,
  fallback = '用户中断'
): string {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.message.trim().length > 0) {
    return reason.message;
  }
  if (typeof reason === 'string' && reason.trim().length > 0) {
    return reason;
  }
  return fallback;
}

/**
 * 把任意 Promise 与 AbortSignal 竞态：signal 中止时立即 reject，
 * 避免 provider 忽略 signal 导致 await 永久挂起（Esc 失效）。
 * 原 promise 仍可能在后台继续，调用方应尽量把 signal 传给底层。
 */
export function raceAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}
