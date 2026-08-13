import { createServerApplication } from './app';
import { createApiHttpServer } from './httpServer';
import { createPgPool } from './pgPool';
import { loadServerRuntimeConfig } from './runtimeConfig';

const config = loadServerRuntimeConfig(process.env);
const pool = await createPgPool(config.databaseUrl);
const application = createServerApplication(pool, {
  devIdentityEnabled: config.devIdentityEnabled, blobRoot: config.blobRoot,
  blobSigningSecret: config.blobSigningSecret, publicBaseUrl: config.publicBaseUrl,
  orchestratorUrl: config.orchestratorUrl,
  orchestratorServiceToken: config.orchestratorServiceToken,
  schedulerOwner: config.schedulerOwner
});
const server = createApiHttpServer({
  api: application.api, admin: application.admin, workerControl: application.workerControl,
  blobStore: application.blobStore, signedBlobUrls: application.signedBlobUrls
});
let scheduleTickRunning = false;
const scheduleTimer = setInterval(() => {
  if (scheduleTickRunning) return;
  scheduleTickRunning = true;
  void application.schedules.tick()
    .catch((error: unknown) => process.stderr.write(`Schedule tick error: ${error instanceof Error ? error.message : String(error)}\n`))
    .finally(() => { scheduleTickRunning = false; });
}, 30_000);
scheduleTimer.unref();

server.listen(config.port, () => {
  process.stdout.write(`Kross control plane listening on :${config.port}\n`);
  application.scheduler?.start();
});

async function shutdown(): Promise<void> {
  clearInterval(scheduleTimer);
  application.scheduler?.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await application.database.close();
}
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
