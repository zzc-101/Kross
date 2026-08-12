import { ApiService } from './apiService';
import { PostgresDatabase, type SqlPool } from './database';
import { DevIdentityProvider, OrganizationContextResolver } from './identity';
import {
  ApprovalRepository,
  ArtifactRepository,
  AuditEventRepository,
  IdempotencyRepository,
  MembershipRepository,
  OrganizationRepository,
  ProjectRepository,
  RunEventRepository,
  RunRepository,
  SourceRepository,
  TaskMessageRepository,
  TaskRepository
} from './repositories';
import { SseService } from './sse';
import { PostgresWorkerControlService } from './workerControl';

export function createServerApplication(pool: SqlPool, options: { devIdentityEnabled: boolean }) {
  const database = new PostgresDatabase(pool);
  const memberships = new MembershipRepository(database);
  const organizations = new OrganizationRepository(database);
  const projects = new ProjectRepository(database);
  const tasks = new TaskRepository(database);
  const runs = new RunRepository(database, database);
  const events = new RunEventRepository(database);
  const idempotency = new IdempotencyRepository(database);
  const approvals = new ApprovalRepository(database);
  const artifacts = new ArtifactRepository(database);
  const auditEvents = new AuditEventRepository(database);
  const sources = new SourceRepository(database);
  const taskMessages = new TaskMessageRepository(database);
  const sse = new SseService(events);
  const workerControl = new PostgresWorkerControlService(database, database);
  const api = new ApiService({
    identity: new DevIdentityProvider(options.devIdentityEnabled),
    contexts: new OrganizationContextResolver(memberships),
    memberships, organizations, projects, tasks, runs, events, idempotency, sse
  });
  return {
    database,
    api,
    workerControl,
    repositories: {
      memberships, organizations, projects, tasks, taskMessages, runs, events,
      approvals, artifacts, sources, auditEvents, idempotency
    }
  };
}
