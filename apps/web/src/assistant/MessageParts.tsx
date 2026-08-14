import type {
  FileMessagePartComponent,
  ImageMessagePartComponent,
  ReasoningMessagePartComponent,
  ToolCallMessagePartComponent
} from '@assistant-ui/react';
import { CheckCircle2, ChevronDown, CircleAlert, FileText, LoaderCircle, Wrench } from 'lucide-react';
import { useState } from 'react';

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

function printable(value: unknown) {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export const ToolFallback: ToolCallMessagePartComponent = ({ toolName, args, argsText, result, status, isError }) => {
  const [open, setOpen] = useState(false);
  const running = status?.type === 'running';
  const body = result === undefined ? (argsText || printable(args)) : printable(result);

  return (
    <section className={`tool-part${isError ? ' failed' : ''}`} data-open={open || undefined}>
      <button type="button" className="part-trigger" onClick={() => setOpen((value) => !value)}>
        {isError ? <CircleAlert /> : running ? <LoaderCircle className="spin" /> : <Wrench />}
        <span>{toolName || '工具调用'}</span>
        <small>{isError ? '失败' : running ? '运行中' : '已完成'}</small>
        <ChevronDown className="part-chevron" />
      </button>
      {open && body && <div className="tool-content"><CopyButton value={body} /><pre>{body}</pre></div>}
    </section>
  );
};

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
