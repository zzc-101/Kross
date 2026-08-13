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
import { HmacSignedBlobUrlProvider, LocalFileBlobStore } from './blobStore';
import { SourceArtifactService } from './sourceArtifactService';
import { HttpOrchestratorClient } from './orchestratorClient';
import { RunScheduler } from './runScheduler';
import { ConnectorService, ScheduleService } from './connectorSchedule';
import { ApprovalService } from './approvalService';
import { AdminService } from './adminService';

export function createServerApplication(pool: SqlPool, options: {
  devIdentityEnabled: boolean;
  blobRoot?: string;
  blobSigningSecret?: string;
  publicBaseUrl?: string;
  orchestratorUrl?: string;
  orchestratorServiceToken?: string;
  schedulerOwner?: string;
}) {
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
  const blobStore = new LocalFileBlobStore(options.blobRoot ?? '.kross-cloud/blobs');
  const signedBlobUrls = new HmacSignedBlobUrlProvider(
    options.blobSigningSecret ?? 'kross-development-blob-signing-secret-change-me',
    options.publicBaseUrl ?? 'http://127.0.0.1:8787'
  );
  const sourceArtifacts = new SourceArtifactService(database, database, blobStore, signedBlobUrls);
  const approvalService = new ApprovalService(database, database);
  const admin = new AdminService({ sql: database, transactions: database, contexts: new OrganizationContextResolver(memberships), bootstrapEnabled: options.devIdentityEnabled });
  const connectors = new ConnectorService(database);
  const schedules = new ScheduleService(database, database);
  const sse = new SseService(events);
  const workerControl = new PostgresWorkerControlService(database, database, { sourceArtifacts, approvals: approvalService, blobStore });
  const orchestrator = options.orchestratorUrl && options.orchestratorServiceToken
    ? new HttpOrchestratorClient(options.orchestratorUrl, options.orchestratorServiceToken)
    : undefined;
  const scheduler = orchestrator
    ? new RunScheduler(database, database, workerControl, orchestrator, {
        owner: options.schedulerOwner ?? 'kross-server',
        publicBaseUrl: options.publicBaseUrl ?? 'http://127.0.0.1:8787',
        onError: (error) => process.stderr.write(`Run scheduler error: ${error instanceof Error ? error.message : String(error)}\n`)
      })
    : undefined;
  const api = new ApiService({
    identity: new DevIdentityProvider(options.devIdentityEnabled),
    contexts: new OrganizationContextResolver(memberships),
    memberships, organizations, projects, tasks, taskMessages, runs, events, idempotency, sse,
    sources, artifacts, sourceArtifacts, connectors, schedules, approvalService,
    ...(scheduler === undefined ? {} : { runCancellation: scheduler })
  });
  return {
    database,
    api,
    admin,
    workerControl,
    blobStore,
    signedBlobUrls,
    sourceArtifacts,
    connectors,
    schedules,
    approvalService,
    scheduler,
    repositories: {
      memberships, organizations, projects, tasks, taskMessages, runs, events,
      approvals, artifacts, sources, auditEvents, idempotency
    }
  };
}
