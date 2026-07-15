import { describe, expect, it } from 'vitest';

import { theme } from './theme';
import { contextUsageTone } from './HeaderBar';

describe('contextUsageTone', () => {
  it('warns when usage reaches 80% of compact threshold', () => {
    expect(contextUsageTone(0.79)).toBe(theme.statusReady);
    expect(contextUsageTone(0.8)).toBe(theme.statusWarn);
    expect(contextUsageTone(0.95)).toBe(theme.statusWarn);
  });

  it('errors when usage meets or exceeds compact threshold', () => {
    expect(contextUsageTone(1)).toBe(theme.statusError);
    expect(contextUsageTone(1.2)).toBe(theme.statusError);
  });
});
