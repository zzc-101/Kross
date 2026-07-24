import { describe, expect, it } from 'vitest';

import {
  filterWebSlashCommands,
  parseWebSlashCommand
} from './slashCommands';

describe('filterWebSlashCommands', () => {
  it('suggests commands while the first slash token is being typed', () => {
    expect(
      filterWebSlashCommands('/m').map((command) => command.name)
    ).toEqual(['/mode', '/model']);
  });

  it('closes suggestions after an argument starts', () => {
    expect(filterWebSlashCommands('/mode ')).toEqual([]);
  });

  it('closes suggestions when a no-argument command is complete', () => {
    expect(filterWebSlashCommands('/help')).toEqual([]);
  });
});

describe('parseWebSlashCommand', () => {
  it('parses a command and its argument', () => {
    expect(parseWebSlashCommand('/think high')).toEqual({
      command: expect.objectContaining({ id: 'think' }),
      argument: 'high'
    });
  });

  it('leaves unknown commands unresolved', () => {
    expect(parseWebSlashCommand('/unknown')).toEqual({
      command: undefined,
      argument: ''
    });
  });

  it('includes Core-backed context and inspection commands', () => {
    expect(parseWebSlashCommand('/compact 保留决策')).toEqual({
      command: expect.objectContaining({ id: 'compact' }),
      argument: '保留决策'
    });
    expect(parseWebSlashCommand('/undo run-1')).toEqual({
      command: expect.objectContaining({ id: 'undo' }),
      argument: 'run-1'
    });
    expect(parseWebSlashCommand('/skills').command?.id).toBe('skills');
  });
});
