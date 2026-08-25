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

  it('parses a work-oriented subagent result', () => {
    const result = subagentResultSchema.parse({
      status: 'completed',
      summary: '会议纪要已整理',
      artifacts: ['meeting-notes.md'],
      toolsUsed: ['Read', 'Write'],
      evidence: ['已提取三个行动项'],
      incompleteItems: []
    });

    expect(result.artifacts).toEqual(['meeting-notes.md']);
    expect(result.evidence).toContain('已提取三个行动项');
    expect(result.incompleteItems).toEqual([]);
  });

  it('parses a final agent result', () => {
    const result = agentResultSchema.parse({
      runId: 'run-1',
      status: 'completed',
      summary: '任务完成',
      report: {
        artifacts: [],
        evidence: ['trace 已保存'],
        incompleteItems: []
      }
    });

    expect(result.mode).toBe('auto');
    expect(result.report.evidence).toEqual(['trace 已保存']);
    expect(result.report.incompleteItems).toEqual([]);
  });
});
