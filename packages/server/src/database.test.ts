import { describe, expect, it, vi } from 'vitest';

import { PostgresDatabase, type SqlClient, type SqlPool } from './database';

describe('PostgresDatabase', () => {
  it('commits successful transactions and always releases the client', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const release = vi.fn();
    const client = { query, release } as SqlClient;
    const database = new PostgresDatabase({ connect: async () => client, query, end: async () => undefined } as SqlPool);
    await expect(database.transaction(async () => 42)).resolves.toBe(42);
    expect((query.mock.calls as unknown as [string][]).map(([sql]) => sql)).toEqual(['BEGIN', 'COMMIT']);
    expect(release).toHaveBeenCalledOnce();
  });

  it('rolls back failed transactions', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const client = { query, release: vi.fn() } as SqlClient;
    const database = new PostgresDatabase({ connect: async () => client, query, end: async () => undefined } as SqlPool);
    await expect(database.transaction(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect((query.mock.calls as unknown as [string][]).map(([sql]) => sql)).toEqual(['BEGIN', 'ROLLBACK']);
  });
});
