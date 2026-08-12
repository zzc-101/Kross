import { createServerApplication } from './app';
import { createApiHttpServer } from './httpServer';
import { createPgPool } from './pgPool';
import { loadServerRuntimeConfig } from './runtimeConfig';

const config = loadServerRuntimeConfig(process.env);
const pool = await createPgPool(config.databaseUrl);
const application = createServerApplication(pool, { devIdentityEnabled: config.devIdentityEnabled });
const server = createApiHttpServer({ api: application.api, workerControl: application.workerControl });

server.listen(config.port, () => {
  process.stdout.write(`Kross control plane listening on :${config.port}\n`);
});

async function shutdown(): Promise<void> {
  server.close();
  await application.database.close();
}
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
