import type { z } from 'zod';

import type {
  agentResultSchema,
  clientCommandSchema,
  eventEnvelopeSchema,
  serverEventSchema,
  sessionSnapshotSchema,
  workspaceSchema
} from './schemas';

export type ClientCommand = z.infer<typeof clientCommandSchema>;
export type ServerEvent = z.infer<typeof serverEventSchema>;
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
export type CloudWorkspace = z.infer<typeof workspaceSchema>;
export type SessionSnapshot = z.infer<typeof sessionSnapshotSchema>;
export type AgentResult = z.infer<typeof agentResultSchema>;
export type WorkspaceProgress = Extract<
  ServerEvent,
  { type: 'workspace.progress' }
>['data'];
