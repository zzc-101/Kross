import { describe, expect, it } from 'vitest';

import { clampScrollOffset } from './useViewportScroll';

describe('clampScrollOffset', () => {
  it('keeps offsets inside the current viewport bounds', () => {
    expect(clampScrollOffset(-3, 20)).toBe(0);
    expect(clampScrollOffset(7, 20)).toBe(7);
    expect(clampScrollOffset(30, 20)).toBe(20);
  });
});
