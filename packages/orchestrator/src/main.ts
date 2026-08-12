import { DockerBackend } from './dockerBackend';
import { createOrchestratorHttpServer } from './httpService';
import { OrchestratorService } from './orchestratorService';
import { ScopeAuthorizer } from './authorization';

const serviceToken = process.env.KROSS_ORCHESTRATOR_SERVICE_TOKEN;
if (!serviceToken) throw new Error('缺少 KROSS_ORCHESTRATOR_SERVICE_TOKEN');

const port = Number(process.env.PORT ?? 8790);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error('PORT 无效');
}

const backend = new DockerBackend(undefined, {
  image: process.env.KROSS_WORKER_IMAGE,
  managerId: process.env.KROSS_ORCHESTRATOR_MANAGER_ID,
  workerUser: process.env.KROSS_WORKER_USER,
  controlPlaneContainer: process.env.KROSS_CONTROL_PLANE_CONTAINER
});
const service = new OrchestratorService(backend, new ScopeAuthorizer());
const server = createOrchestratorHttpServer(service, { serviceToken });
server.listen(port, '0.0.0.0', () => {
  process.stdout.write(`Kross Orchestrator listening on :${port}\n`);
});
