import { describe, expect, it } from 'vitest';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import { formatLocationLabel } from './HeaderBar';
import { formatStatusLabel, theme } from './theme';
import * as welcomeHomeModule from './WelcomeHome';

const { formatCwdLabel, formatSessionTime } = welcomeHomeModule;

describe('formatCwdLabel', () => {
  it('rewrites home directory to ~', () => {
    const home = homedir();
    expect(formatCwdLabel(join(home, 'MyProject', 'agent'), home)).toBe(
      `~${sep}MyProject${sep}agent`
    );
  });

  it('keeps absolute paths outside home', () => {
    const home = homedir();
    const cwd = resolve(home, '..', 'outside-home', 'work');
    expect(formatCwdLabel(cwd, home)).toBe(cwd);
  });

  it('does not treat a sibling path with a shared prefix as home', () => {
    const home = join(tmpdir(), 'user');
    const sibling = join(tmpdir(), 'user-backup', 'project');
    expect(formatCwdLabel(sibling, home)).toBe(sibling);
  });
});

describe('formatSessionTime', () => {
  it('formats a compact local timestamp and tolerates invalid input', () => {
    const localTime = new Date(2026, 6, 14, 10, 8);
    expect(formatSessionTime(localTime.toISOString())).toBe('07-14 10:08');
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
