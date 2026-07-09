import { describe, expect, it } from 'vitest';

import { filterSlashCommands, formatSlashHelp, slashCommands } from './slashCommands';

describe('slashCommands', () => {
  it('lists core commands with descriptions', () => {
    expect(slashCommands.some((command) => command.name === '/help')).toBe(true);
    expect(slashCommands.some((command) => command.name === '/perm')).toBe(true);
    expect(formatSlashHelp()).toContain('/context');
  });

  it('filters by prefix', () => {
    expect(filterSlashCommands('/').map((command) => command.name)).toContain('/mode');
    expect(filterSlashCommands('/mo').map((command) => command.name)).toEqual(['/mode']);
    expect(filterSlashCommands('/perm').map((command) => command.name)).toEqual(['/perm']);
    expect(filterSlashCommands('help')).toEqual([]);
  });
});
