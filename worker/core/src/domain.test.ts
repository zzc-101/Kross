import { describe, expect, it } from 'vitest';

import {
  agentResultSchema,
  projectRegistrySchema,
  subagentResultSchema,
  traceEventSchema
} from './domain';

describe('domain schemas', () => {
  it('parses a local project registry with multiple repos', () => {
    const registry = projectRegistrySchema.parse({
      projects: {
        rcc: {
          repos: [
            {
              id: 'backend',
              path: '/Users/zc/IdeaProjects/jeecgboot',
              type: 'java-backend',
              testCommand: 'mvn test'
            },
            {
              id: 'frontend',
              path: '/Users/zc/WebstormProjects/jeecgboot-vue3',
              type: 'vue-frontend',
              testCommand: 'pnpm lint'
            }
          ]
        }
      }
    });

    expect(registry.projects.rcc?.repos.map((repo) => repo.id)).toEqual([
      'backend',
      'frontend'
    ]);
  });

  it('rejects a trace event without run id', () => {
    const result = traceEventSchema.safeParse({
      id: 'event-1',
      type: 'run.started',
      timestamp: '2026-07-06T06:30:00.000Z',
      payload: {}
    });

    expect(result.success).toBe(false);
  });

  it('parses subagent results with evidence and risks', () => {
    const result = subagentResultSchema.parse({
      status: 'completed',
      summary: '完成后端字段贯通',
      changedFiles: ['src/task.ts'],
      diffSummary: ['新增 taskSource 字段'],
      commandsRun: ['npm test'],
      toolsUsed: ['Read', 'Edit', 'Bash'],
      verification: {
        status: 'passed',
        commands: ['npm test'],
        evidence: ['npm test: passed']
      },
      evidence: ['测试通过'],
      risks: ['未覆盖并发场景'],
      needsReview: []
    });

    expect(result.evidence).toContain('测试通过');
    expect(result.risks).toHaveLength(1);
    expect(result.verification.status).toBe('passed');
  });

  it('parses a final agent result for auto mode', () => {
    const result = agentResultSchema.parse({
      runId: 'run-1',
      mode: 'auto',
      status: 'completed',
      summary: '任务完成',
      report: {
        changedFiles: [],
        evidence: ['trace 已保存'],
        risks: []
      }
    });

    expect(result.mode).toBe('auto');
    expect(result.report.evidence).toEqual(['trace 已保存']);
    expect(result.report.verification.status).toBe('not-run');
  });
});
