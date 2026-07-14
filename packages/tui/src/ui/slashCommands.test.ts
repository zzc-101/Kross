import { describe, expect, it } from 'vitest';

import * as slashModule from './slashCommands';

const { filterSlashCommands, formatSlashHelp, listSlashCommands } = slashModule;

describe('slashCommands', () => {
  it('lists core commands with descriptions', () => {
    const slashCommands = listSlashCommands();
    expect(slashCommands.some((command) => command.name === '/help')).toBe(true);
    expect(slashCommands.some((command) => command.name === '/perm')).toBe(true);
    expect(slashCommands.some((command) => command.name === '/lang')).toBe(true);
    expect(formatSlashHelp()).toContain('/context');
    expect(formatSlashHelp()).toContain('/resume [sessionId]');
    expect(formatSlashHelp()).toContain('/lang zh|en');
  });

  it('filters by prefix', () => {
    expect(filterSlashCommands('/').map((command) => command.name)).toEqual([
      '/help',
      '/settings',
      '/model',
      '/mode',
      '/resume',
      '/lang',
      '/status',
      '/context'
    ]);
    expect(filterSlashCommands('/mo').map((command) => command.name)).toEqual([
      '/model',
      '/mode'
    ]);
    expect(listSlashCommands().some((command) => command.name === '/model')).toBe(
      true
    );
    expect(filterSlashCommands('/perm').map((command) => command.name)).toEqual(['/perm']);
    expect(filterSlashCommands('/lang').map((command) => command.name)).toEqual([
      '/lang'
    ]);
    expect(filterSlashCommands('/app').map((command) => command.name)).toEqual([]);
    expect(
      filterSlashCommands('/app', { hasPendingCrossRepoPlan: true }).map(
        (command) => command.name
      )
    ).toEqual(['/approve']);
    expect(filterSlashCommands('help')).toEqual([]);
  });

  it('builds a limited suggestion result with hidden count and categories', () => {
    const getSuggestions = (slashModule as any).getSlashCommandSuggestions;
    expect(getSuggestions).toBeTypeOf('function');
    if (typeof getSuggestions !== 'function') {
      return;
    }

    const result = getSuggestions('/', { limit: 8 });
    expect(result.commands).toHaveLength(8);
    expect(result.hiddenCount).toBe(4);
    expect(result.commands.map((command: any) => command.category)).toEqual([
      'common',
      'common',
      'common',
      'common',
      'common',
      'settings',
      'inspection',
      'inspection'
    ]);
  });
});
