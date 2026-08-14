import { useCallback, useEffect, useState } from 'react';

import { AgentApiClient, ApiError } from '../api/client';
import type { Agent, Conversation, Membership } from '../api/types';
import { AgentRuntimeProvider } from '../assistant/AgentRuntimeProvider';
import { Thread } from '../assistant/Thread';
import { useConversationRoute } from '../lib/conversationRoute';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';

export function WorkspacePage({
  api,
  memberships,
  organizationId,
  devUserId,
  onSelectOrganization,
  onChangeIdentity
}: {
  api: AgentApiClient;
  memberships: Membership[];
  organizationId: string;
  devUserId: string;
  onSelectOrganization(id: string): void;
  onChangeIdentity(): void;
}) {
  const { conversationId, setConversationId } = useConversationRoute();
  const [agent, setAgent] = useState<Agent>();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [error, setError] = useState<string>();
  const [workspaceHint, setWorkspaceHint] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const refresh = useCallback(async () => {
    const [nextAgent, items] = await Promise.all([api.getAgent(), api.listConversations()]);
    setAgent(nextAgent);
    setConversations(items);
    return items;
  }, [api]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const items = await refresh();
        if (cancelled) return;
        const requested = new URLSearchParams(window.location.search).get('c') ?? conversationId;
        const selected = items.find((item) => item.id === requested) ?? items[0];
        if (selected) setConversationId(selected.id);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof ApiError ? cause.message : '无法加载工作区');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [organizationId, refresh, setConversationId]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void api.getAgent().then(setAgent).catch(() => undefined);
    }, 4_000);
    return () => window.clearInterval(timer);
  }, [api]);

  const onCreateConversation = useCallback(async () => {
    const created = await api.createConversation();
    await refresh();
    setConversationId(created.id);
    return created.id;
  }, [api, refresh, setConversationId]);

  return (
    <div className="shell">
      <TopBar
        agent={agent}
        memberships={memberships}
        organizationId={organizationId}
        devUserId={devUserId}
        onOpenSidebar={() => setSidebarOpen(true)}
        onSelectOrganization={onSelectOrganization}
        onSleep={() => void api.sleep().then(setAgent).catch((cause) => setError(cause instanceof Error ? cause.message : '休眠失败'))}
        onChangeIdentity={onChangeIdentity}
      />
      {error && <div className="error-banner" role="alert">{error}</div>}
      <AgentRuntimeProvider
        api={api}
        conversations={conversations}
        conversationId={conversationId}
        onConversationsChange={async () => { await refresh(); }}
        onSelectConversation={setConversationId}
        onCreateConversation={onCreateConversation}
      >
        <div className="workspace">
          <Sidebar
            conversations={conversations}
            activeId={conversationId}
            open={sidebarOpen}
            onClose={() => setSidebarOpen(false)}
            onNew={() => { void onCreateConversation(); setSidebarOpen(false); }}
            onSelect={setConversationId}
            onArchive={(id) => {
              void api.patchConversation(id, { archived: true }).then(async () => {
                const items = await refresh();
                if (id === conversationId) {
                  const next = items.find((item) => item.id !== id);
                  if (next) setConversationId(next.id);
                  else setConversationId(await onCreateConversation());
                }
              });
            }}
            onRename={(id, title) => {
              void api.patchConversation(id, { title }).then(() => refresh());
            }}
            onShowWorkspace={() => setWorkspaceHint(true)}
          />
          <main className="stage">
            <Thread />
          </main>
        </div>
      </AgentRuntimeProvider>
      {workspaceHint && (
        <div className="dialog-backdrop" onClick={() => setWorkspaceHint(false)}>
          <div className="dialog" onClick={(event) => event.stopPropagation()}>
            <h2>工作区</h2>
            <p>技能和 MCP 会装进这个 Agent 的持久盘（<code>/work/skills</code>），由容器里的 Worker 加载。安装界面下一期再做。</p>
            <div className="dialog-actions">
              <button type="button" className="primary" onClick={() => setWorkspaceHint(false)}>知道了</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
