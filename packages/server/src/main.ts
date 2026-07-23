import { join } from 'node:path';

import { DockerOrchestrator } from './containerOrchestrator';
import { GatewayService, generateAccessToken } from './gatewayService';
import { GatewayHttpServer } from './httpServer';
import { IdleWorkspaceReaper } from './idleReaper';
import { PushService } from './pushService';
import { RuntimeConfigStore } from './runtimeConfig';
import { WorkspaceRegistry } from './workspaceRegistry';

const dataDir = process.env.KROSS_SERVER_DATA ?? '/var/lib/kross-server';
const accessToken = process.env.KROSS_ACCESS_TOKEN ?? generateAccessToken();
if (!process.env.KROSS_ACCESS_TOKEN) {
  console.warn(`临时访问令牌（重启后变化）: ${accessToken}`);
}
const registry = new WorkspaceRegistry(join(dataDir, 'workspaces.json'));
const runtimeConfig = new RuntimeConfigStore(
  join(dataDir, 'provider.json')
);
const orchestrator = new DockerOrchestrator(undefined, {
  image: process.env.KROSS_WORKER_IMAGE,
  network: process.env.KROSS_DOCKER_NETWORK,
  managerId: process.env.KROSS_MANAGER_ID,
  workerEnv: runtimeConfig.workerEnvironment(),
  limits: {
    memoryBytes: Number(process.env.KROSS_WORKSPACE_MEMORY ?? 4 * 1024 ** 3),
    nanoCpus: Number(process.env.KROSS_WORKSPACE_NANO_CPUS ?? 2_000_000_000),
    pidsLimit: Number(process.env.KROSS_WORKSPACE_PIDS ?? 512)
  }
});
const pushService =
  process.env.KROSS_VAPID_PUBLIC_KEY && process.env.KROSS_VAPID_PRIVATE_KEY
    ? new PushService({
        path: join(dataDir, 'push-subscriptions.json'),
        subject: process.env.KROSS_VAPID_SUBJECT ?? 'mailto:admin@localhost',
        publicKey: process.env.KROSS_VAPID_PUBLIC_KEY,
        privateKey: process.env.KROSS_VAPID_PRIVATE_KEY
      })
    : undefined;
const gateway = new GatewayService(
  registry,
  orchestrator,
  undefined,
  pushService,
  {
    stopWorkersOnClose:
      process.env.KROSS_STOP_WORKERS_ON_SHUTDOWN !== 'false',
    runtimeConfig
  }
);
const server = new GatewayHttpServer(gateway, {
  accessToken,
  port: Number(process.env.PORT ?? 8787),
  staticDir: process.env.KROSS_WEB_DIST ?? join(process.cwd(), 'packages/web/dist'),
  allowedOrigins: process.env.KROSS_ALLOWED_ORIGINS
    ?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
});
const reaper = new IdleWorkspaceReaper(
  registry,
  orchestrator,
  Number(process.env.KROSS_IDLE_TIMEOUT_MS ?? 30 * 60_000)
);

const reconciliation = await gateway.reconcileWorkspaces();
await server.listen();
reaper.start();
console.log('Kross Cloud gateway listening', reconciliation);

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  reaper.stop();
  await server.close();
  process.exit(0);
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
