import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { workerRunEventEnvelopeSchema, type WorkerRunEventEnvelope } from '@kross/protocol';

interface JournalState {
  version: 1;
  runId: string;
  generation: number;
  acceptedThroughSeq: number;
  events: WorkerRunEventEnvelope[];
}

/** Durable, run-local outbox. Server remains the fact source. */
export class RunEventJournal {
  private constructor(private readonly path: string, private state: JournalState) {}

  static async open(input: { path: string; runId: string; generation: number }): Promise<RunEventJournal> {
    let state: JournalState | undefined;
    try {
      state = JSON.parse(await readFile(input.path, 'utf8')) as JournalState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    state ??= { version: 1, runId: input.runId, generation: input.generation, acceptedThroughSeq: 0, events: [] };
    if (state.version !== 1 || state.runId !== input.runId || state.generation !== input.generation) {
      throw new Error('Event journal does not belong to this run generation');
    }
    state.events = state.events.map((event) => workerRunEventEnvelopeSchema.parse(event));
    assertSequence(state);
    return new RunEventJournal(input.path, state);
  }

  get lastSequence(): number {
    return this.state.events.at(-1)?.seq ?? this.state.acceptedThroughSeq;
  }

  pending(): WorkerRunEventEnvelope[] {
    return this.state.events.filter((event) => event.seq > this.state.acceptedThroughSeq);
  }

  async append(envelope: WorkerRunEventEnvelope): Promise<void> {
    const parsed = workerRunEventEnvelopeSchema.parse(envelope);
    if (parsed.runId !== this.state.runId || parsed.generation !== this.state.generation || parsed.seq !== this.lastSequence + 1) {
      throw new Error('Worker events must be monotonic within a run generation');
    }
    this.state.events.push(parsed);
    await this.persist();
  }

  async acknowledge(acceptedThroughSeq: number): Promise<void> {
    if (acceptedThroughSeq < this.state.acceptedThroughSeq) return;
    if (acceptedThroughSeq > this.lastSequence) throw new Error('Server acknowledged an event sequence that was never emitted');
    this.state.acceptedThroughSeq = acceptedThroughSeq;
    this.state.events = this.state.events.filter((event) => event.seq > acceptedThroughSeq);
    await this.persist();
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.state)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.path);
  }
}

function assertSequence(state: JournalState): void {
  let previous = state.acceptedThroughSeq;
  for (const event of state.events) {
    if (event.seq !== previous + 1) throw new Error('Corrupt event journal sequence');
    previous = event.seq;
  }
}
