import { WorkerService } from './workerService';
import { WorkerWsServer } from './wsServer';

const workspaceId = process.env.KROSS_WORKSPACE_ID;
const workspaceRoot = process.env.KROSS_WORKSPACE_ROOT ?? '/workspace/repo';
const krossHome = process.env.KROSS_HOME ?? '/workspace/.kross';
const internalToken = process.env.KROSS_WORKER_TOKEN;

if (!workspaceId || !internalToken) {
  throw new Error('KROSS_WORKSPACE_ID 和 KROSS_WORKER_TOKEN 必须配置');
}

const service = new WorkerService({
  workspaceId,
  workspaceRoot,
  krossHome,
  env: process.env
});
const server = new WorkerWsServer(service, {
  internalToken,
  port: Number(process.env.PORT ?? 8788)
});

await server.listen();
console.log(`Kross worker ${workspaceId} listening`);

const shutdown = async () => {
  await server.close();
  process.exit(0);
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
