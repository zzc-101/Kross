import { useCallback, useEffect, useState } from 'react';

import { AgentApiClient, ApiError } from '../api/client';
import type { AgentModel, Conversation, Membership } from '../api/types';
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
  const [model, setModel] = useState<AgentModel | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [error, setError] = useState<string>();
  const [workspaceHint, setWorkspaceHint] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const refreshConversations = useCallback(async () => {
    const items = await api.listConversations();
    setConversations(items);
    return items;
  }, [api]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [nextModel, items] = await Promise.all([api.getCurrentModel(), refreshConversations()]);
        if (cancelled) return;
        setModel(nextModel);
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
  }, [api, organizationId, refreshConversations, setConversationId]);

  const onCreateConversation = useCallback(async () => {
    const created = await api.createConversation();
    await refreshConversations();
    setConversationId(created.id);
    return created.id;
  }, [api, refreshConversations, setConversationId]);

  const onConversationsChange = useCallback(async () => {
    await refreshConversations();
  }, [refreshConversations]);

  return (
    <div className="shell">
      {error && <div className="error-banner" role="alert">{error}</div>}
      <AgentRuntimeProvider
        api={api}
        conversations={conversations}
        conversationId={conversationId}
        onConversationsChange={onConversationsChange}
        onSelectConversation={setConversationId}
        onCreateConversation={onCreateConversation}
      >
        <div className="workspace">
          <Sidebar
            conversations={conversations}
            activeId={conversationId}
            open={sidebarOpen}
            memberships={memberships}
            organizationId={organizationId}
            devUserId={devUserId}
            onClose={() => setSidebarOpen(false)}
            onNew={() => { void onCreateConversation(); setSidebarOpen(false); }}
            onSelect={setConversationId}
            onSelectOrganization={onSelectOrganization}
            onChangeIdentity={onChangeIdentity}
            onArchive={(id) => {
              void api.patchConversation(id, { archived: true }).then(async () => {
                const items = await refreshConversations();
                if (id === conversationId) {
                  const next = items.find((item) => item.id !== id);
                  if (next) setConversationId(next.id);
                  else setConversationId(await onCreateConversation());
                }
              });
            }}
            onRename={(id, title) => {
              void api.patchConversation(id, { title }).then(() => refreshConversations());
            }}
            onShowWorkspace={() => setWorkspaceHint(true)}
          />
          <main className="stage">
            <TopBar onOpenSidebar={() => setSidebarOpen(true)} onNew={() => void onCreateConversation()} />
            <Thread model={model} />
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
