import type {
  MutationCoordinator,
  MutationService
} from '../../mutations/mutationService';
import type { MutationToolName } from '../../mutations/mutationJournal';
import type { ToolAccessScope } from '../toolGateway';

export interface MutationRecorders {
  workspace?: MutationService;
  system?: MutationCoordinator;
}

export function recordToolMutation<T>(input: {
  recorders?: MutationRecorders;
  accessScope?: ToolAccessScope;
  runId: string;
  toolName: MutationToolName;
  displayPaths: string[];
  absolutePaths: string[];
  action: () => Promise<T>;
}): Promise<T> {
  if (input.accessScope === 'system' && input.recorders?.system) {
    return input.recorders.system.recordAbsolute({
      runId: input.runId,
      toolName: input.toolName,
      paths: input.absolutePaths,
      action: input.action
    });
  }
  if (input.recorders?.workspace) {
    return input.recorders.workspace.record({
      runId: input.runId,
      toolName: input.toolName,
      paths: input.displayPaths,
      action: input.action
    });
  }
  return input.action();
}
