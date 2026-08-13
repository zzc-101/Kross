import { describe, expect, it } from 'vitest';

import {
  resolveContentWidth,
  resolveMessageViewportHeight,
  resolveSlashSuggestionLimit,
  resolveShellRows
} from './AppShell';

describe('AppShell layout', () => {
  it('uses the complete alternate-screen height', () => {
    expect(resolveShellRows(24)).toBe(24);
    expect(resolveShellRows(2)).toBe(2);
    expect(resolveShellRows(1)).toBe(1);
  });

  it('derives viewport height from the safe shell height', () => {
    expect(
      resolveMessageViewportHeight({
        rows: 24,
        headerHeight: 2,
        footerHeight: 4
      })
    ).toBe(17);

    expect(
      resolveMessageViewportHeight({
        rows: 10,
        headerHeight: 2,
        footerHeight: 12
      })
    ).toBe(1);
  });

  it('keeps content and slash suggestions inside compact terminals', () => {
    expect(resolveContentWidth(40, true)).toBe(38);
    expect(resolveContentWidth(20, true)).toBe(18);
    expect(resolveSlashSuggestionLimit(12, true)).toBe(1);
    expect(resolveSlashSuggestionLimit(18, true)).toBe(2);
    expect(resolveSlashSuggestionLimit(24, true)).toBe(4);
    expect(resolveSlashSuggestionLimit(40, true)).toBe(8);
  });
});
