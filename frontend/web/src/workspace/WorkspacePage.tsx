import { useCallback, useEffect, useMemo, useState } from 'react';

import { AgentApiClient, ApiError } from '../api/client';
import type { AgentMode, AgentModel, Conversation, MeUser, Membership } from '../api/types';
import { AgentRuntimeProvider } from '../assistant/AgentRuntimeProvider';
import { Thread } from '../assistant/Thread';
import { useConversationRoute } from '../lib/conversationRoute';
import { Sidebar, type SidebarSection } from './Sidebar';
import { TopBar } from './TopBar';

export function WorkspacePage({
  api,
  memberships,
  organizationId,
  user,
  onSelectOrganization,
  onLogout,
  onUserUpdated
}: {
  api: AgentApiClient;
  memberships: Membership[];
  organizationId: string;
  user: MeUser;
  onSelectOrganization(id: string): void;
  onLogout(): void;
  onUserUpdated(user: MeUser): void;
}) {
  const { conversationId, setConversationId } = useConversationRoute();
  const [models, setModels] = useState<AgentModel[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [error, setError] = useState<string>();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [section, setSection] = useState<SidebarSection>('conversations');
  const [placeholder, setPlaceholder] = useState<{ title: string; body: string }>();

  const refreshConversations = useCallback(async () => {
    const items = await api.listConversations();
    setConversations(items);
    return items;
  }, [api]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [nextModels, items] = await Promise.all([api.listModels(), refreshConversations()]);
        if (cancelled) return;
        setModels(nextModels);
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

  const conversation = useMemo(
    () => conversations.find((item) => item.id === conversationId),
    [conversationId, conversations]
  );
  const mode: AgentMode = conversation?.mode ?? 'auto';
  const selectedModel = models.find((item) => item.id === conversation?.modelId) ?? models[0] ?? null;

  const patchConversation = useCallback(async (patch: { mode?: AgentMode; modelId?: string }) => {
    if (!conversationId) return;
    const next = await api.patchConversation(conversationId, patch);
    setConversations((current) => current.map((item) => item.id === next.id ? next : item));
  }, [api, conversationId]);

  return (
    <div className="shell">
      {error && <div className="error-banner" role="alert">{error}</div>}
      <AgentRuntimeProvider
        key={conversationId ?? 'no-conversation'}
        api={api}
        conversationId={conversationId}
        onConversationsChange={onConversationsChange}
      >
        <div className="workspace">
          <Sidebar
            conversations={conversations}
            activeId={conversationId}
            open={sidebarOpen}
            memberships={memberships}
            organizationId={organizationId}
            displayName={user.displayName}
            username={user.username}
            avatarUrl={user.avatarUrl}
            gender={user.gender}
            phone={user.phone}
            onSaveProfile={async (input) => {
              const next = await api.updateProfile(input);
              onUserUpdated(next.user);
            }}
            onClose={() => setSidebarOpen(false)}
            onNew={() => { void onCreateConversation(); setSidebarOpen(false); }}
            onSelect={setConversationId}
            onSelectOrganization={onSelectOrganization}
            onLogout={onLogout}
            onPlaceholder={(title, body) => setPlaceholder({ title, body })}
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
            api={api}
            section={section}
            onSection={setSection}
          />
          <main className="stage">
            <TopBar
              onOpenSidebar={() => setSidebarOpen(true)}
              onNew={() => void onCreateConversation()}
              onTemporaryChat={() => setPlaceholder({
                title: '临时对话',
                body: '临时对话不会写入历史。入口已恢复，能力尚未接入。'
              })}
            />
            <Thread
              api={api}
              conversationId={conversationId}
              model={selectedModel}
              models={models}
              mode={mode}
              onModeChange={(next) => void patchConversation({ mode: next })}
              onModelChange={(next) => void patchConversation({ modelId: next.id })}
            />
          </main>
        </div>
      </AgentRuntimeProvider>
      {placeholder && (
        <div className="dialog-backdrop" onClick={() => setPlaceholder(undefined)}>
          <div className="dialog" onClick={(event) => event.stopPropagation()}>
            <h2>{placeholder.title}</h2>
            <p>{placeholder.body}</p>
            <div className="dialog-actions">
              <button type="button" className="primary" onClick={() => setPlaceholder(undefined)}>知道了</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
