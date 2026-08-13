import {
  publicEventEnvelopeSchema,
  type PublicEventEnvelope
} from '@kross/protocol';

export interface EventStreamOptions {
  baseUrl?: string;
  organizationId: string;
  devUserId?: string;
  runId?: string;
  cursor?: string;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  onEvent(event: PublicEventEnvelope): void;
  onConnection?(state: 'connecting' | 'connected' | 'retrying'): void;
}

/** Fetch-based SSE supports credentials, Last-Event-ID and dev identity headers. */
export async function consumePublicEvents(options: EventStreamOptions): Promise<void> {
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  let cursor = options.cursor;
  let retryMs = 750;
  const seen = new Set<string>();
  while (!options.signal?.aborted) {
    options.onConnection?.(cursor ? 'retrying' : 'connecting');
    try {
      const url = new URL('/api/v2/events', options.baseUrl ?? location.origin);
      if (options.runId) url.searchParams.set('run', options.runId);
      const headers = new Headers({ accept: 'text/event-stream' });
      headers.set('x-kross-organization-id', options.organizationId);
      if (options.devUserId) headers.set('x-kross-user-id', options.devUserId);
      if (cursor) headers.set('last-event-id', cursor);
      const response = await fetcher(url, { headers, credentials: 'include', signal: options.signal });
      if (!response.ok || !response.body) throw new Error(`SSE ${response.status}`);
      options.onConnection?.('connected');
      retryMs = 750;
      for await (const message of parseSse(response.body)) {
        if (!message.data) continue;
        const parsed = publicEventEnvelopeSchema.safeParse(JSON.parse(message.data));
        if (!parsed.success || seen.has(parsed.data.eventId)) continue;
        seen.add(parsed.data.eventId);
        if (seen.size > 2_000) seen.delete(seen.values().next().value!);
        cursor = parsed.data.eventId;
        options.onEvent(parsed.data);
      }
      if (!options.signal?.aborted) {
        options.onConnection?.('retrying');
        await delay(retryMs, options.signal);
        retryMs = Math.min(retryMs * 2, 15_000);
      }
    } catch (error) {
      if (options.signal?.aborted) return;
      options.onConnection?.('retrying');
      await delay(retryMs, options.signal);
      retryMs = Math.min(retryMs * 2, 15_000);
    }
  }
}

export async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<{ id?: string; data?: string }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += value ? decoder.decode(value, { stream: !done }) : '';
      const normalized = buffer.replace(/\r\n/g, '\n');
      const boundary = normalized.indexOf('\n\n');
      if (boundary < 0) {
        if (done) return;
        continue;
      }
      const blocks = normalized.split('\n\n');
      buffer = blocks.pop() ?? '';
      for (const block of blocks) {
        const message: { id?: string; data?: string } = {};
        const data: string[] = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('id:')) message.id = line.slice(3).trimStart();
          if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        }
        if (!data.length && message.id === undefined) continue;
        if (data.length) message.data = data.join('\n');
        yield message;
      }
      if (done) return;
    }
  } finally {
    reader.releaseLock();
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
