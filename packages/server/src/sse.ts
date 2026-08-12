import { PROTOCOL_VERSION, publicEventEnvelopeSchema, type PublicEvent } from '@kross/protocol';
import type { OrganizationContext } from '@kross/work-domain';

import type { RunEventRepository } from './repositories';

export interface EventFilters {
  readonly projectId?: string;
  readonly taskId?: string;
  readonly runId?: string;
}

export class SseService {
  public constructor(private readonly events: RunEventRepository) {}

  public async replay(
    context: OrganizationContext,
    cursor: string | undefined,
    filters: EventFilters
  ): Promise<string[]> {
    const records = await this.events.replay(context, cursor, filters);
    return records.map((record) => {
      const envelope = publicEventEnvelopeSchema.parse({
        protocolVersion: PROTOCOL_VERSION,
        eventId: record.eventId,
        timestamp: record.timestamp,
        event: record.payload as PublicEvent
      });
      return `id: ${envelope.eventId}\nevent: ${envelope.event.type}\ndata: ${JSON.stringify(envelope)}\n\n`;
    });
  }

  public heartbeat(): string {
    return `: heartbeat ${Date.now()}\n\n`;
  }
}
