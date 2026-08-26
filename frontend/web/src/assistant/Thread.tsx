import { useContext, useEffect, useRef, useState, type ReactNode } from 'react';

import './Thread.css';
import {
  ActionBarPrimitive,
  AuiIf,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  unstable_useComposerInput
} from '@assistant-ui/react';
import {
  ArrowDown,
  ArrowUp,
  BarChart3,
  Check,
  ChevronDown,
  Copy,
  FileText,
  Lightbulb,
  LoaderCircle,
  Mic,
  PencilLine,
  Plus,
  Sparkles,
  X
} from 'lucide-react';

import { messagePartComponents } from './MessageParts';
import { AgentApiClient } from '../api/client';
import type { AgentModel, Skill } from '../api/types';
import { AgentContextUsageContext } from './AgentRuntimeProvider';
import { ContextUsageRing } from './ContextUsageRing';

function modelLabel(model?: AgentModel | null): string {
  return model?.model ?? '未配置模型';
}

export function Thread({
  api,
  conversationId,
  model,
  models,
  skill,
  onCancelSkill,
  onModelChange
}: {
  api: AgentApiClient;
  conversationId?: string;
  model?: AgentModel | null;
  models: AgentModel[];
  skill?: Skill;
  onCancelSkill?: () => void;
  onModelChange(model: AgentModel): void;
}) {
  return (
    <ThreadPrimitive.Root className="thread">
      <ThreadPrimitive.Viewport className="thread-viewport" autoScroll>
        <ThreadPrimitive.If empty>
          <div className="landing">
            <div className="landing-content">
              <div className="landing-greeting"><h1>{skill ? skill.name : 'How can I help you today?'}</h1></div>
              <Composer
                model={model}
                models={models}
                skill={skill}
                onCancelSkill={onCancelSkill}
                onModelChange={onModelChange}
                landing
              />
            </div>
            <Footer />
          </div>
        </ThreadPrimitive.If>

        <ThreadPrimitive.If empty={false}>
          <div className="message-list">
            <ThreadPrimitive.Messages components={{
              Message: () => <ConversationMessage />
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
                model={model}
                models={models}
                skill={skill}
                onCancelSkill={onCancelSkill}
                onModelChange={onModelChange}
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
  model,
  models,
  skill,
  onCancelSkill,
  onModelChange,
  landing = false
}: {
  model?: AgentModel | null;
  models: AgentModel[];
  skill?: Skill;
  onCancelSkill?: () => void;
  onModelChange(model: AgentModel): void;
  landing?: boolean;
}) {
  const latestContextUsage = useContext(AgentContextUsageContext);
  const contextWindow = latestContextUsage?.contextWindow ?? model?.contextWindow ?? 256_000;
  const usedTokens = latestContextUsage?.usedTokens ?? 0;

  return (
    <div className="composer-wrap">
      <ComposerPrimitive.Root className="composer">
        {skill && (
          <div className="composer-skill-chip">
            <Sparkles />
            <span>{skill.name}</span>
            {onCancelSkill && (
              <button type="button" aria-label={`取消应用 ${skill.name}`} onClick={onCancelSkill}><X /></button>
            )}
          </div>
        )}
        <ComposerPrimitive.Input
          className="composer-input"
          placeholder={skill?.starterPrompt || '发送消息…'}
          rows={1}
          autoFocus
          aria-label="消息内容"
        />
        <div className="composer-toolbar">
          <div className="composer-tools">
            <button type="button" aria-label="从本地上传文件（即将支持）" title="本地文件上传即将支持" disabled>
              <Plus />
            </button>
            <ModelMenu model={model} models={models} onChange={onModelChange} />
          </div>
          <div className="composer-tools right">
            <ContextUsageRing usedTokens={usedTokens} contextWindow={contextWindow} />
            <button type="button" aria-label="语音输入（即将支持）" title="语音输入即将支持" disabled>
              <Mic />
            </button>
            <ComposerPrimitive.Send className="composer-send" aria-label="发送"><ArrowUp /></ComposerPrimitive.Send>
          </div>
        </div>
      </ComposerPrimitive.Root>
      {landing && <QuickActions />}
    </div>
  );
}

function ModelMenu({
  model,
  models,
  onChange
}: {
  model?: AgentModel | null;
  models: AgentModel[];
  onChange(model: AgentModel): void;
}) {
  return (
    <Dropdown
      label={modelLabel(model)}
      ariaLabel="当前模型"
      disabled={models.length === 0}
    >
      {models.map((item) => (
        <button
          type="button"
          key={item.id}
          className={item.id === model?.id ? 'menu-item active' : 'menu-item'}
          onClick={() => onChange(item)}
        >
          <span>{modelLabel(item)}</span>
        </button>
      ))}
    </Dropdown>
  );
}

function Dropdown({
  label,
  ariaLabel,
  disabled,
  children
}: {
  label: string;
  ariaLabel: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onPointer);
    return () => window.removeEventListener('mousedown', onPointer);
  }, [open]);
  return (
    <div className="composer-menu" ref={root}>
      <button
        type="button"
        className="composer-model"
        aria-label={ariaLabel}
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{label}</span>
        <ChevronDown />
      </button>
      {open && (
        <div className="composer-menu-list" role="menu" onClick={() => setOpen(false)}>
          {children}
        </div>
      )}
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

function ConversationMessage() {
  return (
    <MessagePrimitive.Root className="bubble">
      <MessagePrimitive.If user>
        <div className="bubble-row user">
          <div className="bubble-body"><MessagePrimitive.Content components={messagePartComponents} /></div>
          <MessageActions />
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

function MessageError() {
  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root className="message-error" role="alert">
        <ErrorPrimitive.Message />
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  );
}
