import { Menu, Moon } from 'lucide-react';

import { agentStatusLabel } from '../assistant/AgentRuntimeProvider';
import type { Agent, Membership } from '../api/types';

export function TopBar({
  agent,
  memberships,
  organizationId,
  devUserId,
  onOpenSidebar,
  onSelectOrganization,
  onSleep,
  onChangeIdentity
}: {
  agent?: Agent;
  memberships: Membership[];
  organizationId: string;
  devUserId: string;
  onOpenSidebar(): void;
  onSelectOrganization(id: string): void;
  onSleep(): void;
  onChangeIdentity(): void;
}) {
  const live = agent?.status === 'running' || agent?.status === 'starting';
  return (
    <header className="topbar">
      <div className="brand">
        <button type="button" className="menu-btn" aria-label="打开会话列表" onClick={onOpenSidebar}>
          <Menu size={18} />
        </button>
        <span>K</span>
        <div>
          <strong>Kross</strong>
          <small>长期 Agent 工作区</small>
        </div>
      </div>
      <div className="top-actions">
        <span className={`agent-pill ${live ? 'live' : 'idle'}`}>
          <i />
          {agentStatusLabel(agent)}
        </span>
        <select
          aria-label="切换组织"
          value={organizationId}
          onChange={(event) => onSelectOrganization(event.target.value)}
        >
          {memberships.map((item) => (
            <option key={item.id} value={item.organizationId}>
              {item.organizationId} · {item.role}
            </option>
          ))}
        </select>
        <button type="button" className="ghost" onClick={onSleep} disabled={!live}>
          <Moon size={14} /> 休眠
        </button>
        <button type="button" className="ghost" onClick={onChangeIdentity}>{devUserId}</button>
      </div>
    </header>
  );
}
