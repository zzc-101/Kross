import { useEffect, useRef, useState, type ReactNode } from 'react';
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
  CloudSun,
  Code2,
  Copy,
  Lightbulb,
  LoaderCircle,
  PencilLine
} from 'lucide-react';

import { messagePartComponents } from './MessageParts';
import type { AgentMode, AgentModel } from '../api/types';
import { ModelBadge, modelLabel } from '../workspace/ModelBadge';

const MODE_OPTIONS: Array<{ id: AgentMode; label: string; hint: string }> = [
  { id: 'auto', label: '自动', hint: '按话术选择工作方式' },
  { id: 'plan', label: '计划', hint: '先给出计划再动手' },
  { id: 'conductor', label: '指挥', hint: '拆成多目标并行推进' }
];

export function Thread({
  model,
  models,
  mode,
  onModeChange,
  onModelChange
}: {
  model?: AgentModel | null;
  models: AgentModel[];
  mode: AgentMode;
  onModeChange(mode: AgentMode): void;
  onModelChange(model: AgentModel): void;
}) {
  return (
    <ThreadPrimitive.Root className="thread">
      <ThreadPrimitive.Viewport className="thread-viewport" autoScroll>
        <ThreadPrimitive.If empty>
          <div className="landing">
            <div className="landing-content">
              <div className="landing-greeting"><h1>How can I help you today?</h1></div>
              <Composer
                model={model}
                models={models}
                mode={mode}
                onModeChange={onModeChange}
                onModelChange={onModelChange}
                landing
              />
            </div>
            <Footer />
          </div>
        </ThreadPrimitive.If>

        <ThreadPrimitive.If empty={false}>
          <div className="message-list">
            <ThreadPrimitive.Messages components={{ Message: ConversationMessage }} />
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
                mode={mode}
                onModeChange={onModeChange}
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
  mode,
  onModeChange,
  onModelChange,
  landing = false
}: {
  model?: AgentModel | null;
  models: AgentModel[];
  mode: AgentMode;
  onModeChange(mode: AgentMode): void;
  onModelChange(model: AgentModel): void;
  landing?: boolean;
}) {
  return (
    <div className="composer-wrap">
      <ComposerPrimitive.Root className="composer">
        <ComposerPrimitive.Input
          className="composer-input"
          placeholder="发送消息…"
          rows={1}
          autoFocus
          aria-label="消息内容"
        />
        <div className="composer-toolbar">
          <div className="composer-tools">
            <ModeMenu mode={mode} onChange={onModeChange} />
            <ModelMenu model={model} models={models} onChange={onModelChange} />
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

function ModeMenu({ mode, onChange }: { mode: AgentMode; onChange(mode: AgentMode): void }) {
  const current = MODE_OPTIONS.find((item) => item.id === mode) ?? MODE_OPTIONS[0];
  return (
    <Dropdown
      label={current.label}
      ariaLabel={`工作模式：${current.label}`}
    >
      {MODE_OPTIONS.map((item) => (
        <button
          type="button"
          key={item.id}
          className={item.id === mode ? 'menu-item active' : 'menu-item'}
          onClick={() => onChange(item.id)}
        >
          <strong>{item.label}</strong>
          <span>{item.hint}</span>
        </button>
      ))}
    </Dropdown>
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
      leading={<ModelBadge model={model} />}
      disabled={models.length === 0}
    >
      {models.map((item) => (
        <button
          type="button"
          key={item.id}
          className={item.id === model?.id ? 'menu-item active' : 'menu-item'}
          onClick={() => onChange(item)}
        >
          <ModelBadge model={item} />
          <span>{modelLabel(item)}</span>
        </button>
      ))}
    </Dropdown>
  );
}

function Dropdown({
  label,
  ariaLabel,
  leading,
  disabled,
  children
}: {
  label: string;
  ariaLabel: string;
  leading?: ReactNode;
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
        {leading}
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
  { label: 'Weather', prompt: 'Check the weather and help me plan around it.', icon: CloudSun },
  { label: 'Code', prompt: 'Help me write and review some code.', icon: Code2 },
  { label: 'Write', prompt: 'Help me draft and improve a piece of writing.', icon: PencilLine },
  { label: 'Analyze', prompt: 'Analyze this problem and give me a clear breakdown.', icon: BarChart3 },
  { label: 'Brainstorm', prompt: 'Brainstorm practical ideas with me.', icon: Lightbulb }
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
      <span>Kross Agent – Every AI for Everyone.</span>
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
