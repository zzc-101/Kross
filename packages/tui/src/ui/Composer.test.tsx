import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';

import {
  COMPOSER_BOTTOM_GAP,
  COMPOSER_FOOTER_HEIGHT,
  COMPOSER_HEIGHT,
  Composer
} from './Composer';

describe('Composer', () => {
  it('reserves three footer rows below the visible input frame', () => {
    expect(COMPOSER_BOTTOM_GAP).toBe(3);
    expect(COMPOSER_FOOTER_HEIGHT).toBe(
      COMPOSER_HEIGHT + COMPOSER_BOTTOM_GAP
    );
  });

  it('renders a single-row input with metadata embedded in the bottom border', () => {
    const { lastFrame } = render(
      <Composer
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        modelLabel="Grok 4.5 (high)"
        permissionMode="auto"
        width={64}
      />
    );

    const lines = lastFrame()?.split('\n') ?? [];
    expect(lines).toHaveLength(COMPOSER_FOOTER_HEIGHT);
    expect(lines[0]).toMatch(/^╭─+╮$/);
    expect(lines[1]).toMatch(/^│\s+❯/);
    expect(lines[1]).toMatch(/│$/);
    expect(lines[2]).toMatch(
      /^╰─+ Grok 4\.5 \(high\) · always-approve ─╯$/
    );
    expect(lines.slice(COMPOSER_HEIGHT)).toEqual(['', '', '']);
  });
});
