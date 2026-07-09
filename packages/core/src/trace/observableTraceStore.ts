import type { TraceEvent } from '../domain';
import type { TraceStore } from './traceStore';

export type TraceEventListener = (event: TraceEvent) => void;

/**
 * 在现有 TraceStore 之上广播 append 事件，供 TUI 实时渲染工具卡片等。
 * runtime 与 ToolGateway 共用同一实例时，两侧写入都会被订阅到。
 *
 * listener 抛错会被隔离，不会中断其他订阅者，也不会污染工具/runtime 主路径。
 */
export class ObservableTraceStore implements TraceStore {
  private readonly listeners = new Set<TraceEventListener>();

  constructor(private readonly inner: TraceStore) {}

  subscribe(listener: TraceEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async append(event: TraceEvent): Promise<void> {
    await this.inner.append(event);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        // UI 侧异常不应导致工具调用失败
        console.error('[ObservableTraceStore] listener failed:', error);
      }
    }
  }

  async readRun(runId: string): Promise<TraceEvent[]> {
    return this.inner.readRun(runId);
  }
}

export function isObservableTraceStore(
  store: TraceStore
): store is ObservableTraceStore {
  return store instanceof ObservableTraceStore;
}
