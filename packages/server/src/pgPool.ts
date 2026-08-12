import type { SqlPool } from './database';

/** Runtime-only pg loading keeps repositories mockable and free of pg-specific types. */
export async function createPgPool(connectionString: string): Promise<SqlPool> {
  const packageName = 'pg';
  const pg = await import(packageName) as { Pool: new (options: { connectionString: string }) => SqlPool };
  return new pg.Pool({ connectionString });
}
