import { request } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import type { ApiService } from './apiService';
import { createApiHttpServer } from './httpServer';
import type { WorkerControlService } from './workerControl';
import type { AdminService } from './adminService';

describe('HTTP v2 control plane', () => {
  const servers: ReturnType<typeof createApiHttpServer>[] = [];
  afterEach(() => { for (const server of servers.splice(0)) server.close(); });

  it('serves an unauthenticated control-plane health endpoint', async () => {
    const server = createApiHttpServer({ api: {} as ApiService });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const response = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
      const outgoing = request({ host: '127.0.0.1', port: address.port, path: '/health' }, (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.on('end', () => resolve({ status: incoming.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      });
      outgoing.on('error', reject);
      outgoing.end();
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ status: 'ok', service: 'kross-control-plane' });
  });

  it('wires authenticated Protocol v2 worker events before public identity', async () => {
    let receivedToken: string | undefined;
    const workerControl = {
      appendEvent: async (token, envelope) => {
        receivedToken = token;
        return {
          protocolVersion: 2, type: 'worker.event_ack', messageId: 'ack_a',
          sentAt: '2026-08-12T00:00:01.000Z', runId: envelope.runId,
          generation: envelope.generation, acceptedThroughSeq: envelope.seq
        };
      }
    } as WorkerControlService;
    const server = createApiHttpServer({ api: {} as ApiService, workerControl });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const result = await fetch(`http://127.0.0.1:${address.port}/internal/v2/workers/events`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret-run-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: 2, type: 'worker.event', messageId: 'message_a',
        sentAt: '2026-08-12T00:00:00.000Z',
        envelope: {
          protocolVersion: 2, runId: 'run_a', generation: 1, seq: 1,
          timestamp: '2026-08-12T00:00:00.000Z',
          event: { type: 'run.progress', phase: 'executing', message: 'Working' }
        }
      })
    });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ type: 'worker.event_ack', acceptedThroughSeq: 1 });
    expect(receivedToken).toBe('secret-run-token');
  });

  it('does not silently accept internal traffic without a control implementation', async () => {
    const server = createApiHttpServer({ api: {} as ApiService });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const result = await fetch(`http://127.0.0.1:${address.port}/internal/v2/workers/register`, {
      method: 'POST', headers: { authorization: 'Bearer token' }, body: '{}'
    });
    expect(result.status).toBe(503);
  });

  it('routes tenant-scoped admin member queries after authentication', async () => {
    const api = { authenticate: async () => ({ userId: 'owner-user', displayName: 'Owner' }) } as unknown as ApiService;
    const listMembers = async (_identity: unknown, organizationId: string) => ({ items: [], page: 1, pageSize: 20, total: organizationId === 'org-a' ? 0 : 1 });
    const admin = { listMembers } as unknown as AdminService;
    const server = createApiHttpServer({ api, admin }); servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const result = await fetch(`http://127.0.0.1:${address.port}/api/v2/admin/members`, {
      headers: { 'x-kross-user-id': 'owner-user', 'x-kross-organization-id': 'org-a' }
    });
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ items: [], page: 1, pageSize: 20, total: 0 });
  });

  it('allows bootstrap without an organization header but requires admin implementation', async () => {
    const api = { authenticate: async () => ({ userId: 'first-user', displayName: 'First' }) } as unknown as ApiService;
    const bootstrap = async () => ({ organization: { id: 'org-first' }, membership: { role: 'owner' } });
    const admin = { bootstrap } as unknown as AdminService;
    const server = createApiHttpServer({ api, admin }); servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const result = await fetch(`http://127.0.0.1:${address.port}/api/v2/admin/bootstrap`, {
      method: 'POST', headers: { 'x-kross-user-id': 'first-user', 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId: 'org-first', slug: 'first', name: 'First' })
    });
    expect(result.status).toBe(201);
    expect(await result.json()).toMatchObject({ organization: { id: 'org-first' }, membership: { role: 'owner' } });
  });

  it('routes task Composer messages with tenant scope and idempotency key', async () => {
    let received: unknown;
    const api = {
      authenticate: async () => ({ userId: 'member-user', displayName: 'Member' }),
      appendTaskMessage: async (_identity: unknown, organizationId: string, taskId: string, body: unknown, key: string | undefined) => {
        received={organizationId,taskId,body,key}; return {id:'message-a'};
      }
    } as unknown as ApiService;
    const server=createApiHttpServer({api}); servers.push(server);
    await new Promise<void>((resolve)=>server.listen(0,'127.0.0.1',resolve));
    const address=server.address(); if(!address||typeof address==='string') throw new Error('Expected TCP address');
    const result=await fetch(`http://127.0.0.1:${address.port}/api/v2/tasks/task-a/messages`,{method:'POST',headers:{'x-kross-user-id':'member-user','x-kross-organization-id':'org-a','idempotency-key':'message-key-12345678','content-type':'application/json'},body:JSON.stringify({content:[{type:'text',text:'继续执行'}]})});
    expect(result.status).toBe(201);
    expect(received).toEqual({organizationId:'org-a',taskId:'task-a',body:{content:[{type:'text',text:'继续执行'}]},key:'message-key-12345678'});
  });
});
