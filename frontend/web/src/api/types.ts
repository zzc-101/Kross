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

export interface Me {
  user: {
    userId: string;
    username: string;
    displayName: string;
    platformRole: 'super_admin' | 'user';
  };
  memberships: Membership[];
  canAccessAdmin: boolean;
}

export interface AuthConfig {
  registrationEnabled: boolean;
  bootstrapRequired: boolean;
  organizationExists: boolean;
}

export interface AgentModel {
  id: string;
  name: string;
  provider: string;
  model: string;
}

export interface Conversation {
  id: string;
  title: string;
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
    };

export interface AgentMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'agent' | 'system';
  content: string;
  parts?: MessagePart[];
  status: MessageStatus;
  errorSummary?: string;
  createdAt: string;
}
