import {
  AgentRuntime,
  ObservableTraceStore,
  WorkspaceRoots,
  type AgentRuntimeOptions,
  type TraceEvent,
  type TraceStore
} from '@kross/core';

/**
 * Lightweight runtime for tests / fallback. Includes workspace roots + sample
 * registry so conductor plan gate can be exercised without ~/.kross files.
 */
export function createMemoryRuntime(
  overrides: Partial<AgentRuntimeOptions> = {}
): AgentRuntime {
  const sampleRegistry = {
    defaultProjectId: 'demo',
    projects: {
      demo: {
        repos: [
          { id: 'api', path: '/tmp/kross-demo-api', type: 'backend' },
          { id: 'web', path: '/tmp/kross-demo-web', type: 'frontend' }
        ]
      }
    }
  };

  return new AgentRuntime({
    traceStore: new ObservableTraceStore(new InMemoryTraceStore()),
    workspaceRoot: '/tmp/kross-demo-primary',
    workspaceRoots: new WorkspaceRoots('/tmp/kross-demo-primary'),
    projectRegistry: sampleRegistry,
    projectRegistryPath: '(memory) sample registry',
    runSubagent: async (request) => ({
      subRunId: `sub-memory-${request.repoId ?? 'local'}`,
      mode: request.mode === 'general' ? 'general' : 'explore',
      modeForcedToExplore: false,
      result: {
        status: 'completed',
        summary: `memory subagent completed for ${request.repoId ?? 'local'}`,
        changedFiles: [],
        diffSummary: [],
        commandsRun: [],
        evidence: [],
        risks: [],
        needsReview: []
      }
    }),
    ...overrides
  });
}

class InMemoryTraceStore implements TraceStore {
  private readonly events: TraceEvent[] = [];

  async append(event: TraceEvent): Promise<void> {
    this.events.push(event);
  }

  async readRun(runId: string): Promise<TraceEvent[]> {
    return this.events.filter((event) => event.runId === runId);
  }

  async listRunIds(): Promise<string[]> {
    const seen = new Set<string>();
    const ids: string[] = [];
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      const runId = this.events[index]?.runId;
      if (!runId || seen.has(runId)) {
        continue;
      }
      seen.add(runId);
      ids.push(runId);
    }
    return ids;
  }
}
