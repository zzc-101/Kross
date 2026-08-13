import { randomUUID } from 'node:crypto';

import type { MembershipRole, OrganizationAction, OrganizationContext } from '@kross/work-domain';
import { resourceIdSchema } from '@kross/protocol';
import { z } from 'zod';

import type { SqlExecutor, TransactionRunner } from './database';
import { conflict, notFound, ServerError } from './errors';
import type { Identity } from './identity';
import { OrganizationContextResolver } from './identity';

const roleSchema = z.enum(['owner', 'admin', 'member', 'viewer']);
const membershipStatusSchema = z.enum(['invited', 'active', 'disabled']);
const statusSchema = z.enum(['active', 'disabled']);
const safeObjectSchema = z.record(z.unknown()).superRefine((value, context) => {
  const sensitive = /(^|[_-])(secret|password|token|api[_-]?key|private[_-]?key|credential)($|[_-])/i;
  const visit = (item: unknown, path: (string | number)[]): void => {
    if (Array.isArray(item)) return item.forEach((child, index) => visit(child, [...path, index]));
    if (!item || typeof item !== 'object') return;
    for (const [key, child] of Object.entries(item)) {
      if (sensitive.test(key)) context.addIssue({ code: z.ZodIssueCode.custom, path: [...path, key], message: 'Secret material is not accepted by this API' });
      visit(child, [...path, key]);
    }
  };
  visit(value, []);
});

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20)
}).strict();
const memberFilterSchema = paginationSchema.extend({ status: membershipStatusSchema.optional() }).strict();
const auditFilterSchema = paginationSchema.extend({
  action: z.string().trim().min(1).max(200).optional(),
  resourceType: z.string().trim().min(1).max(100).optional()
}).strict();
const inviteMemberSchema = z.object({
  userId: resourceIdSchema, displayName: z.string().trim().min(1).max(200), role: roleSchema.default('member')
}).strict();
const updateMemberSchema = z.object({ role: roleSchema.optional(), status: membershipStatusSchema.optional() })
  .strict().refine((value) => value.role !== undefined || value.status !== undefined, 'At least one field is required');
const approvalPolicySchema = z.object({
  requirePlanApproval: z.boolean(), requireExternalActionApproval: z.boolean(),
  minimumToolRiskRequiringApproval: z.enum(['low', 'medium', 'high', 'critical']),
  allowAdminOrganizationHighRiskApproval: z.boolean(), allowMemberHighRiskApproval: z.boolean()
}).strict();
const organizationPolicySchema = z.object({
  defaultTimezone: z.string().trim().min(1).max(200).optional(),
  dataRetentionDays: z.number().int().min(1).max(3650).nullable().optional(),
  approvalPolicy: approvalPolicySchema.optional()
}).strict().refine((value) => Object.keys(value).length > 0, 'At least one field is required');
const credentialCreateSchema = z.object({
  name: z.string().trim().min(1).max(200), provider: z.string().trim().min(1).max(100),
  handle: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/), metadata: safeObjectSchema.default({})
}).strict();
const credentialUpdateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(), status: statusSchema.optional(), metadata: safeObjectSchema.optional()
}).strict().refine((value) => Object.keys(value).length > 0, 'At least one field is required');
const modelCreateSchema = z.object({
  name: z.string().trim().min(1).max(200), provider: z.string().trim().min(1).max(100),
  model: z.string().trim().min(1).max(200), credentialHandleId: resourceIdSchema.optional(),
  configuration: safeObjectSchema.default({})
}).strict();
const modelUpdateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(), provider: z.string().trim().min(1).max(100).optional(),
  model: z.string().trim().min(1).max(200).optional(), credentialHandleId: resourceIdSchema.nullable().optional(),
  configuration: safeObjectSchema.optional(), status: statusSchema.optional()
}).strict().refine((value) => Object.keys(value).length > 0, 'At least one field is required');
const bootstrapSchema = z.object({
  organizationId: resourceIdSchema.optional(), slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  name: z.string().trim().min(1).max(200), defaultTimezone: z.string().trim().min(1).max(200).default('UTC')
}).strict();

export interface AdminServiceDependencies {
  readonly sql: SqlExecutor;
  readonly transactions: TransactionRunner;
  readonly contexts: OrganizationContextResolver;
  readonly bootstrapEnabled?: boolean;
}

export class AdminService {
  public constructor(private readonly dependencies: AdminServiceDependencies) {}

  public async bootstrap(identity: Identity, body: unknown) {
    if (!this.dependencies.bootstrapEnabled) throw new ServerError('bootstrap_disabled', 'Organization bootstrap is disabled', 403);
    const input = parse(bootstrapSchema, body);
    const organizationId=input.organizationId??randomUUID();
    return this.dependencies.transactions.transaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(480759283)`);
      const memberships = await client.query(`SELECT id FROM organization_memberships WHERE user_id=$1 LIMIT 1 FOR UPDATE`, [identity.userId]);
      if (memberships.rows[0]) throw conflict('bootstrap_not_available', 'User already has an organization membership');
      const organizations = await client.query(`SELECT id FROM organizations LIMIT 1 FOR UPDATE`);
      if (organizations.rows[0]) throw conflict('bootstrap_not_available', 'An organization already exists');
      await client.query(`INSERT INTO users (id,display_name) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET display_name=EXCLUDED.display_name`, [identity.userId, identity.displayName]);
      const approvalPolicy = { requirePlanApproval:false, requireExternalActionApproval:true, minimumToolRiskRequiringApproval:'high', allowAdminOrganizationHighRiskApproval:false, allowMemberHighRiskApproval:false };
      await client.query(`INSERT INTO organizations (id,slug,name,status,default_timezone,data_retention_days,approval_policy) VALUES ($1,$2,$3,'active',$4,90,$5)`, [organizationId,input.slug,input.name,input.defaultTimezone ?? 'UTC',approvalPolicy]);
      const membershipId=randomUUID();
      await client.query(`INSERT INTO organization_memberships (id,organization_id,user_id,role,status) VALUES ($1,$2,$3,'owner','active')`, [membershipId,organizationId,identity.userId]);
      const context: OrganizationContext={organizationId,userId:identity.userId,membershipId,role:'owner'};
      await audit(client,context,'organization.bootstrap','organization',organizationId,{slug:input.slug,name:input.name});
      return { organization:{id:organizationId,slug:input.slug,name:input.name,defaultTimezone:input.defaultTimezone ?? 'UTC'}, membership:{id:membershipId,userId:identity.userId,role:'owner',status:'active'} };
    });
  }

  public async dashboard(identity: Identity, organizationId: string) {
    const context = await this.context(identity, organizationId, 'audit.read');
    const result = await this.dependencies.sql.query(
      `SELECT
        (SELECT count(*)::integer FROM organization_memberships WHERE organization_id=$1 AND status='active') AS active_members,
        (SELECT count(*)::integer FROM projects WHERE organization_id=$1 AND status='active') AS active_projects,
        (SELECT count(*)::integer FROM runs WHERE organization_id=$1 AND status IN ('queued','provisioning','running','waiting_for_approval','cancelling')) AS active_runs,
        (SELECT count(*)::integer FROM approvals WHERE organization_id=$1 AND status='pending') AS pending_approvals,
        (SELECT count(*)::integer FROM connector_installations WHERE organization_id=$1 AND status='available') AS active_connectors`,
      [context.organizationId]
    );
    const row = result.rows[0] ?? {};
    return { counts: { activeMembers: Number(row.active_members ?? 0), activeProjects: Number(row.active_projects ?? 0), activeRuns: Number(row.active_runs ?? 0), pendingApprovals: Number(row.pending_approvals ?? 0), activeConnectors: Number(row.active_connectors ?? 0) } };
  }

  public async listMembers(identity: Identity, organizationId: string, query: unknown) {
    const context = await this.context(identity, organizationId, 'credential.manage');
    const page = parse(memberFilterSchema, query);
    const pageNumber=page.page??1, pageSize=page.pageSize??20;
    const result = await this.dependencies.sql.query(
      `SELECT m.id,m.user_id,u.display_name,m.role,m.status,m.created_at,m.updated_at,count(*) OVER()::integer AS total
       FROM organization_memberships m JOIN users u ON u.id=m.user_id
       WHERE m.organization_id=$1 AND ($2::text IS NULL OR m.status=$2)
       ORDER BY m.created_at DESC,m.id DESC LIMIT $3 OFFSET $4`,
      [context.organizationId, page.status ?? null, pageSize, (pageNumber - 1) * pageSize]
    );
    return paged(result.rows.map(mapMember), result.rows, {page:pageNumber,pageSize});
  }

  public async inviteMember(identity: Identity, organizationId: string, body: unknown) {
    const context = await this.context(identity, organizationId, 'membership.invite');
    const input = parse(inviteMemberSchema, body);
    const invitedRole=input.role??'member'; assertCanManageRole(context.role, invitedRole);
    return this.dependencies.transactions.transaction(async (client) => {
      await client.query(`INSERT INTO users (id,display_name) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET display_name=EXCLUDED.display_name`, [input.userId, input.displayName]);
      const result = await client.query(
        `INSERT INTO organization_memberships (id,organization_id,user_id,role,status)
         VALUES ($1,$2,$3,$4,'invited') RETURNING *`, [randomUUID(), context.organizationId, input.userId, invitedRole]
      ).catch((error: unknown) => { if (isUniqueViolation(error)) throw conflict('membership_exists', 'User already belongs to this organization'); throw error; });
      await audit(client, context, 'membership.invite', 'membership', String(result.rows[0]!.id), { userId: input.userId, role: invitedRole });
      return mapMember({ ...result.rows[0]!, display_name: input.displayName });
    });
  }

  public async updateMember(identity: Identity, organizationId: string, membershipId: string, body: unknown) {
    const context = await this.context(identity, organizationId, 'membership.update');
    const id = parse(resourceIdSchema, membershipId); const input = parse(updateMemberSchema, body);
    return this.dependencies.transactions.transaction(async (client) => {
      const found = await client.query(`SELECT m.*,u.display_name FROM organization_memberships m JOIN users u ON u.id=m.user_id WHERE m.organization_id=$1 AND m.id=$2 FOR UPDATE OF m`, [context.organizationId, id]);
      const target = found.rows[0]; if (!target) throw notFound('Membership');
      assertCanManageRole(context.role, target.role as MembershipRole);
      if (input.role) assertCanManageRole(context.role, input.role);
      if (target.user_id === context.userId && input.status && input.status !== 'active') throw conflict('cannot_disable_self', 'Administrators cannot disable their own membership');
      if (target.role === 'owner' && ((input.role && input.role !== 'owner') || (input.status && input.status !== 'active'))) await assertNotLastOwner(client, context.organizationId, id);
      const updated = await client.query(
        `UPDATE organization_memberships SET role=COALESCE($3,role),status=COALESCE($4,status),updated_at=now()
         WHERE organization_id=$1 AND id=$2 RETURNING *`, [context.organizationId, id, input.role ?? null, input.status ?? null]
      );
      await audit(client, context, 'membership.update', 'membership', id, input);
      return mapMember({...updated.rows[0]!,display_name:target.display_name});
    });
  }

  public async removeMember(identity: Identity, organizationId: string, membershipId: string) {
    const context = await this.context(identity, organizationId, 'membership.remove'); const id = parse(resourceIdSchema, membershipId);
    return this.dependencies.transactions.transaction(async (client) => {
      const found = await client.query(`SELECT * FROM organization_memberships WHERE organization_id=$1 AND id=$2 FOR UPDATE`, [context.organizationId, id]);
      const target = found.rows[0]; if (!target) throw notFound('Membership');
      assertCanManageRole(context.role, target.role as MembershipRole);
      if (target.user_id === context.userId) throw conflict('cannot_remove_self', 'Administrators cannot remove their own membership');
      if (target.role === 'owner' && target.status === 'active') await assertNotLastOwner(client, context.organizationId, id);
      await client.query(`DELETE FROM organization_memberships WHERE organization_id=$1 AND id=$2`, [context.organizationId, id]);
      await audit(client, context, 'membership.remove', 'membership', id, { userId: target.user_id, role: target.role });
      return { id, removed: true };
    });
  }

  public async getPolicy(identity: Identity, organizationId: string) {
    const context = await this.context(identity, organizationId, 'credential.manage');
    const result = await this.dependencies.sql.query(`SELECT default_timezone,data_retention_days,approval_policy FROM organizations WHERE id=$1`, [context.organizationId]);
    if (!result.rows[0]) throw notFound('Organization'); return mapPolicy(result.rows[0]);
  }

  public async updatePolicy(identity: Identity, organizationId: string, body: unknown) {
    const context = await this.context(identity, organizationId, 'credential.manage'); const input = parse(organizationPolicySchema, body);
    return this.dependencies.transactions.transaction(async (client) => {
      const result = await client.query(
        `UPDATE organizations SET default_timezone=COALESCE($2,default_timezone),data_retention_days=CASE WHEN $3::boolean THEN $4 ELSE data_retention_days END,approval_policy=COALESCE($5,approval_policy),updated_at=now() WHERE id=$1 RETURNING *`,
        [context.organizationId, input.defaultTimezone ?? null, input.dataRetentionDays !== undefined, input.dataRetentionDays ?? null, input.approvalPolicy ?? null]
      );
      await audit(client, context, 'organization.policy.update', 'organization', context.organizationId, input);
      return mapPolicy(result.rows[0]!);
    });
  }

  public listCredentials(identity: Identity, organizationId: string, query: unknown) { return this.listResource(identity, organizationId, query, 'credential.manage', 'credential_handles', mapCredential); }
  public createCredential(identity: Identity, organizationId: string, body: unknown) { const input=parse(credentialCreateSchema, body); return this.createCredentialInternal(identity, organizationId, {...input,metadata:input.metadata??{}}); }
  public updateCredential(identity: Identity, organizationId: string, id: string, body: unknown) { return this.updateCredentialInternal(identity, organizationId, parse(resourceIdSchema, id), parse(credentialUpdateSchema, body)); }
  public deleteCredential(identity: Identity, organizationId: string, id: string) { return this.deleteResource(identity, organizationId, parse(resourceIdSchema, id), 'credential.manage', 'credential_handles', 'credential', 'credential.delete'); }

  public listModels(identity: Identity, organizationId: string, query: unknown) { return this.listResource(identity, organizationId, query, 'model_profile.manage', 'model_profiles', mapModel); }
  public createModel(identity: Identity, organizationId: string, body: unknown) { const input=parse(modelCreateSchema, body); return this.createModelInternal(identity, organizationId, {...input,configuration:input.configuration??{}}); }
  public updateModel(identity: Identity, organizationId: string, id: string, body: unknown) { return this.updateModelInternal(identity, organizationId, parse(resourceIdSchema, id), parse(modelUpdateSchema, body)); }
  public deleteModel(identity: Identity, organizationId: string, id: string) { return this.deleteResource(identity, organizationId, parse(resourceIdSchema, id), 'model_profile.manage', 'model_profiles', 'model_profile', 'model.delete'); }

  public async listAuditLogs(identity: Identity, organizationId: string, query: unknown) {
    const context = await this.context(identity, organizationId, 'audit.read'); const page = parse(auditFilterSchema, query);
    const pageNumber=page.page??1,pageSize=page.pageSize??20;
    const result = await this.dependencies.sql.query(
      `SELECT *,count(*) OVER()::integer AS total FROM audit_events WHERE organization_id=$1
       AND ($2::text IS NULL OR action=$2) AND ($3::text IS NULL OR resource_type=$3)
       ORDER BY occurred_at DESC,id DESC LIMIT $4 OFFSET $5`,
      [context.organizationId, page.action ?? null, page.resourceType ?? null, pageSize, (pageNumber - 1) * pageSize]
    );
    return paged(result.rows.map(mapAudit), result.rows, {page:pageNumber,pageSize});
  }

  private context(identity: Identity, organizationId: string, action: OrganizationAction) { return this.dependencies.contexts.resolve(identity, organizationId, action); }
  private async listResource<T>(identity: Identity, organizationId: string, query: unknown, action: OrganizationAction, table: 'credential_handles'|'model_profiles', mapper: (row: Record<string, unknown>) => T) {
    const context = await this.context(identity, organizationId, action); const page = parse(paginationSchema, query);
    const pageNumber=page.page??1,pageSize=page.pageSize??20;
    const result = await this.dependencies.sql.query(`SELECT *,count(*) OVER()::integer AS total FROM ${table} WHERE organization_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3`, [context.organizationId, pageSize, (pageNumber - 1) * pageSize]);
    return paged(result.rows.map(mapper), result.rows, {page:pageNumber,pageSize});
  }
  private async createCredentialInternal(identity: Identity, organizationId: string, input: z.infer<typeof credentialCreateSchema>) {
    const context = await this.context(identity, organizationId, 'credential.manage'); const id=randomUUID();
    return this.dependencies.transactions.transaction(async(client)=>{ const result=await client.query(`INSERT INTO credential_handles (id,organization_id,name,provider,handle,metadata,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[id,context.organizationId,input.name,input.provider,input.handle,input.metadata,context.userId]); await audit(client,context,'credential.create','credential',id,{name:input.name,provider:input.provider,handle:input.handle}); return mapCredential(result.rows[0]!); });
  }
  private async updateCredentialInternal(identity: Identity, organizationId: string, id: string, input: z.infer<typeof credentialUpdateSchema>) {
    const context=await this.context(identity,organizationId,'credential.manage'); return this.dependencies.transactions.transaction(async(client)=>{ const result=await client.query(`UPDATE credential_handles SET name=COALESCE($3,name),status=COALESCE($4,status),metadata=COALESCE($5,metadata),updated_at=now() WHERE organization_id=$1 AND id=$2 RETURNING *`,[context.organizationId,id,input.name??null,input.status??null,input.metadata??null]); if(!result.rows[0]) throw notFound('Credential handle'); await audit(client,context,'credential.update','credential',id,input); return mapCredential(result.rows[0]); });
  }
  private async createModelInternal(identity: Identity, organizationId: string, input: z.infer<typeof modelCreateSchema>) {
    const context=await this.context(identity,organizationId,'model_profile.manage'); const id=randomUUID(); return this.dependencies.transactions.transaction(async(client)=>{ const result=await client.query(`INSERT INTO model_profiles (id,organization_id,name,provider,model,credential_handle_id,configuration,created_by) SELECT $1,$2,$3,$4,$5,c.id,$7,$8 FROM (SELECT $6::text AS requested) x LEFT JOIN credential_handles c ON c.organization_id=$2 AND c.id=x.requested WHERE x.requested IS NULL OR c.id IS NOT NULL RETURNING *`,[id,context.organizationId,input.name,input.provider,input.model,input.credentialHandleId??null,input.configuration,context.userId]); if(!result.rows[0]) throw notFound('Credential handle'); await audit(client,context,'model.create','model_profile',id,{name:input.name,provider:input.provider,model:input.model,credentialHandleId:input.credentialHandleId}); return mapModel(result.rows[0]); });
  }
  private async updateModelInternal(identity: Identity, organizationId: string, id: string, input: z.infer<typeof modelUpdateSchema>) {
    const context=await this.context(identity,organizationId,'model_profile.manage'); return this.dependencies.transactions.transaction(async(client)=>{ if(input.credentialHandleId){ const credential=await client.query(`SELECT id FROM credential_handles WHERE organization_id=$1 AND id=$2`,[context.organizationId,input.credentialHandleId]); if(!credential.rows[0]) throw notFound('Credential handle'); } const result=await client.query(`UPDATE model_profiles SET name=COALESCE($3,name),provider=COALESCE($4,provider),model=COALESCE($5,model),credential_handle_id=CASE WHEN $6::boolean THEN $7 ELSE credential_handle_id END,configuration=COALESCE($8,configuration),status=COALESCE($9,status),updated_at=now() WHERE organization_id=$1 AND id=$2 RETURNING *`,[context.organizationId,id,input.name??null,input.provider??null,input.model??null,input.credentialHandleId!==undefined,input.credentialHandleId??null,input.configuration??null,input.status??null]); if(!result.rows[0]) throw notFound('Model profile'); await audit(client,context,'model.update','model_profile',id,input); return mapModel(result.rows[0]); });
  }
  private async deleteResource(identity: Identity, organizationId: string, id: string, action: OrganizationAction, table: 'credential_handles'|'model_profiles', resourceType: string, auditAction: string) { const context=await this.context(identity,organizationId,action); return this.dependencies.transactions.transaction(async(client)=>{ const result=await client.query(`DELETE FROM ${table} WHERE organization_id=$1 AND id=$2 RETURNING id`,[context.organizationId,id]); if(!result.rows[0]) throw notFound(resourceType); await audit(client,context,auditAction,resourceType,id); return {id,removed:true}; }); }
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T { const result=schema.safeParse(input); if(!result.success) throw new ServerError('invalid_request','Request validation failed',400,{issues:result.error.issues}); return result.data; }
function assertCanManageRole(actor: MembershipRole,target: MembershipRole): void { if(actor==='owner') return; if(actor!=='admin'||target==='owner'||target==='admin') throw new ServerError('permission_denied','Role cannot manage the requested membership',403); }
async function assertNotLastOwner(sql: SqlExecutor, organizationId: string, excludingId: string) { const result=await sql.query(`SELECT id FROM organization_memberships WHERE organization_id=$1 AND role='owner' AND status='active' FOR UPDATE`,[organizationId]); if(result.rows.filter((row)=>String(row.id)!==excludingId).length<1) throw conflict('last_owner','The last active owner cannot be removed or demoted'); }
async function audit(sql: SqlExecutor,context:OrganizationContext,action:string,type:string,id?:string,payload:Readonly<Record<string,unknown>>={}) { await sql.query(`INSERT INTO audit_events (organization_id,actor_user_id,action,resource_type,resource_id,payload) VALUES ($1,$2,$3,$4,$5,$6)`,[context.organizationId,context.userId,action,type,id??null,payload]); }
function paged<T>(items:T[],rows:Record<string,unknown>[],page:{page:number;pageSize:number}) { return {items,page:page.page,pageSize:page.pageSize,total:Number(rows[0]?.total??0)}; }
function iso(value:unknown){return value instanceof Date?value.toISOString():String(value);}
function mapMember(row:Record<string,unknown>){return {id:String(row.id),userId:String(row.user_id),displayName:row.display_name==null?String(row.user_id):String(row.display_name),role:String(row.role),status:String(row.status),createdAt:iso(row.created_at),updatedAt:iso(row.updated_at)};}
function mapPolicy(row:Record<string,unknown>){return {defaultTimezone:String(row.default_timezone),dataRetentionDays:row.data_retention_days==null?null:Number(row.data_retention_days),approvalPolicy:row.approval_policy};}
function mapCredential(row:Record<string,unknown>){return {id:String(row.id),name:String(row.name),provider:String(row.provider),handle:String(row.handle),metadata:row.metadata,status:String(row.status),createdAt:iso(row.created_at),updatedAt:iso(row.updated_at)};}
function mapModel(row:Record<string,unknown>){return {id:String(row.id),name:String(row.name),provider:String(row.provider),model:String(row.model),credentialHandleId:row.credential_handle_id==null?null:String(row.credential_handle_id),configuration:row.configuration,status:String(row.status),createdAt:iso(row.created_at),updatedAt:iso(row.updated_at)};}
function mapAudit(row:Record<string,unknown>){return {id:String(row.id),actorUserId:row.actor_user_id==null?null:String(row.actor_user_id),action:String(row.action),resourceType:String(row.resource_type),resourceId:row.resource_id==null?null:String(row.resource_id),payload:row.payload,occurredAt:iso(row.occurred_at)};}
function isUniqueViolation(error:unknown):boolean{return typeof error==='object'&&error!==null&&'code' in error&&(error as {code?:unknown}).code==='23505';}
