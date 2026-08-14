import {
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive
} from '@assistant-ui/react';
import { ArrowUp } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function Thread() {
  return (
    <ThreadPrimitive.Root className="thread">
      <ThreadPrimitive.Viewport className="thread-viewport" autoScroll>
        <ThreadPrimitive.Empty>
          <div className="thread-empty">
            <div className="mark">K</div>
            <h1>今天想做什么？</h1>
            <p>这是你的长期工作区。文件、技能和记忆会留在这块盘上，新对话只换一张桌子。</p>
          </div>
        </ThreadPrimitive.Empty>
        <ThreadPrimitive.Messages components={{ Message: Bubble }} />
        <ThreadPrimitive.If running>
          <div className="typing"><i /><i /><i /><span>Agent 正在工作区里处理…</span></div>
        </ThreadPrimitive.If>
      </ThreadPrimitive.Viewport>
      <div className="composer-shell">
        <ComposerPrimitive.Root className="composer">
          <ComposerPrimitive.Input
            className="composer-input"
            placeholder="发给你的 Agent…"
            rows={1}
            autoFocus
          />
          <ComposerPrimitive.Send className="composer-send" aria-label="发送">
            <ArrowUp size={18} />
          </ComposerPrimitive.Send>
        </ComposerPrimitive.Root>
        <small>消息会唤醒你的工作区。空闲后容器会休眠，磁盘留下。</small>
      </div>
    </ThreadPrimitive.Root>
  );
}

function Bubble() {
  return (
    <MessagePrimitive.Root className="bubble">
      <MessagePrimitive.If user>
        <div className="bubble-row user">
          <div className="bubble-meta">你</div>
          <div className="bubble-body">
            <MessageText />
          </div>
        </div>
      </MessagePrimitive.If>
      <MessagePrimitive.If assistant>
        <div className="bubble-row assistant">
          <div className="bubble-meta">Agent</div>
          <div className="bubble-body">
            <MessageText />
          </div>
        </div>
      </MessagePrimitive.If>
    </MessagePrimitive.Root>
  );
}

function MessageText() {
  return (
    <MessagePrimitive.Content
      components={{
        Text: ({ text }) => <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
      }}
    />
  );
}
