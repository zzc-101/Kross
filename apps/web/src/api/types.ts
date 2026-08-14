export type AgentStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';
export type MessageStatus = 'queued' | 'processing' | 'done' | 'failed';

export interface Membership {
  id: string;
  organizationId: string;
  userId: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  status: string;
}

export interface Me {
  user: { userId: string; displayName: string };
  memberships: Membership[];
}

export interface Agent {
  id: string;
  organizationId: string;
  userId: string;
  status: AgentStatus;
  lastActiveAt: string;
  createdAt: string;
}

export interface Conversation {
  id: string;
  title: string;
  archivedAt?: string;
  lastMessageAt: string;
  createdAt: string;
}

export interface AgentMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'agent' | 'system';
  content: string;
  status: MessageStatus;
  errorSummary?: string;
  createdAt: string;
}
