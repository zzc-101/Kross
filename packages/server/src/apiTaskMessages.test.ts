import { describe, expect, it, vi } from 'vitest';

import { ApiService, type ApiDependencies } from './apiService';
import { TaskMessageRepository } from './repositories';

const identity={userId:'member-user',displayName:'Member'};
const context={organizationId:'org-a',userId:'member-user',membershipId:'membership-a',role:'member' as const};

function api() {
  const resolve=vi.fn(async()=>context);
  const append=vi.fn();
  const service=new ApiService({ contexts:{resolve}, taskMessages:{append} } as unknown as ApiDependencies);
  return {service,resolve,append};
}

describe('Task Composer API',()=>{
  it('serializes message block arrays as JSON for PostgreSQL jsonb', async () => {
    const query = vi.fn(async (_text: string, values: readonly unknown[]) => ({
      rows: [{
        id: values[0], organization_id: 'org-a', project_id: 'project-a', task_id: 'task-a',
        role: 'user', content: JSON.parse(String(values[5])), created_by: 'member-user',
        created_at: '2026-08-13T00:00:00.000Z'
      }], rowCount: 1
    }));
    const repository = new TaskMessageRepository({ query } as never);

    await repository.append(context, 'task-a', 'user', [{ type: 'text', text: '继续' }]);

    expect(query.mock.calls[0]?.[1]?.[5]).toBe('[{"type":"text","text":"继续"}]');
  });

  it('requires a valid idempotency key before appending',async()=>{
    const {service,resolve,append}=api();
    await expect(service.appendTaskMessage(identity,'org-a','task-a',{content:[{type:'text',text:'继续'}]},undefined))
      .rejects.toMatchObject({code:'idempotency_key_required',statusCode:400});
    expect(resolve).toHaveBeenCalledWith(identity,'org-a','task.create');
    expect(append).not.toHaveBeenCalled();
  });

  it('strictly rejects empty or unknown message content',async()=>{
    const {service,append}=api();
    await expect(service.appendTaskMessage(identity,'org-a','task-a',{content:[{type:'text',text:''}],secret:'nope'},'message-key-12345678'))
      .rejects.toMatchObject({code:'invalid_request',statusCode:400});
    expect(append).not.toHaveBeenCalled();
  });
});
