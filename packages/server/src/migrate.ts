import { migrateServerDatabase } from './migrations';
import { PostgresDatabase } from './database';
import { createPgPool } from './pgPool';
import { loadServerRuntimeConfig } from './runtimeConfig';

const config = loadServerRuntimeConfig(process.env);
const pool = await createPgPool(config.databaseUrl);
const database = new PostgresDatabase(pool);
try {
  await migrateServerDatabase(database);
} finally {
  await database.close();
}
