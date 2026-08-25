import type {
  FileMessagePartComponent,
  ImageMessagePartComponent,
  ReasoningMessagePartComponent,
  ToolCallMessagePartComponent
} from '@assistant-ui/react';
import { CheckCircle2, ChevronDown, CircleAlert, FileText, LoaderCircle, ShieldAlert } from 'lucide-react';
import { useState } from 'react';

import './MessageParts.css';

import { CopyButton, MarkdownText } from './MarkdownText';

export const ReasoningPart: ReasoningMessagePartComponent = ({ text, status }) => {
  const [open, setOpen] = useState(status?.type === 'running');
  const running = status?.type === 'running';

  return (
    <section className="reasoning-part" data-open={open || undefined}>
      <button type="button" className="part-trigger" onClick={() => setOpen((value) => !value)}>
        {running ? <LoaderCircle className="spin" /> : <CheckCircle2 />}
        <span>{running ? '正在思考' : '思考过程'}</span>
        <ChevronDown className="part-chevron" />
      </button>
      {open && <div className="reasoning-content">{text}</div>}
    </section>
  );
};

export const ToolFallback: ToolCallMessagePartComponent = ({
  toolName,
  result,
  status,
  isError,
  approval,
  respondToApproval
}) => {
  const running = status?.type === 'running';
  const awaitingApproval = approval && approval.approved === undefined && !approval.resolution;
  const label = friendlyToolLabel(toolName);

  return (
    <section className={`tool-part${isError ? ' failed' : ''}`}>
      <div className="part-trigger">
        {isError ? <CircleAlert /> : awaitingApproval ? <ShieldAlert /> : running ? <LoaderCircle className="spin" /> : <CheckCircle2 />}
        <span>{label}</span>
        <small>{isError ? '未完成' : awaitingApproval ? '需要确认' : running ? '进行中' : '已完成'}</small>
      </div>
      {awaitingApproval && (
        <div className="approval-panel">
          <div><strong>是否继续这项外部操作？</strong><span>这一步会访问或修改工作区之外的服务。</span></div>
          <div className="approval-actions">
            <button type="button" className="approval-reject" onClick={() => respondToApproval({ approved: false })}>取消</button>
            <button type="button" className="approval-allow" onClick={() => respondToApproval({ approved: true })}>确认继续</button>
          </div>
        </div>
      )}
      {isError && result && <div className="tool-content"><CopyButton value={result} /><pre>{result}</pre></div>}
    </section>
  );
};

function friendlyToolLabel(toolName: string): string {
  if (['Read', 'List', 'Glob', 'Grep', 'Rg', 'Stat'].includes(toolName)) return '查看资料';
  if (['Write', 'Edit', 'Delete', 'Move'].includes(toolName)) return '更新文件';
  if (toolName === 'Task') return '处理子任务';
  if (toolName === 'TodoWrite' || toolName === 'TodoRead') return '更新任务进度';
  return '使用连接服务';
}

export const FilePart: FileMessagePartComponent = ({ filename, mimeType }) => (
  <div className="file-part"><FileText /><span>{filename || '文件'}</span><small>{mimeType}</small></div>
);

export const ImagePart: ImageMessagePartComponent = ({ image, filename }) => (
  <figure className="image-part"><img src={image} alt={filename || '对话图片'} />{filename && <figcaption>{filename}</figcaption>}</figure>
);

export const messagePartComponents = {
  Text: MarkdownText,
  Reasoning: ReasoningPart,
  File: FilePart,
  Image: ImagePart,
  tools: { Fallback: ToolFallback }
};
