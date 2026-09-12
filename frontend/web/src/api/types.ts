export type MessageStatus = 'queued' | 'processing' | 'done' | 'failed';

export interface Membership {
  id: string;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  userId: string;
  role: 'admin' | 'member';
  status: string;
}

export interface MeUser {
  userId: string;
  username: string;
  displayName: string;
  platformRole: 'super_admin' | 'user';
  status?: string;
  email?: string;
  avatarUrl?: string;
  gender?: 'unspecified' | 'male' | 'female' | 'other';
  phone?: string;
}

export interface Me {
  user: MeUser;
  memberships: Membership[];
  canAccessAdmin: boolean;
}

export interface AuthConfig {
  registrationEnabled: boolean;
  bootstrapRequired: boolean;
  organizationExists: boolean;
  ssoEnabled: boolean;
  ssoDisplayName?: string;
}

export interface InvitePreview {
  organizationName: string;
  organizationSlug: string;
  role: 'admin' | 'member';
  expiresAt: string;
  accepted: boolean;
}

export interface AgentModel {
  id: string;
  name: string;
  provider: string;
  model: string;
  contextWindow: number;
}

export interface Conversation {
  id: string;
  title: string;
  modelId?: string;
  skillId?: string;
  archivedAt?: string;
  lastMessageAt: string;
  createdAt: string;
}

export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | {
      type: 'tool';
      id: string;
      name: string;
      input?: unknown;
      result?: string;
      status?: 'running' | 'approval-required' | 'done' | 'failed';
      approval?: {
        id: string;
        risk: string;
        reason?: string;
        inputPreview?: string;
        approved?: boolean;
      };
    }
  | { type: 'file'; path: string; mimeType: string; name: string };

export interface AgentMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'agent' | 'system';
  content: string;
  parts?: MessagePart[];
  status: MessageStatus;
  errorSummary?: string;
  contextUsage?: {
    usedTokens: number;
    contextWindow: number;
    ratio: number;
  };
  createdAt: string;
}

export interface WorkspaceEntry {
  name: string;
  type: 'file' | 'dir';
  size?: number;
  modifiedAt?: string;
}

export interface WorkspaceListing {
  path: string;
  entries: WorkspaceEntry[];
}

export interface WorkspaceFile {
  path: string;
  content: string;
}

export interface WorkspaceStoredFile {
  path: string;
  size: number;
  mimeType: string;
  name: string;
}

export interface WorkspaceUpload {
  key: string;
  method: string;
  url: string;
  expiresAt: string;
  mimeType: string;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  launchMode: 'instant' | 'form' | 'file';
  starterPrompt: string;
  revision: number;
}

export type MemoryKind = 'preference' | 'fact';
export type MemorySource = 'manual' | 'remember' | 'extract';

export interface AgentMemory {
  id: string;
  kind: MemoryKind;
  source: MemorySource;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeStatus {
  enabled: boolean;
  available: boolean;
  spaceIds: string[];
}

export interface KnowledgeHit {
  documentId: string;
  title: string;
  spaceId: string;
  excerpt: string;
  score: number;
  modality?: 'text' | 'image';
}

export interface ConnectorStatus {
  channel: string;
  enabled: boolean;
  bound: boolean;
  boundAt?: string;
}

export interface ConnectorBindCode {
  channel: string;
  code: string;
  expiresAt: string;
}

export type ScheduleKind = 'once' | 'cron';
export type ScheduleStatus = 'active' | 'paused' | 'done' | 'error';
export type ScheduleConversationMode = 'new_conversation' | 'pinned_conversation';

export interface AgentSchedule {
  id: string;
  name: string;
  prompt: string;
  skillId?: string | null;
  conversationMode: ScheduleConversationMode;
  conversationId?: string | null;
  timezone: string;
  kind: ScheduleKind;
  cronExpr?: string | null;
  runAt?: string | null;
  nextRunAt?: string | null;
  lastRunAt?: string | null;
  status: ScheduleStatus;
  consecutiveFailures: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentScheduleRun {
  id: string;
  scheduleId: string;
  conversationId?: string | null;
  userMessageId?: string | null;
  dueAt: string;
  claimedAt: string;
  status: 'started' | 'skipped' | 'failed';
  error?: string | null;
}
