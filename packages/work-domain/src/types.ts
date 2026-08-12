import type { z } from 'zod';

import type {
  appendRunEventInputSchema,
  appendTaskMessageInputSchema,
  approvalKindSchema,
  approvalPolicySchema,
  approvalSchema,
  approvalStatusSchema,
  approvalTargetSchema,
  artifactKindSchema,
  artifactSchema,
  artifactStatusSchema,
  commitArtifactInputSchema,
  completeSourceUploadInputSchema,
  connectorCapabilitySnapshotSchema,
  connectorInstallationSchema,
  connectorInstallationStatusSchema,
  createMembershipInputSchema,
  createOrganizationInputSchema,
  createProjectInputSchema,
  createRunInputSchema,
  createScheduleInputSchema,
  createSourceInputSchema,
  createTaskInputSchema,
  decideApprovalInputSchema,
  externalActionPolicySchema,
  finalizeSourceInputSchema,
  installConnectorInputSchema,
  membershipRoleSchema,
  membershipSchema,
  membershipStatusSchema,
  modelSnapshotSchema,
  organizationSchema,
  organizationStatusSchema,
  permissionPolicySnapshotSchema,
  projectKindSchema,
  projectSchema,
  projectStatusSchema,
  repositoryBindingSchema,
  requestApprovalInputSchema,
  reserveArtifactInputSchema,
  riskLevelSchema,
  runEventSchema,
  runResourceLimitsSchema,
  runSchema,
  runStatusSchema,
  runUsageSchema,
  scheduleConcurrencyPolicySchema,
  scheduleSchema,
  scheduleStatusSchema,
  scheduleTaskTemplateSchema,
  scheduleTriggerSchema,
  sourceKindSchema,
  sourceOriginSchema,
  sourceSchema,
  sourceScopeSchema,
  sourceStatusSchema,
  taskMessageContentBlockSchema,
  taskMessageRoleSchema,
  taskMessageSchema,
  taskSchema,
  taskStatusSchema,
  taskTypeSchema,
  updateScheduleInputSchema
} from './schemas';

export type OrganizationStatus = z.infer<typeof organizationStatusSchema>;
export type MembershipRole = z.infer<typeof membershipRoleSchema>;
export type MembershipStatus = z.infer<typeof membershipStatusSchema>;
export type ProjectKind = z.infer<typeof projectKindSchema>;
export type ProjectStatus = z.infer<typeof projectStatusSchema>;
export type SourceKind = z.infer<typeof sourceKindSchema>;
export type SourceScope = z.infer<typeof sourceScopeSchema>;
export type SourceStatus = z.infer<typeof sourceStatusSchema>;
export type TaskType = z.infer<typeof taskTypeSchema>;
export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type TaskMessageRole = z.infer<typeof taskMessageRoleSchema>;
export type RunStatus = z.infer<typeof runStatusSchema>;
export type ApprovalKind = z.infer<typeof approvalKindSchema>;
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;
export type RiskLevel = z.infer<typeof riskLevelSchema>;
export type ArtifactKind = z.infer<typeof artifactKindSchema>;
export type ArtifactStatus = z.infer<typeof artifactStatusSchema>;
export type ConnectorInstallationStatus = z.infer<typeof connectorInstallationStatusSchema>;
export type ScheduleStatus = z.infer<typeof scheduleStatusSchema>;
export type ScheduleConcurrencyPolicy = z.infer<typeof scheduleConcurrencyPolicySchema>;
export type ExternalActionPolicy = z.infer<typeof externalActionPolicySchema>;

export type ApprovalPolicy = z.infer<typeof approvalPolicySchema>;
export type PermissionPolicySnapshot = z.infer<typeof permissionPolicySnapshotSchema>;
export type Organization = z.infer<typeof organizationSchema>;
export type CreateOrganizationInput = z.input<typeof createOrganizationInputSchema>;
export type Membership = z.infer<typeof membershipSchema>;
export type CreateMembershipInput = z.input<typeof createMembershipInputSchema>;
export type RepositoryBinding = z.infer<typeof repositoryBindingSchema>;
export type Project = z.infer<typeof projectSchema>;
export type CreateProjectInput = z.input<typeof createProjectInputSchema>;
export type SourceOrigin = z.infer<typeof sourceOriginSchema>;
export type Source = z.infer<typeof sourceSchema>;
export type CreateSourceInput = z.input<typeof createSourceInputSchema>;
export type CompleteSourceUploadInput = z.input<typeof completeSourceUploadInputSchema>;
export type FinalizeSourceInput = z.input<typeof finalizeSourceInputSchema>;
export type Task = z.infer<typeof taskSchema>;
export type CreateTaskInput = z.input<typeof createTaskInputSchema>;
export type TaskMessageContentBlock = z.infer<typeof taskMessageContentBlockSchema>;
export type TaskMessage = z.infer<typeof taskMessageSchema>;
export type AppendTaskMessageInput = z.input<typeof appendTaskMessageInputSchema>;
export type ModelSnapshot = z.infer<typeof modelSnapshotSchema>;
export type RunResourceLimits = z.infer<typeof runResourceLimitsSchema>;
export type RunUsage = z.infer<typeof runUsageSchema>;
export type Run = z.infer<typeof runSchema>;
export type CreateRunInput = z.input<typeof createRunInputSchema>;
export type RunEvent = z.infer<typeof runEventSchema>;
export type AppendRunEventInput = z.input<typeof appendRunEventInputSchema>;
export type ApprovalTarget = z.infer<typeof approvalTargetSchema>;
export type Approval = z.infer<typeof approvalSchema>;
export type RequestApprovalInput = z.input<typeof requestApprovalInputSchema>;
export type DecideApprovalInput = z.input<typeof decideApprovalInputSchema>;
export type Artifact = z.infer<typeof artifactSchema>;
export type ReserveArtifactInput = z.input<typeof reserveArtifactInputSchema>;
export type CommitArtifactInput = z.input<typeof commitArtifactInputSchema>;
export type ConnectorCapabilitySnapshot = z.infer<typeof connectorCapabilitySnapshotSchema>;
export type ConnectorInstallation = z.infer<typeof connectorInstallationSchema>;
export type InstallConnectorInput = z.input<typeof installConnectorInputSchema>;
export type ScheduleTrigger = z.infer<typeof scheduleTriggerSchema>;
export type ScheduleTaskTemplate = z.infer<typeof scheduleTaskTemplateSchema>;
export type Schedule = z.infer<typeof scheduleSchema>;
export type CreateScheduleInput = z.input<typeof createScheduleInputSchema>;
export type UpdateScheduleInput = z.input<typeof updateScheduleInputSchema>;

export interface OrganizationContext {
  organizationId: string;
  userId: string;
  membershipId: string;
  role: MembershipRole;
}
