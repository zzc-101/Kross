import { describe, expect, it } from 'vitest';

import {
  buildMcpToolName,
  inferMcpToolRisk,
  sanitizeMcpNamePart
} from './risk';

describe('mcp risk and naming', () => {
  it('defaults to network and respects annotations / server override', () => {
    expect(inferMcpToolRisk({ name: 'x' })).toBe('network');
    expect(
      inferMcpToolRisk({ name: 'x', annotations: { readOnlyHint: true } })
    ).toBe('read');
    expect(
      inferMcpToolRisk(
        { name: 'x', annotations: { readOnlyHint: true } },
        'execute'
      )
    ).toBe('execute');
    expect(
      inferMcpToolRisk({ name: 'x', annotations: { destructiveHint: true } })
    ).toBe('write');
  });

  it('builds stable gateway tool names', () => {
    expect(sanitizeMcpNamePart('my server!')).toBe('my_server');
    expect(buildMcpToolName('github', 'search_issues')).toBe(
      'github__search_issues'
    );
  });
});
