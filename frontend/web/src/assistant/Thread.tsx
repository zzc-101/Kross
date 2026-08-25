import { useState } from 'react';
import {
  ActionBarPrimitive,
  AuiIf,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  unstable_useComposerInput,
  useAuiState
} from '@assistant-ui/react';
import {
  ArrowDown,
  ArrowUp,
  BarChart3,
  BrainCircuit,
  Check,
  Copy,
  FileText,
  Lightbulb,
  LoaderCircle,
  PencilLine,
  Plus,
  Sparkles
} from 'lucide-react';

import { messagePartComponents } from './MessageParts';
import { AgentApiClient, ApiError } from '../api/client';
import type { Skill } from '../api/types';

export function Thread({
  api,
  conversationId,
  skill,
  onOpenFiles
}: {
  api: AgentApiClient;
  conversationId?: string;
  skill?: Skill;
  onOpenFiles(): void;
}) {
  return (
    <ThreadPrimitive.Root className="thread">
      <ThreadPrimitive.Viewport className="thread-viewport" autoScroll>
        <ThreadPrimitive.If empty>
          <div className="landing">
            <div className="landing-content">
              <div className="landing-greeting"><h1>{skill ? skill.name : 'How can I help you today?'}</h1></div>
              <Composer
                skill={skill}
                onOpenFiles={onOpenFiles}
                landing
              />
            </div>
            <Footer />
          </div>
        </ThreadPrimitive.If>

        <ThreadPrimitive.If empty={false}>
          <div className="message-list">
            <ThreadPrimitive.Messages components={{
              Message: () => <ConversationMessage api={api} conversationId={conversationId} />
            }} />
            <ThreadPrimitive.If running>
              <AssistantLoading />
            </ThreadPrimitive.If>
          </div>
          <ThreadPrimitive.ViewportFooter className="thread-viewport-footer">
            <ThreadPrimitive.ScrollToBottom className="scroll-to-bottom" aria-label="滚动到底部">
              <ArrowDown />
            </ThreadPrimitive.ScrollToBottom>
            <div className="composer-docked">
              <Composer
                skill={skill}
                onOpenFiles={onOpenFiles}
              />
              <Footer />
            </div>
          </ThreadPrimitive.ViewportFooter>
        </ThreadPrimitive.If>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
}

function AssistantLoading() {
  return (
    <div className="assistant-loading" role="status" aria-live="polite" aria-label="助手正在处理">
      <LoaderCircle className="spin" />
      <span>正在处理</span>
      <span className="assistant-loading-dots" aria-hidden="true"><i /><i /><i /></span>
    </div>
  );
}

function Composer({
  skill,
  onOpenFiles,
  landing = false
}: {
  skill?: Skill;
  onOpenFiles(): void;
  landing?: boolean;
}) {
  return (
    <div className="composer-wrap">
      <ComposerPrimitive.Root className="composer">
        {skill && <div className="composer-skill-chip"><Sparkles />{skill.name}</div>}
        <ComposerPrimitive.Input
          className="composer-input"
          placeholder={skill?.starterPrompt || '发送消息…'}
          rows={1}
          autoFocus
          aria-label="消息内容"
        />
        <div className="composer-toolbar">
          <div className="composer-tools">
            <button type="button" aria-label="查看文件与产物" title="查看文件与产物" onClick={onOpenFiles}>
              <Plus />
            </button>
          </div>
          <div className="composer-tools right">
            <ComposerPrimitive.Send className="composer-send" aria-label="发送"><ArrowUp /></ComposerPrimitive.Send>
          </div>
        </div>
      </ComposerPrimitive.Root>
      {landing && <QuickActions />}
    </div>
  );
}

const quickActions = [
  { label: '整理文件', prompt: '请帮我整理工作区里的文件，并说明你做了什么。', icon: FileText },
  { label: '撰写内容', prompt: '请帮我起草一份内容清晰、可以直接使用的文档。', icon: PencilLine },
  { label: '分析资料', prompt: '请分析我提供的资料，提炼结论和下一步行动。', icon: BarChart3 },
  { label: '头脑风暴', prompt: '围绕我的目标给出一组可执行的想法。', icon: Lightbulb }
];

function QuickActions() {
  const composer = unstable_useComposerInput();
  return (
    <div className="quick-actions" aria-label="快捷能力">
      {quickActions.map(({ label, prompt, icon: Icon }) => (
        <button type="button" key={label} onClick={() => composer.setText(prompt)}>
          <Icon /><span>{label}</span>
        </button>
      ))}
    </div>
  );
}

function Footer() {
  return (
    <footer className="libre-footer">
      <span>Kross Work Agent</span>
    </footer>
  );
}

function ConversationMessage({
  api,
  conversationId
}: {
  api: AgentApiClient;
  conversationId?: string;
}) {
  return (
    <MessagePrimitive.Root className="bubble">
      <MessagePrimitive.If user>
        <div className="bubble-row user">
          <div className="bubble-body"><MessagePrimitive.Content components={messagePartComponents} /></div>
          <div className="message-actions-wrap">
            <RememberButton api={api} conversationId={conversationId} />
            <MessageActions />
          </div>
        </div>
      </MessagePrimitive.If>
      <MessagePrimitive.If assistant>
        <div className="bubble-row assistant">
          <div className="assistant-message-stack">
            <div className="bubble-body"><MessagePrimitive.Content components={messagePartComponents} /></div>
            <MessageError />
            <MessageActions />
          </div>
        </div>
      </MessagePrimitive.If>
    </MessagePrimitive.Root>
  );
}

function MessageActions() {
  return (
    <ActionBarPrimitive.Root className="message-actions" hideWhenRunning autohide="not-last">
      <ActionBarPrimitive.Copy className="message-action" aria-label="复制消息" copiedDuration={2_000}>
        <AuiIf condition={(state) => state.message.isCopied}><Check /></AuiIf>
        <AuiIf condition={(state) => !state.message.isCopied}><Copy /></AuiIf>
      </ActionBarPrimitive.Copy>
    </ActionBarPrimitive.Root>
  );
}

function RememberButton({
  api,
  conversationId
}: {
  api: AgentApiClient;
  conversationId?: string;
}) {
  const messageId = useAuiState((state) => state.message.id);
  const [state, setState] = useState<'idle' | 'saving' | 'done' | 'error'>('idle');
  const [error, setError] = useState('');
  if (!conversationId || !messageId) return null;
  return (
    <button
      type="button"
      className="message-action"
      aria-label="记住这条"
      title={state === 'done' ? '已记住' : error || '写入永久记忆'}
      disabled={state === 'saving'}
      onClick={() => {
        setState('saving');
        setError('');
        void api.rememberMemory({ conversationId, messageId }).then(() => {
          setState('done');
        }).catch((cause) => {
          setState('error');
          setError(cause instanceof ApiError ? cause.message : '记住失败');
        });
      }}
    >
      {state === 'done' ? <Check /> : <BrainCircuit />}
    </button>
  );
}

function MessageError() {
  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root className="message-error" role="alert">
        <ErrorPrimitive.Message />
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  );
}
