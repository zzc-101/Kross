import { appendFile, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { traceEventSchema, type TraceEvent } from '../domain';
import { isSafeRunId } from './runId';
import {
  buildTraceDetail,
  summarizeTraceEvents,
  type RunTraceDetail,
  type RunTraceSummary
} from './traceSummary';

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

export class JsonlTraceStore implements TraceStore {
  constructor(private readonly rootDir: string) {}

  async append(event: TraceEvent): Promise<void> {
    const parsed = traceEventSchema.parse(event);
    if (!isSafeRunId(parsed.runId)) {
      throw new Error(`Unsafe runId: ${parsed.runId}`);
    }
    const dir = this.runDir(parsed.runId);

    await mkdir(dir, { recursive: true });
    await appendFile(this.eventsPath(parsed.runId), `${JSON.stringify(parsed)}\n`, 'utf8');
  }

  async readRun(runId: string): Promise<TraceEvent[]> {
    if (!isSafeRunId(runId)) {
      return [];
    }

    try {
      const content = await readFile(this.eventsPath(runId), 'utf8');
      const events: TraceEvent[] = [];
      for (const line of content.split('\n')) {
        if (line.trim().length === 0) {
          continue;
        }
        try {
          events.push(traceEventSchema.parse(JSON.parse(line)));
        } catch {
          // 跳过坏行，避免单行损坏拖垮整次 run 读取
        }
      }
      return events;
    } catch (error) {
      if (isMissingFile(error)) {
        return [];
      }
      throw error;
    }
  }

  async listRunIds(): Promise<string[]> {
    try {
      const entries = await readdir(this.rootDir, { withFileTypes: true });
      const runIds = entries
        .filter((entry) => entry.isDirectory() && isSafeRunId(entry.name))
        .map((entry) => entry.name);

      const withTime = await Promise.all(
        runIds.map(async (runId) => {
          try {
            const [info, events] = await Promise.all([
              stat(this.eventsPath(runId)),
              this.readRun(runId)
            ]);
            const eventTimestamp = events.reduce<number | undefined>(
              (latest, event) => {
                const timestamp = Date.parse(event.timestamp);
                return latest === undefined || timestamp > latest
                  ? timestamp
                  : latest;
              },
              undefined
            );
            return {
              runId,
              timestamp: eventTimestamp ?? info.mtimeMs,
              mtime: info.mtimeMs
            };
          } catch {
            // 缺 events 或 stat 失败：跳过，不拖垮整表
            return null;
          }
        })
      );

      return withTime
        .filter(
          (
            item
          ): item is { runId: string; timestamp: number; mtime: number } =>
            item !== null
        )
        .sort((left, right) => {
          if (left.timestamp === right.timestamp) {
            if (left.mtime !== right.mtime) {
              return right.mtime - left.mtime;
            }
            return right.runId.localeCompare(left.runId);
          }
          return right.timestamp - left.timestamp;
        })
        .map((item) => item.runId);
    } catch (error) {
      if (isMissingFile(error)) {
        return [];
      }
      throw error;
    }
  }

  async listRuns(options: ListRunsOptions = {}): Promise<RunTraceSummary[]> {
    const limit = options.limit ?? 10;
    const runIds = await this.listRunIds();
    const summaries: RunTraceSummary[] = [];

    for (const runId of runIds) {
      if (summaries.length >= limit) {
        break;
      }
      try {
        const events = await this.readRun(runId);
        const summary = summarizeTraceEvents(runId, events);
        if (summary) {
          summaries.push(summary);
        }
      } catch {
        // 单 run 失败不影响列表
      }
    }

    return summaries;
  }

  async inspectRun(runId: string): Promise<RunTraceDetail | null> {
    if (!isSafeRunId(runId)) {
      return null;
    }
    try {
      const events = await this.readRun(runId);
      return buildTraceDetail(runId, events);
    } catch {
      return null;
    }
  }

  private runDir(runId: string): string {
    return join(this.rootDir, runId);
  }

  private eventsPath(runId: string): string {
    return join(this.runDir(runId), 'events.jsonl');
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}
