import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { traceEventSchema, type TraceEvent } from '../domain';

export interface TraceStore {
  append(event: TraceEvent): Promise<void>;
  readRun(runId: string): Promise<TraceEvent[]>;
}

export class JsonlTraceStore implements TraceStore {
  constructor(private readonly rootDir: string) {}

  async append(event: TraceEvent): Promise<void> {
    const parsed = traceEventSchema.parse(event);
    const dir = this.runDir(parsed.runId);

    await mkdir(dir, { recursive: true });
    await appendFile(this.eventsPath(parsed.runId), `${JSON.stringify(parsed)}\n`, 'utf8');
  }

  async readRun(runId: string): Promise<TraceEvent[]> {
    try {
      const content = await readFile(this.eventsPath(runId), 'utf8');
      return content
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => traceEventSchema.parse(JSON.parse(line)));
    } catch (error) {
      if (isMissingFile(error)) {
        return [];
      }
      throw error;
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
