import { describe, expect, it } from 'vitest';

import type { AgentMode } from '../../domain';
import { createSetModeTool } from './setMode';

describe('SetMode tool', () => {
  it('switches session mode via callback', async () => {
    let current: AgentMode = 'auto';
    const tool = createSetModeTool({
      getMode: () => current,
      setMode: (mode) => {
        current = mode;
      }
    });

    const result = await tool.execute!({
      toolName: 'SetMode',
      input: { mode: 'conductor', reason: '用户要求指挥家' },
      runId: 'run-1',
      signal: new AbortController().signal
    });

    expect(current).toBe('conductor');
    expect(result.summary).toContain('auto→conductor');
    expect(result.content).toContain('已切换');
  });

  it('rejects invalid mode', async () => {
    const tool = createSetModeTool({
      getMode: () => 'auto',
      setMode: () => undefined
    });
    const result = await tool.execute!({
      toolName: 'SetMode',
      input: { mode: 'normal' },
      runId: 'run-1',
      signal: new AbortController().signal
    });
    expect(result.summary).toContain('failed');
  });
});
