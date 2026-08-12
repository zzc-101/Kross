import { describe, expect, it } from 'vitest';

import { workAgentV2Migration } from './001_work_agent_v2';
import { sourceArtifactBlobMigration } from './002_source_artifact_blob';
import { connectorsSchedulesMigration } from './003_connectors_schedules';

describe('Work Agent PostgreSQL migration', () => {
  it('creates every P1 tenant-owned resource and tenant-scoped foreign keys', () => {
    for (const table of [
      'organizations', 'organization_memberships', 'projects', 'sources', 'task_sources',
      'tasks', 'task_messages', 'runs', 'run_events', 'approvals', 'artifacts',
      'audit_events', 'idempotency_keys', 'run_leases', 'worker_run_tokens'
    ]) {
      expect(workAgentV2Migration).toContain(`CREATE TABLE ${table}`);
    }
    expect(workAgentV2Migration.match(/FOREIGN KEY \(organization_id,/g)?.length).toBeGreaterThanOrEqual(12);
  });

  it('puts concurrency, replay, approval and idempotency invariants in PostgreSQL', () => {
    expect(workAgentV2Migration).toMatch(/CREATE UNIQUE INDEX runs_one_active_per_task[\s\S]+WHERE status IN/);
    expect(workAgentV2Migration).toContain('UNIQUE (run_id, generation, seq)');
    expect(workAgentV2Migration).toContain("CHECK ((status IN ('approved','rejected')) = (decided_at IS NOT NULL))");
    expect(workAgentV2Migration).toContain('CHECK ((consumed_at IS NULL) = (consumption_idempotency_key IS NULL))');
    expect(workAgentV2Migration).toContain('PRIMARY KEY (organization_id, scope, idempotency_key)');
    expect(workAgentV2Migration).toContain('CREATE INDEX run_leases_claimable');
    expect(workAgentV2Migration).toContain("token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$')");
    expect(workAgentV2Migration).not.toMatch(/worker_run_tokens[\s\S]*\btoken\s+text\b/);
  });

  it('does not contain SQLite or Docker control-plane semantics', () => {
    expect(workAgentV2Migration.toLowerCase()).not.toContain('sqlite');
    expect(workAgentV2Migration.toLowerCase()).not.toContain('workspace_registry');
  });
});

describe('Source/Artifact Blob migration', () => {
  it('adds idempotent reservation and pending-to-ready storage constraints', () => {
    expect(sourceArtifactBlobMigration).toContain('artifacts_reserve_idempotency');
    expect(sourceArtifactBlobMigration).toContain('artifacts_pending_upload_metadata');
    expect(sourceArtifactBlobMigration).toContain('upload_blob_key IS NULL AND blob_key IS NOT NULL');
  });
});

describe('Connector/Schedule migration', () => {
  it('stores credential handles, fixed safe policies and idempotent occurrences', () => {
    expect(connectorsSchedulesMigration).toContain('credential_handle text');
    expect(connectorsSchedulesMigration).not.toMatch(/password|refresh_token|client_secret/i);
    expect(connectorsSchedulesMigration).toContain("CHECK (concurrency_policy = 'skip')");
    expect(connectorsSchedulesMigration).toContain("CHECK (external_action_policy = 'draft_only')");
    expect(connectorsSchedulesMigration).toContain('UNIQUE (organization_id, schedule_id, scheduled_for)');
  });
});
