import { useEffect, useMemo, useState } from 'react';
import type { EventEnvelope } from '@kross/protocol';

import {
  diffLineKind,
  traceRunIds
} from './inspection';

type InspectionData = Extract<
  EventEnvelope['event'],
  { type: 'inspection.result' }
>['data'];

interface InspectionPanelProps {
  inspection: InspectionData;
  onInspect: (kind: 'trace' | 'diff', argument?: string) => void;
  onClose: () => void;
}

export function InspectionPanel(props: InspectionPanelProps) {
  const [copied, setCopied] = useState(false);
  const runIds = useMemo(
    () =>
      props.inspection.kind === 'trace'
        ? traceRunIds(props.inspection.content)
        : [],
    [props.inspection]
  );

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [props.onClose]);

  const copy = async () => {
    await navigator.clipboard.writeText(inspectionText(props.inspection));
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
              {props.inspection.kind === 'diff' ? '工作区 Diff' : '运行 Trace'}
            </h2>
          </div>
          <div className="inspection-actions">
            <button onClick={() => void copy()}>
              {copied ? '已复制' : '复制'}
            </button>
            <button onClick={props.onClose}>关闭</button>
          </div>
        </header>
        {props.inspection.kind === 'diff' ? (
          <DiffContent inspection={props.inspection} />
        ) : (
          <TraceContent
            content={props.inspection.content}
            runIds={runIds}
            onSelect={(runId) => props.onInspect('trace', runId)}
            onBack={() => props.onInspect('trace')}
          />
        )}
      </section>
    </div>
  );
}

function DiffContent({
  inspection
}: {
  inspection: Extract<InspectionData, { kind: 'diff' }>;
}) {
  return (
    <div className="inspection-content">
      <pre className="inspection-summary">{inspection.summary}</pre>
      {inspection.patches.length === 0 && <p className="quiet">没有 Git 变更。</p>}
      {inspection.patches.map((section, sectionIndex) => (
        <details key={`${section.staged}-${sectionIndex}`} open>
          <summary>{section.staged ? '已暂存变更' : '未暂存变更'}</summary>
          <div className="diff-view" aria-label="Git patch">
            {section.patch.split('\n').map((line, index) => (
              <div className={`diff-line ${diffLineKind(line)}`} key={`${index}-${line}`}>
                <span>{index + 1}</span>
                <code>{line || ' '}</code>
              </div>
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}

function inspectionText(inspection: InspectionData): string {
  if (inspection.kind === 'trace') return inspection.content;
  return [
    inspection.summary,
    ...inspection.patches.map(
      (section) =>
        `${section.staged ? '# 已暂存变更' : '# 未暂存变更'}\n${section.patch}`
    )
  ].join('\n\n');
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
