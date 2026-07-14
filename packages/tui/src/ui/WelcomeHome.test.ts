import { describe, expect, it } from 'vitest';

import { formatLocationLabel } from './HeaderBar';
import { formatStatusLabel, theme } from './theme';
import * as welcomeHomeModule from './WelcomeHome';

const { formatCwdLabel, formatSessionTime } = welcomeHomeModule;

describe('formatCwdLabel', () => {
  it('rewrites home directory to ~', () => {
    expect(formatCwdLabel('/Users/zc/MyProject/agent', '/Users/zc')).toBe(
      '~/MyProject/agent'
    );
  });

  it('keeps absolute paths outside home', () => {
    expect(formatCwdLabel('/tmp/work', '/Users/zc')).toBe('/tmp/work');
  });
});

describe('formatSessionTime', () => {
  it('formats a compact local timestamp and tolerates invalid input', () => {
    expect(formatSessionTime('2026-07-14T10:08:00+08:00')).toBe('07-14 10:08');
    expect(formatSessionTime('invalid')).toBe('');
  });
});

describe('formatLocationLabel', () => {
  it('prefers branch and cwd over projectName', () => {
    expect(
      formatLocationLabel({
        branch: 'main',
        cwdLabel: '~/MyProject/agent',
        projectName: 'local'
      })
    ).toBe('main  ~/MyProject/agent');
  });

  it('falls back to projectName when location is missing', () => {
    expect(formatLocationLabel({ projectName: 'local' })).toBe('local');
  });
});

describe('soft terminal color roles', () => {
  it('keeps brand selection distinct from warning and brightens muted brand', () => {
    expect(theme.user).toBe(theme.brand);
    expect(theme.user).not.toBe(theme.statusWarn);
    expect(theme.brandMuted).toBe('#0e7490');
  });

  it('uses yellow for non-terminal risk states and Chinese status labels', () => {
    expect(theme.riskExecute).toBe(theme.statusWarn);
    expect(theme.riskNetwork).toBe(theme.statusWarn);
    expect(formatStatusLabel('ready')).toBe('就绪');
    expect(formatStatusLabel('responding')).toBe('思考中');
    expect(formatStatusLabel('approval-required')).toBe('等待工具确认');
  });
});

describe('responsive welcome layout', () => {
  it('caps wide cards and chooses a compact brand only below wordmark width', () => {
    const resolveLayout = (welcomeHomeModule as any).resolveWelcomeLayout;
    expect(resolveLayout).toBeTypeOf('function');
    if (typeof resolveLayout !== 'function') {
      return;
    }

    expect(resolveLayout(40)).toEqual({
      cardWidth: 40,
      brandMode: 'compact'
    });
    expect(resolveLayout(60)).toEqual({
      cardWidth: 60,
      brandMode: 'wordmark'
    });
    expect(resolveLayout(80)).toEqual({
      cardWidth: 80,
      brandMode: 'wordmark'
    });
    expect(resolveLayout(120)).toEqual({
      cardWidth: 88,
      brandMode: 'wordmark'
    });
  });

  it('defines the approved four-line ASCII-only wordmark', () => {
    const wordmark = (welcomeHomeModule as any).ASCII_WORDMARK;
    expect(wordmark).toEqual([
      '   __ __  ____   ____   ____   ____',
      '  / //_/ / __ \\ / __ \\ / __/  / __/',
      ' / ,<   / /_/ // /_/ /_\\ \\   _\\ \\',
      '/_/|_| /_____/ \\____//___/  /___/'
    ]);
    expect(wordmark.every((line: string) => /^[\x20-\x7e]+$/.test(line))).toBe(
      true
    );
    expect(Math.max(...wordmark.map((line: string) => line.length))).toBe(35);
  });
});
