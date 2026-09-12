import { useCallback, useEffect, useMemo, useState } from 'react';

import './WorkspacePage.css';

import { AgentApiClient, ApiError, isUnauthorizedError } from '../api/client';
import type { AgentModel, Conversation, MeUser, Membership, Skill } from '../api/types';
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
  onSessionExpired,
  onUserUpdated
}: {
  api: AgentApiClient;
  memberships: Membership[];
  organizationId: string;
  user: MeUser;
  onSelectOrganization(id: string): void;
  onLogout(): void;
  onSessionExpired(): void;
  onUserUpdated(user: MeUser): void;
}) {
  const { conversationId, setConversationId } = useConversationRoute();
  const [models, setModels] = useState<AgentModel[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [error, setError] = useState<string>();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [section, setSection] = useState<SidebarSection>('conversations');
  const [draftSkill, setDraftSkill] = useState<Skill>();
  const [draftModelId, setDraftModelId] = useState<string>();
  const [draftVersion, setDraftVersion] = useState(0);
  const [scheduleDraft, setScheduleDraft] = useState<string>();

  const refreshConversations = useCallback(async () => {
    const items = await api.listConversations();
    setConversations(items);
    return items;
  }, [api]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [nextModels, nextSkills, items] = await Promise.all([api.listModels(), api.listSkills(), refreshConversations()]);
        if (cancelled) return;
        setModels(nextModels);
        setSkills(nextSkills);
        setDraftSkill(undefined);
        setDraftModelId(undefined);
        const requested = new URLSearchParams(window.location.search).get('c') ?? conversationId;
        const selected = items.find((item) => item.id === requested) ?? items[0];
        setConversationId(selected?.id);
      } catch (cause) {
        if (cancelled) return;
        if (isUnauthorizedError(cause)) {
          onSessionExpired();
          return;
        }
        setError(cause instanceof ApiError ? cause.message : '无法加载工作区');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, onSessionExpired, organizationId, refreshConversations, setConversationId]);

  const startDraft = useCallback((skill?: Skill) => {
    setConversationId(undefined);
    setDraftSkill(skill);
    setDraftModelId(undefined);
    setDraftVersion((value) => value + 1);
  }, [setConversationId]);

  const selectConversation = useCallback((id: string) => {
    setDraftSkill(undefined);
    setDraftModelId(undefined);
    setConversationId(id);
  }, [setConversationId]);

  const createDraftConversation = useCallback(async () => {
    const created = await api.createConversation({
      ...(draftSkill ? { skillId: draftSkill.id } : {}),
      ...(draftModelId ? { modelId: draftModelId } : {})
    });
    return created.id;
  }, [api, draftModelId, draftSkill]);

  const onConversationsChange = useCallback(async () => {
    await refreshConversations();
  }, [refreshConversations]);

  const conversation = useMemo(
    () => conversations.find((item) => item.id === conversationId),
    [conversationId, conversations]
  );
  const selectedModel = models.find((item) => item.id === (conversation?.modelId ?? draftModelId)) ?? models[0] ?? null;
  const activeSkill = conversation
    ? skills.find((item) => item.id === conversation.skillId)
    : draftSkill;

  const patchConversation = useCallback(async (patch: { modelId: string }) => {
    if (!conversationId) return;
    const next = await api.patchConversation(conversationId, patch);
    setConversations((current) => current.map((item) => item.id === next.id ? next : item));
  }, [api, conversationId]);

  return (
    <div className="shell">
      {error && <div className="error-banner" role="alert">{error}</div>}
      <AgentRuntimeProvider
        key={conversationId ?? `draft-${draftVersion}`}
        api={api}
        conversationId={conversationId}
        onCreateConversation={createDraftConversation}
        onConversationCreated={(id) => {
          setDraftSkill(undefined);
          setDraftModelId(undefined);
          setConversationId(id);
        }}
        onConversationsChange={onConversationsChange}
        onSessionExpired={onSessionExpired}
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
            onNew={() => { startDraft(); setSidebarOpen(false); }}
            onSelect={selectConversation}
            onSelectOrganization={onSelectOrganization}
            onLogout={onLogout}
            onApplySkill={(skill) => {
              startDraft(skill);
              setSidebarOpen(false);
            }}
            onArchive={(id) => {
              void api.patchConversation(id, { archived: true }).then(async () => {
                const items = await refreshConversations();
                if (id === conversationId) {
                  const next = items.find((item) => item.id !== id);
                  if (next) selectConversation(next.id);
                  else startDraft();
                }
              });
            }}
            onRename={(id, title) => {
              void api.patchConversation(id, { title }).then(() => refreshConversations());
            }}
            api={api}
            section={section}
            onSection={setSection}
            skills={skills}
            scheduleDraft={scheduleDraft}
            onConsumedScheduleDraft={() => setScheduleDraft(undefined)}
            onOpenScheduleConversation={(id) => {
              selectConversation(id);
              setSection('conversations');
              setSidebarOpen(false);
            }}
          />
          <main className="stage">
            <TopBar
              onOpenSidebar={() => setSidebarOpen(true)}
              onNew={() => startDraft()}
            />
            <Thread
              api={api}
              conversationId={conversationId}
              model={selectedModel}
              models={models}
              skill={activeSkill}
              onCancelSkill={draftSkill ? () => setDraftSkill(undefined) : undefined}
              onSchedulePrompt={(prompt) => {
                setScheduleDraft(prompt);
                setSection('schedules');
                setSidebarOpen(true);
              }}
              onModelChange={(next) => {
                if (conversationId) void patchConversation({ modelId: next.id });
                else setDraftModelId(next.id);
              }}
            />
          </main>
        </div>
      </AgentRuntimeProvider>
    </div>
  );
}
