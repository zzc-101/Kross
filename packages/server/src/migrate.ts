import { migrateServerDatabase } from './migrations';
import { PostgresDatabase } from './database';
import { createPgPool } from './pgPool';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('缺少 DATABASE_URL');
const pool = await createPgPool(databaseUrl);
const database = new PostgresDatabase(pool);
try {
  await migrateServerDatabase(database);
} finally {
  await database.close();
}
