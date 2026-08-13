import { describe, expect, it } from 'vitest';

import { WorkApiClient } from './apiClient';

describe('WorkApiClient', () => {
  it('sends cookie identity, tenant boundary and idempotency header', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new WorkApiClient({
      baseUrl: 'https://work.test', devUserId: 'user-1',
      fetch: async (input, init) => {
        calls.push({ url: String(input), init });
        return jsonResponse(taskRecord());
      }
    });
    client.selectOrganization('org-1');

    await client.createTask('project-1', { type: 'general', title: '调研', objective: '形成结论' });

    const headers = new Headers(calls[0]?.init?.headers);
    expect(calls[0]?.url).toBe('https://work.test/api/v2/projects/project-1/tasks');
    expect(calls[0]?.init?.credentials).toBe('include');
    expect(headers.get('x-kross-user-id')).toBe('user-1');
    expect(headers.get('x-kross-organization-id')).toBe('org-1');
    expect(headers.get('idempotency-key')).toBeTruthy();
    expect(headers.has('authorization')).toBe(false);
  });

  it('normalizes the temporary server skeleton into a strict Protocol v2 task', async () => {
    const client = new WorkApiClient({
      baseUrl: 'https://work.test',
      fetch: async () => jsonResponse({ items: [taskRecord()] })
    });
    client.selectOrganization('org-1');

    await expect(client.listTasks('project-1')).resolves.toEqual([
      expect.objectContaining({ id: 'task-1', messageCount: 0, objectivePreview: '形成结论' })
    ]);
  });

  it('normalizes an unpaginated empty server collection', async () => {
    const client = new WorkApiClient({
      baseUrl: 'https://work.test',
      fetch: async () => jsonResponse({ items: [] })
    });
    client.selectOrganization('org-1');

    await expect(client.listSources('project-1')).resolves.toEqual([]);
  });

  it('uploads a Source through reservation, signed PUT and completion', async () => {
    const calls: string[] = [];
    const source = sourceRecord('uploading');
    const client = new WorkApiClient({
      baseUrl: 'https://work.test',
      fetch: async (input) => {
        const url = String(input); calls.push(url);
        if (url === 'https://blob.test/upload') return new Response(null, { status: 200 });
        if (url.endsWith('/sources/uploads')) return jsonResponse({
          ...source,
          upload: { method: 'PUT', url: 'https://blob.test/upload', headers: [{ name: 'content-type', value: 'text/plain' }], expiresAt: '2026-08-12T01:00:00.000Z' }
        });
        return jsonResponse({ ...source, status: 'ready', size_bytes: 5 });
      }
    });
    client.selectOrganization('org-1');

    await expect(client.uploadSource('project-1', new File(['hello'], 'notes.txt', { type: 'text/plain' })))
      .resolves.toMatchObject({ id: 'source-1', status: 'ready', sizeBytes: 5 });
    expect(calls).toEqual([
      'https://work.test/api/v2/projects/project-1/sources/uploads',
      'https://blob.test/upload',
      'https://work.test/api/v2/sources/source-1/complete'
    ]);
  });

  it('rejects malformed database Source rows before UI state', async () => {
    const client = new WorkApiClient({
      baseUrl: 'https://work.test',
      fetch: async () => jsonResponse({ items: [{ ...sourceRecord('ready'), organization_id: '../escape' }] })
    });
    client.selectOrganization('org-1');
    await expect(client.listSources('project-1')).rejects.toThrow();
  });

  it('rejects malformed payloads instead of leaking unchecked JSON into UI state', async () => {
    const client = new WorkApiClient({
      baseUrl: 'https://work.test',
      fetch: async () => jsonResponse({ items: [{ id: '../bad' }] })
    });
    client.selectOrganization('org-1');
    await expect(client.listTasks('project-1')).rejects.toThrow('Protocol v2');
  });

  it('submits an approval decision with an idempotency key and decodes the server row', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new WorkApiClient({
      baseUrl: 'https://work.test', devUserId: 'user-1',
      fetch: async (input, init) => {
        calls.push({ url: String(input), init });
        return jsonResponse(approvalRecord('rejected'));
      }
    });
    client.selectOrganization('org-1');

    await expect(client.decideApproval('approval-1', 'rejected', '目标不正确'))
      .resolves.toMatchObject({ id: 'approval-1', status: 'rejected' });

    const headers = new Headers(calls[0]?.init?.headers);
    expect(calls[0]?.url).toBe('https://work.test/api/v2/approvals/approval-1/decision');
    expect(headers.get('idempotency-key')).toBeTruthy();
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      decision: 'rejected', reason: '目标不正确'
    });
  });
});

function taskRecord() {
  return {
    id: 'task-1', organizationId: 'org-1', projectId: 'project-1', type: 'general',
    status: 'open', title: '调研', objective: '形成结论', constraints: [],
    acceptanceCriteria: [], createdBy: 'user-1',
    createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:00:00.000Z'
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function approvalRecord(status: 'pending' | 'approved' | 'rejected') {
  return {
    id: 'approval-1', organization_id: 'org-1', project_id: 'project-1',
    task_id: 'task-1', run_id: 'run-1', kind: 'external_action', scope: 'run',
    risk_level: 'critical', action_preview: '向外部系统提交表单', status,
    requested_at: '2026-08-12T00:00:00.000Z', expires_at: null,
    decided_at: status === 'pending' ? null : '2026-08-12T00:01:00.000Z',
    decided_by: status === 'pending' ? null : 'user-1',
    decision_idempotency_key: status === 'pending' ? null : 'decision-1'
  };
}

function sourceRecord(status: 'uploading' | 'ready') {
  return {
    id: 'source-1', organization_id: 'org-1', project_id: 'project-1', task_id: null,
    kind: 'upload', scope: 'project', status, display_name: 'notes.txt',
    mime_type: 'text/plain', size_bytes: status === 'ready' ? 5 : null,
    previous_source_id: null, created_by: 'user-1', created_at: '2026-08-12T00:00:00.000Z'
  };
}
