import type { EventEnvelope } from '@kross/protocol';
import { Check, Clipboard, Copy, RotateCcw } from 'lucide-react';
import { useMemo, useState } from 'react';

import { diffLineKind, traceRunIds } from './inspection';
import { Button } from './components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from './components/ui/dialog';
import { ScrollArea } from './components/ui/scroll-area';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger
} from './components/ui/tabs';

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

  const copy = async () => {
    await navigator.clipboard.writeText(inspectionText(props.inspection));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent className="inspection">
        <DialogHeader className="inspection-header">
          <div>
            <span className="eyebrow">Session Inspection</span>
            <DialogTitle>
              {props.inspection.kind === 'diff' ? '工作区 Diff' : '运行 Trace'}
            </DialogTitle>
            <DialogDescription>
              {props.inspection.kind === 'diff'
                ? '检查当前工作区尚未提交的代码变化。'
                : '查看 Agent 运行事件和工具调用轨迹。'}
            </DialogDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => void copy()}>
            {copied ? <Check /> : <Copy />}
            {copied ? '已复制' : '复制'}
          </Button>
        </DialogHeader>

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
      </DialogContent>
    </Dialog>
  );
}

function DiffContent({
  inspection
}: {
  inspection: Extract<InspectionData, { kind: 'diff' }>;
}) {
  if (inspection.patches.length === 0) {
    return (
      <div className="inspection-empty">
        <Clipboard />
        <strong>没有 Git 变更</strong>
        <p>{inspection.summary}</p>
      </div>
    );
  }

  return (
    <div className="inspection-content">
      <pre className="inspection-summary">{inspection.summary}</pre>
      <Tabs defaultValue="patch-0" className="inspection-tabs">
        <TabsList>
          {inspection.patches.map((section, index) => (
            <TabsTrigger key={`${section.staged}-${index}`} value={`patch-${index}`}>
              {section.staged ? '已暂存变更' : '未暂存变更'}
            </TabsTrigger>
          ))}
        </TabsList>
        {inspection.patches.map((section, sectionIndex) => (
          <TabsContent
            key={`${section.staged}-${sectionIndex}`}
            value={`patch-${sectionIndex}`}
            className="inspection-tab-content"
          >
            <ScrollArea className="inspection-scroll">
              <div className="diff-view" aria-label="Git patch">
                {section.patch.split('\n').map((line, index) => (
                  <div className={`diff-line ${diffLineKind(line)}`} key={`${index}-${line}`}>
                    <span>{index + 1}</span>
                    <code>{line || ' '}</code>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </TabsContent>
        ))}
      </Tabs>
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
        {isDetail && (
          <Button variant="outline" size="sm" onClick={props.onBack}>
            <RotateCcw /> 最近运行
          </Button>
        )}
        {!isDetail && props.runIds.map((runId) => (
          <Button
            variant="outline"
            size="sm"
            key={runId}
            onClick={() => props.onSelect(runId)}
          >
            {runId}
          </Button>
        ))}
      </div>
      <ScrollArea className="inspection-scroll">
        <pre>{props.content}</pre>
      </ScrollArea>
    </div>
  );
}
