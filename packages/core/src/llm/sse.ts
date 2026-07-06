export interface SseEvent {
  event?: string;
  data: string;
}

export async function* parseSse(response: Response): AsyncIterable<SseEvent> {
  if (!response.body) {
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    yield* drainEvents(buffer, (nextBuffer) => {
      buffer = nextBuffer;
    });
  }

  buffer += decoder.decode();
  yield* drainEvents(`${buffer}\n\n`, (nextBuffer) => {
    buffer = nextBuffer;
  });
}

function* drainEvents(
  buffer: string,
  setBuffer: (nextBuffer: string) => void
): Iterable<SseEvent> {
  let current = buffer;
  while (true) {
    const separator = /\r?\n\r?\n/.exec(current);
    if (!separator) {
      break;
    }

    const boundary = separator.index;
    const rawEvent = current.slice(0, boundary);
    current = current.slice(boundary + separator[0].length);

    const parsed = parseEvent(rawEvent);
    if (parsed) {
      yield parsed;
    }
  }

  setBuffer(current);
}

function parseEvent(rawEvent: string): SseEvent | undefined {
  const lines = rawEvent.split(/\r?\n/);
  const data: string[] = [];
  let event: string | undefined;

  for (const line of lines) {
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim();
    }
    if (line.startsWith('data:')) {
      data.push(line.slice('data:'.length).trimStart());
    }
  }

  if (data.length === 0) {
    return undefined;
  }

  return {
    event,
    data: data.join('\n')
  };
}
