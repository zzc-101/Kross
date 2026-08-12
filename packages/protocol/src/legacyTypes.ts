import type { z } from 'zod';

import type {
  agentResultSchema,
  clientCommandSchema,
  eventEnvelopeSchema,
  modelProfileSchema,
  serverEventSchema,
  sessionSnapshotSchema,
  workspaceSchema
} from './legacySchemas';

/** @deprecated Temporary workspace/session Cloud type. */
export type ClientCommand = z.infer<typeof clientCommandSchema>;
/** @deprecated Temporary workspace/session Cloud type. */
export type ServerEvent = z.infer<typeof serverEventSchema>;
/** @deprecated Temporary workspace/session Cloud type. */
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
/** @deprecated Temporary workspace/session Cloud type. */
export type CloudWorkspace = z.infer<typeof workspaceSchema>;
/** @deprecated Temporary workspace/session Cloud type. */
export type ModelProfile = z.infer<typeof modelProfileSchema>;
/** @deprecated Temporary workspace/session Cloud type. */
export type SessionSnapshot = z.infer<typeof sessionSnapshotSchema>;
/** @deprecated Temporary workspace/session Cloud type. */
export type AgentResult = z.infer<typeof agentResultSchema>;
/** @deprecated Temporary workspace/session Cloud type. */
export type WorkspaceProgress = Extract<
  ServerEvent,
  { type: 'workspace.progress' }
>['data'];
