import { describe, expect, it } from 'vitest';

import {
  formatCliHelp,
  formatExecHelp,
  formatMigrateHelp,
  parseCliArgs
} from './cli';

describe('parseCliArgs', () => {
  it('starts the TUI without arguments', () => {
    expect(parseCliArgs([])).toEqual({ kind: 'run' });
  });

  it.each(['--help', '-h'])('recognizes %s', (argument) => {
    expect(parseCliArgs([argument])).toEqual({ kind: 'help' });
  });

  it.each(['--version', '-v'])('recognizes %s', (argument) => {
    expect(parseCliArgs([argument])).toEqual({ kind: 'version' });
  });

  it('rejects unsupported arguments', () => {
    expect(parseCliArgs(['--unknown'])).toEqual({
      kind: 'error',
      message: 'Unknown argument: --unknown'
    });
  });

  it('parses a direct headless task without upgrading permissions', () => {
    expect(
      parseCliArgs([
        'exec',
        'inspect the repository',
        '--json',
        '--mode',
        'auto'
      ])
    ).toEqual({
      kind: 'exec',
      request: {
        schemaVersion: 1,
        input: {
          source: 'argument',
          task: 'inspect the repository'
        },
        mode: 'auto',
        permission: 'default',
        json: true
      }
    });
  });

  it('parses stdin, cwd, session, and explicit permission options', () => {
    expect(
      parseCliArgs([
        'exec',
        '--stdin',
        '--json',
        '--cwd',
        '/workspace',
        '--session',
        'session-1',
        '--permission',
        'classifier'
      ])
    ).toMatchObject({
      kind: 'exec',
      request: {
        input: { source: 'stdin' },
        cwd: '/workspace',
        sessionId: 'session-1',
        permission: 'classifier'
      }
    });
  });

  it.each([
    [['exec', 'task'], 'exec currently requires --json'],
    [
      ['exec', 'task', '--stdin', '--json'],
      'use either a task argument or --stdin, not both'
    ],
    [
      ['exec', '--json'],
      'exec requires a task argument or --stdin'
    ],
    [
      ['exec', 'task', '--json', '--permission', 'unsafe'],
      'Unsupported permission: unsafe'
    ]
  ])('rejects invalid headless args: %s', (args, message) => {
    expect(parseCliArgs(args)).toEqual({ kind: 'error', message });
  });

  it('shows dedicated exec help', () => {
    expect(parseCliArgs(['exec', '--help'])).toEqual({
      kind: 'exec-help'
    });
    expect(formatExecHelp()).toContain('--permission');
  });

  it('parses safe-by-default migration commands', () => {
    expect(parseCliArgs(['migrate'])).toEqual({
      kind: 'migrate',
      request: { apply: false }
    });
    expect(
      parseCliArgs(['migrate', '--apply', '--home', '/tmp/user'])
    ).toEqual({
      kind: 'migrate',
      request: { apply: true, homeDir: '/tmp/user' }
    });
    expect(parseCliArgs(['migrate', '--help'])).toEqual({
      kind: 'migrate-help'
    });
    expect(
      parseCliArgs(['migrate', '--apply', '--dry-run'])
    ).toEqual({
      kind: 'error',
      message: 'use either --apply or --dry-run, not both'
    });
    expect(formatMigrateHelp()).toContain('Plan only; this is the default');
  });
});

describe('formatCliHelp', () => {
  it('documents the executable and metadata flags', () => {
    const help = formatCliHelp();
    expect(help).toContain('kross');
    expect(help).toContain('--help');
    expect(help).toContain('--version');
    expect(help).toContain('kross migrate');
  });
});
