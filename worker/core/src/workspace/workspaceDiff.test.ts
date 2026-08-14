import { describe, expect, it, vi } from 'vitest';

import type { TraceEvent } from '../domain';
import {
  buildDiffInspection,
  collectGitWorkspaceSnapshot,
  formatDiffInspection,
  suggestVerifyCommands
} from './workspaceDiff';

describe('workspaceDiff', () => {
  it('builds and formats inspection from events + git snapshot', () => {
    const events: TraceEvent[] = [
      {
        id: '1',
        runId: 'run-1',
        type: 'tool_call.completed',
        timestamp: '2026-07-09T10:00:00.000Z',
        payload: {
          toolName: 'Write',
          input: { path: 'src/a.ts' },
          summary: 'wrote 3 bytes'
        }
      }
    ];

    const inspection = buildDiffInspection({
      runId: 'run-1',
      events,
      git: {
        statusPorcelain: [' M src/a.ts', '?? src/b.ts'],
        diffStat: ' src/a.ts | 2 +-',
        stagedDiffStat: ''
      },
      suggestedCommands: ['npm test -- --run', 'git status']
    });

    expect(inspection.changedFiles).toEqual(['src/a.ts']);

    const text = formatDiffInspection(inspection);
    expect(text).toContain('run: run-1');
    expect(text).toContain('Write/Edit only');
    expect(text).toContain('src/a.ts  [Write]');
    expect(text).toContain('M src/a.ts');
    expect(text).toContain('src/a.ts | 2 +-');
    expect(text).toContain('npm test -- --run');
  });

  it('caps long git diff --stat output', () => {
    const manyLines = Array.from({ length: 50 }, (_, i) => ` file${i}.ts | 1 +`).join(
      '\n'
    );
    const text = formatDiffInspection(
      buildDiffInspection({
        runId: 'run-cap',
        events: [],
        git: {
          statusPorcelain: [],
          diffStat: manyLines,
          stagedDiffStat: ''
        }
      })
    );
    expect(text).toContain('… +10 more lines');
  });

  it('collects git snapshot via injected runner', async () => {
    const runGit = vi.fn(async (args: string[]) => {
      if (args[0] === 'status') {
        return { stdout: ' M file.ts\n', stderr: '' };
      }
      if (args.includes('--cached')) {
        return { stdout: '', stderr: '' };
      }
      return { stdout: ' file.ts | 1 +\n', stderr: '' };
    });

    const snapshot = await collectGitWorkspaceSnapshot('/tmp/ws', runGit);
    expect(snapshot).toEqual({
      statusPorcelain: [' M file.ts'],
      diffStat: 'file.ts | 1 +',
      stagedDiffStat: ''
    });
    expect(runGit).toHaveBeenCalledTimes(3);
  });

  it('returns null when git fails', async () => {
    const snapshot = await collectGitWorkspaceSnapshot('/tmp/ws', async () => {
      throw new Error('not a git repo');
    });
    expect(snapshot).toBeNull();
  });

  it('suggests package scripts when package.json exists', async () => {
    const commands = await suggestVerifyCommands(process.cwd());
    expect(commands).toEqual(
      expect.arrayContaining(['npm test -- --run', 'npm run typecheck', 'git status'])
    );
  });
});
