import { useEffect, useMemo, useState } from 'react';

import {
  diffLineKind,
  parseDiffInspection,
  traceRunIds
} from './inspection';

interface InspectionPanelProps {
  kind: 'trace' | 'diff';
  content: string;
  onInspect: (kind: 'trace' | 'diff', argument?: string) => void;
  onClose: () => void;
}

export function InspectionPanel(props: InspectionPanelProps) {
  const [copied, setCopied] = useState(false);
  const runIds = useMemo(
    () => props.kind === 'trace' ? traceRunIds(props.content) : [],
    [props.content, props.kind]
  );

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [props.onClose]);

  const copy = async () => {
    await navigator.clipboard.writeText(props.content);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <section
        className="inspection"
        role="dialog"
        aria-modal="true"
        aria-labelledby="inspection-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span className="eyebrow">Session Inspection</span>
            <h2 id="inspection-title">
              {props.kind === 'diff' ? '工作区 Diff' : '运行 Trace'}
            </h2>
          </div>
          <div className="inspection-actions">
            <button onClick={() => void copy()}>
              {copied ? '已复制' : '复制'}
            </button>
            <button onClick={props.onClose}>关闭</button>
          </div>
        </header>
        {props.kind === 'diff' ? (
          <DiffContent content={props.content} />
        ) : (
          <TraceContent
            content={props.content}
            runIds={runIds}
            onSelect={(runId) => props.onInspect('trace', runId)}
            onBack={() => props.onInspect('trace')}
          />
        )}
      </section>
    </div>
  );
}

function DiffContent({ content }: { content: string }) {
  const parsed = parseDiffInspection(content);
  return (
    <div className="inspection-content">
      <pre className="inspection-summary">{parsed.summary}</pre>
      {parsed.patch && (
        <div className="diff-view" aria-label="Git patch">
          {parsed.patch.split('\n').map((line, index) => (
            <div className={`diff-line ${diffLineKind(line)}`} key={`${index}-${line}`}>
              <span>{index + 1}</span>
              <code>{line || ' '}</code>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TraceContent(props: {
  content: string;
  runIds: string[];
  onSelect: (runId: string) => void;
  onBack: () => void;
}) {
  const isDetail = props.content.startsWith('Trace:');
  return (
    <div className="inspection-content trace-content">
      <div className="trace-toolbar">
        {isDetail && <button onClick={props.onBack}>← 最近运行</button>}
        {!isDetail && props.runIds.map((runId) => (
          <button key={runId} onClick={() => props.onSelect(runId)}>
            {runId}
          </button>
        ))}
      </div>
      <pre>{props.content}</pre>
    </div>
  );
}
