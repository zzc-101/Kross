import '@assistant-ui/react-markdown/styles/dot.css';

import {
  MarkdownTextPrimitive,
  unstable_memoizeMarkdownComponents as memoizeMarkdownComponents
} from '@assistant-ui/react-markdown';
import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import remarkGfm from 'remark-gfm';

const components = memoizeMarkdownComponents({
  a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a>,
  code: ({ children, ...props }) => <code {...props}>{children}</code>,
  pre: ({ children, ...props }) => <pre {...props}>{children}</pre>
});

export function MarkdownText() {
  return (
    <MarkdownTextPrimitive
      className="message-markdown"
      components={components}
      remarkPlugins={[remarkGfm]}
      defer
    />
  );
}

export function CopyButton({ value, label = '复制' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!navigator.clipboard) return;
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2_000);
  }

  return (
    <button type="button" className="inline-copy" aria-label={copied ? '已复制' : label} onClick={() => void copy()}>
      {copied ? <Check /> : <Copy />}
    </button>
  );
}
