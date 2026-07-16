import { describe, expect, it } from 'vitest';

import { formatCliHelp, parseCliArgs } from './cli';

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
});

describe('formatCliHelp', () => {
  it('documents the executable and metadata flags', () => {
    const help = formatCliHelp();
    expect(help).toContain('kross');
    expect(help).toContain('--help');
    expect(help).toContain('--version');
  });
});
