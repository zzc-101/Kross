import { describe, expect, it } from 'vitest';

import type { ConductorTaskPlan } from '../modes/conductorPlan';
import type { SubagentRunOutcome } from './subagentTypes';
import { AgentRuntime } from './agentRuntime';
import {
  FakeLlmClient,
  InMemoryTraceStore
} from './agentRuntime.testSupport';

describe('Conductor P1 execution', () => {
  it('runs independent tasks concurrently and waits for dependencies', async () => {
    const traceStore = new InMemoryTraceStore();
    let active = 0;
    let maxActive = 0;
    const finished = new Set<string>();
    const started: string[] = [];
    const runtime = new AgentRuntime({
      traceStore,
      llmClient: new FakeLlmClient('not-json'),
      workspaceRoot: '/tmp/ws',
      runSubagent: async (request) => {
        if (request.role === 'reviewer') return reviewerOutcome();
        const id = request.title ?? 'unknown';
        if (request.role !== 'worker') {
          throw new Error(`unexpected role: ${request.role}`);
        }
        if (id === 'dependent') {
          expect(finished).toEqual(new Set(['parallel-a', 'parallel-b']));
        }
        started.push(id);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        finished.add(id);
        return workerOutcome(id, 'completed');
      }
    });
    restorePlan(runtime, {
      goal: 'parallel graph',
      tasks: [
        { id: 'a', title: 'parallel-a', prompt: 'a' },
        { id: 'b', title: 'parallel-b', prompt: 'b' },
        {
          id: 'c',
          title: 'dependent',
          prompt: 'c',
          dependsOn: ['a', 'b']
        }
      ]
    });

    const result = await runtime.run({
      input: 'parallel graph',
      requestedMode: 'conductor',
      approvals: { plan: true }
    });

    expect(result.status).toBe('completed');
    expect(maxActive).toBe(2);
    expect(started.slice(0, 2).sort()).toEqual(['parallel-a', 'parallel-b']);
    expect(started.at(-1)).toBe('dependent');
  });

  it('blocks dependent tasks when a prerequisite does not complete', async () => {
    const traceStore = new InMemoryTraceStore();
    const workers: string[] = [];
    const runtime = new AgentRuntime({
      traceStore,
      llmClient: new FakeLlmClient('not-json'),
      workspaceRoot: '/tmp/ws',
      runSubagent: async (request) => {
        if (request.role === 'reviewer') return reviewerOutcome();
        if (request.role !== 'worker') {
          throw new Error(`unexpected role: ${request.role}`);
        }
        workers.push(request.title ?? 'unknown');
        return workerOutcome('prerequisite failed', 'failed');
      }
    });
    restorePlan(runtime, {
      goal: 'blocked graph',
      tasks: [
        { id: 'first', title: 'first', prompt: 'first' },
        {
          id: 'second',
          title: 'second',
          prompt: 'second',
          dependsOn: ['first']
        }
      ]
    });

    const result = await runtime.run({
      input: 'blocked graph',
      requestedMode: 'conductor',
      approvals: { plan: true }
    });

    expect(result.status).toBe('failed');
    expect(workers).toEqual(['first', 'first']);
    expect(result.summary).toContain('依赖任务 first 未成功');
    expect(traceStore.events.map((event) => event.type)).toContain(
      'conductor.worker.blocked'
    );
  });

  it('allows dependencies after a completed mutation awaiting validation', async () => {
    const workers: string[] = [];
    const runtime = new AgentRuntime({
      traceStore: new InMemoryTraceStore(),
      llmClient: new FakeLlmClient('not-json'),
      workspaceRoot: '/tmp/ws',
      runSubagent: async (request) => {
        if (request.role === 'reviewer') return reviewerOutcome();
        if (request.role === 'validator') {
          return workerOutcome('independent validation', 'completed');
        }
        workers.push(request.title ?? 'unknown');
        const completed = workerOutcome(request.title ?? 'worker', 'completed');
        if (request.title !== 'first') return completed;
        return {
          ...completed,
          result: {
            ...completed.result,
            status: 'needs-review',
            commandsRun: [],
            verification: {
              status: 'not-run',
              commands: [],
              evidence: [],
              reason: 'awaiting independent validation'
            },
            needsReview: ['Conductor reviewer must inspect verification gap']
          }
        };
      }
    });
    restorePlan(runtime, {
      goal: 'validate after graph',
      tasks: [
        { id: 'first', title: 'first', prompt: 'first' },
        {
          id: 'second',
          title: 'second',
          prompt: 'second',
          dependsOn: ['first']
        }
      ]
    });

    const result = await runtime.run({
      input: 'validate after graph',
      requestedMode: 'conductor',
      approvals: { plan: true }
    });

    expect(result.status).toBe('completed');
    expect(workers).toEqual(['first', 'second']);
    expect(result.report.verification.status).toBe('passed');
  });

  it('retries twice then runs one senior-model recovery task', async () => {
    const traceStore = new InMemoryTraceStore();
    const workerPrompts: string[] = [];
    const runtime = new AgentRuntime({
      traceStore,
      llmClient: new FakeLlmClient(
        '{"title":"recovered","prompt":"use a smaller recovery path"}'
      ),
      workspaceRoot: '/tmp/ws',
      runSubagent: async (request) => {
        if (request.role === 'reviewer') return reviewerOutcome();
        if (request.role !== 'worker') {
          throw new Error(`unexpected role: ${request.role}`);
        }
        workerPrompts.push(request.prompt);
        return workerPrompts.length < 3
          ? workerOutcome('temporary worker failure', 'failed')
          : workerOutcome('recovered implementation', 'completed');
      }
    });
    restorePlan(runtime, {
      goal: 'recover worker',
      tasks: [{ id: 'recover', title: 'recover', prompt: 'original path' }]
    });

    const result = await runtime.run({
      input: 'recover worker',
      requestedMode: 'conductor',
      approvals: { plan: true }
    });

    expect(result.status).toBe('completed');
    expect(workerPrompts).toHaveLength(3);
    expect(workerPrompts[1]).toContain('Conductor retry context');
    expect(workerPrompts[2]).toBe('use a smaller recovery path');
    expect(traceStore.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'conductor.worker.retry',
        'conductor.worker.replan.started',
        'conductor.worker.replan.completed'
      ])
    );
    expect(result.summary).toContain('执行：3 次 · replan');
  });

  it('does not retry a thrown worker because pre-error mutations are unknown', async () => {
    const traceStore = new InMemoryTraceStore();
    let workerCalls = 0;
    const runtime = new AgentRuntime({
      traceStore,
      llmClient: new FakeLlmClient('not-json'),
      workspaceRoot: '/tmp/ws',
      runSubagent: async (request) => {
        if (request.role === 'reviewer') return reviewerOutcome();
        workerCalls += 1;
        throw new Error('transport dropped after tool activity');
      }
    });
    restorePlan(runtime, {
      goal: 'unknown mutation state',
      tasks: [{ id: 'unsafe-retry', title: 'unsafe-retry', prompt: 'work' }]
    });

    const result = await runtime.run({
      input: 'unknown mutation state',
      requestedMode: 'conductor',
      approvals: { plan: true }
    });

    expect(result.status).toBe('failed');
    expect(workerCalls).toBe(1);
    expect(traceStore.events.map((event) => event.type)).not.toContain(
      'conductor.worker.retry'
    );
  });

  it('rejects a stalled validator even when it reports a passing command', async () => {
    const runtime = new AgentRuntime({
      traceStore: new InMemoryTraceStore(),
      llmClient: new FakeLlmClient('not-json'),
      workspaceRoot: '/tmp/ws',
      runSubagent: async (request) => {
        if (request.role === 'reviewer') return reviewerOutcome();
        if (request.role === 'validator') {
          return {
            ...workerOutcome('validator stalled', 'completed'),
            mode: 'explore',
            result: {
              ...workerOutcome('validator stalled', 'completed').result,
              status: 'needs-review',
              changedFiles: []
            }
          };
        }
        return {
          ...workerOutcome('unverified implementation', 'completed'),
          result: {
            ...workerOutcome('unverified implementation', 'completed').result,
            status: 'needs-review',
            commandsRun: [],
            verification: {
              status: 'not-run',
              commands: [],
              evidence: [],
              reason: 'worker could not run tests'
            }
          }
        };
      }
    });
    restorePlan(runtime, {
      goal: 'validator must finish',
      tasks: [{ id: 'change', title: 'change', prompt: 'change code' }]
    });

    const result = await runtime.run({
      input: 'validator must finish',
      requestedMode: 'conductor',
      approvals: { plan: true }
    });

    expect(result.status).toBe('failed');
    expect(result.report.verification.status).toBe('passed');
  });
});

function restorePlan(runtime: AgentRuntime, plan: ConductorTaskPlan): void {
  runtime.restoreWorkState({
    version: 1,
    todos: [],
    sessionMode: 'conductor',
    pendingModeExecution: {
      kind: 'conductor',
      goal: plan.goal,
      mode: 'conductor',
      plan
    }
  });
}

function workerOutcome(
  summary: string,
  status: 'completed' | 'failed'
): SubagentRunOutcome {
  const completed = status === 'completed';
  return {
    subRunId: `worker-${summary}`,
    mode: 'general',
    modeForcedToExplore: false,
    result: {
      status,
      summary,
      changedFiles: completed ? [`src/${summary}.ts`] : [],
      diffSummary: [],
      commandsRun: completed ? ['npm test'] : [],
      toolsUsed: completed ? ['Write', 'Verify'] : [],
      verification: completed
        ? {
            status: 'passed',
            commands: ['npm test'],
            evidence: ['npm test: exit=0']
          }
        : {
            status: 'not-run',
            commands: [],
            evidence: [],
            reason: summary
          },
      evidence: [],
      risks: completed ? [] : [summary],
      needsReview: []
    }
  };
}

function reviewerOutcome(): SubagentRunOutcome {
  return {
    subRunId: 'reviewer',
    mode: 'explore',
    modeForcedToExplore: false,
    result: {
      status: 'completed',
      summary: 'final diff accepted\nVERDICT: PASS',
      changedFiles: [],
      diffSummary: [],
      commandsRun: [],
      toolsUsed: [
        'GitStatus',
        'GitDiff',
        'GitDiff:unstaged',
        'GitDiff:staged'
      ],
      verification: {
        status: 'not-needed',
        commands: [],
        evidence: []
      },
      evidence: [],
      risks: [],
      needsReview: []
    }
  };
}
