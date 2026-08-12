export { createWorkExecutionProfile, WorkRunEvidence } from './workExecutionProfile';
export type {
  CreateWorkExecutionProfileOptions,
  WorkExecutionSpec,
  WorkRunEvidenceSnapshot
} from './workExecutionProfile';
export { materializeExecutionWorkspace, safeJoin } from './sourceMaterializer';
export type {
  MaterializedWorkspace,
  MaterializableRunSpec,
  MaterializableSource,
  SourceDownloadAdapter
} from './sourceMaterializer';
export { FileCheckpointStore } from './checkpointStore';
export type { SavedCheckpoint, WorkRuntimeCheckpoint } from './checkpointStore';
export { collectOutputArtifacts } from './artifactCollector';
export type { CollectedArtifact, CollectedArtifactKind } from './artifactCollector';

export const WORK_RUNTIME_VERSION = 1 as const;
