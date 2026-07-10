import { describe, expect, it } from 'vitest';

import {
  resolveMessageViewportHeight,
  resolveShellRows
} from './AppShell';

describe('AppShell layout', () => {
  it('keeps fullscreen output below the terminal height', () => {
    expect(resolveShellRows(24)).toBe(23);
    expect(resolveShellRows(2)).toBe(1);
    expect(resolveShellRows(1)).toBe(1);
  });

  it('derives viewport height from the safe shell height', () => {
    expect(
      resolveMessageViewportHeight({
        rows: 24,
        headerHeight: 2,
        footerHeight: 4
      })
    ).toBe(16);
  });
});
