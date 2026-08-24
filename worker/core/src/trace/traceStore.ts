import type { TraceEvent } from '../domain';

export interface ListRunsOptions {
  /** 最多返回条数，默认 10 */
  limit?: number;
}

export interface TraceStore {
  append(event: TraceEvent): Promise<void>;
  readRun(runId: string): Promise<TraceEvent[]>;
  /**
   * 列出已知 runId，应按最近活动优先。
   * 无法索引时返回 []（会使 /trace、/diff 降级）。
   * 单条损坏的 run 不应拖垮整表。
   */
  listRunIds(): Promise<string[]>;
}
