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
  Mic,
  PencilLine,
  Plus
} from 'lucide-react';

import { messagePartComponents } from './MessageParts';
import type { AgentModel } from '../api/types';
import { ModelBadge, modelLabel } from '../workspace/ModelBadge';

export function Thread({ model }: { model?: AgentModel | null }) {
  return (
    <ThreadPrimitive.Root className="thread">
      <ThreadPrimitive.Viewport className="thread-viewport" autoScroll>
        <ThreadPrimitive.If empty>
          <div className="landing">
            <div className="landing-content">
              <div className="landing-greeting"><h1>How can I help you today?</h1></div>
              <Composer model={model} landing />
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
            <div className="composer-docked"><Composer model={model} /><Footer /></div>
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

function Composer({ model, landing = false }: { model?: AgentModel | null; landing?: boolean }) {
  return (
    <div className="composer-wrap">
      <ComposerPrimitive.Root className="composer">
        <ComposerPrimitive.Input
          className="composer-input"
          placeholder="Send a message... (@ to mention, / for commands)"
          rows={1}
          autoFocus
          aria-label="消息内容"
        />
        <div className="composer-toolbar">
          <div className="composer-tools">
            <button type="button" aria-label="添加附件（即将支持）" title="等待 Kross 附件协议支持" disabled><Plus /></button>
            <button type="button" className="composer-model" aria-label="当前模型">
              <ModelBadge model={model} />
              <span>{modelLabel(model)}</span>
              <ChevronDown />
            </button>
          </div>
          <div className="composer-tools right">
            <button type="button" aria-label="语音输入（即将支持）" title="等待语音协议支持" disabled><Mic /></button>
            <ComposerPrimitive.Send className="composer-send" aria-label="发送"><ArrowUp /></ComposerPrimitive.Send>
          </div>
        </div>
      </ComposerPrimitive.Root>
      {landing && <QuickActions />}
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
      <span>Kross Agent – Every AI for Everyone.</span><i />
      <button type="button">隐私政策</button><button type="button">服务政策</button>
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
