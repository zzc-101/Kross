import type { SqlExecutor, TransactionRunner } from '../database';
import { workAgentV2Migration } from './001_work_agent_v2';
import { sourceArtifactBlobMigration } from './002_source_artifact_blob';
import { connectorsSchedulesMigration } from './003_connectors_schedules';
import { adminConsoleMigration } from './004_admin_console';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const serverMigrations: readonly Migration[] = [
  { version: 1, name: 'work_agent_v2', sql: workAgentV2Migration },
  { version: 2, name: 'source_artifact_blob', sql: sourceArtifactBlobMigration },
  { version: 3, name: 'connectors_schedules', sql: connectorsSchedulesMigration },
  { version: 4, name: 'admin_console', sql: adminConsoleMigration }
];

export async function migrateServerDatabase(executor: SqlExecutor & TransactionRunner): Promise<void> {
  await executor.query(`CREATE TABLE IF NOT EXISTS kross_server_migrations (
    version integer PRIMARY KEY,
    name text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  for (const migration of serverMigrations) {
    const applied = await executor.query<{ version: number }>(
      'SELECT version FROM kross_server_migrations WHERE version = $1',
      [migration.version]
    );
    if (applied.rows.length > 0) continue;
    await executor.transaction(async (client) => {
      await client.query(migration.sql);
      await client.query(
        'INSERT INTO kross_server_migrations (version, name) VALUES ($1, $2)',
        [migration.version, migration.name]
      );
    });
  }
}
