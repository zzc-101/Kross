import type { AgentResult } from '@kross/protocol';
import { ChevronRight } from 'lucide-react';
import { memo, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';

import type { UiMessage } from '../../useCloud';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle
} from '../ui/card';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger
} from '../ui/collapsible';
import { ScrollArea } from '../ui/scroll-area';
import { Textarea } from '../ui/textarea';

export const Message = memo(function Message({
  message
}: {
  message: UiMessage;
}) {
  if (message.tool) {
    return (
      <article className="message tool">
        <div className="message-author">工具记录</div>
        <HistoricalToolCard
          tool={message.tool}
          fallbackText={message.text}
          verification={message.verification}
        />
      </article>
    );
  }
  return (
    <article className={`message ${message.from}`}>
      <div className="message-author">
        {message.from === 'user' ? '你' : message.from === 'thinking' ? '思考' : 'Kross'}
      </div>
      {message.from === 'thinking' ? (
        <ToolDisclosure label="查看思考过程">
          <pre>{message.text}</pre>
        </ToolDisclosure>
      ) : <ReactMarkdown>{message.text}</ReactMarkdown>}
    </article>
  );
});

function HistoricalToolCard({
  tool,
  fallbackText,
  verification
}: {
  tool: NonNullable<UiMessage['tool']>;
  fallbackText: string;
  verification?: UiMessage['verification'];
}) {
  const details = tool.detailLines ?? [];
  return (
    <Card className={`tool-card history ${tool.status}`}>
      <CardHeader className="tool-card-header">
        <div>
          <Badge variant="outline">工具</Badge>
          <CardTitle>{tool.name}</CardTitle>
        </div>
        <Badge variant={toolStatusVariant(tool.status)}>
          {toolStatusLabel(tool.status)}
        </Badge>
      </CardHeader>
      <CardContent className="tool-card-content">
        <CardDescription>{tool.summary || fallbackText}</CardDescription>
        {tool.inputPreview && (
          <ToolDisclosure label="查看输入">
            <pre>{tool.inputPreview}</pre>
          </ToolDisclosure>
        )}
        {details.length > 0 && (
          <ToolDisclosure
            label={`查看执行明细${tool.detailTruncated ? '（已截断）' : ''}`}
          >
            <pre className="tool-detail">
              {details.map((line, index) => (
                <span className={line.op ? `diff-${line.op}` : undefined} key={index}>
                  {line.lineNo ? `${line.lineNo} ` : ''}
                  {line.text}
                  {'\n'}
                </span>
              ))}
            </pre>
          </ToolDisclosure>
        )}
        {tool.items && tool.items.length > 0 && (
          <ul className="tool-items">
            {tool.items.map((item, index) => (
              <li key={`${item.callId ?? item.path ?? index}`}>
                <strong>{item.path ?? item.callId ?? `步骤 ${index + 1}`}</strong>
                <Badge variant={toolStatusVariant(item.status)}>
                  {toolStatusLabel(item.status)}
                </Badge>
                {(item.summary || item.preview) && (
                  <small>{item.summary ?? item.preview}</small>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <CardFooter className="tool-card-footer">
        {tool.durationMs !== undefined && <span>{tool.durationMs} ms</span>}
        {(tool.linesAdded !== undefined || tool.linesRemoved !== undefined) && (
          <span>
            <ins>+{tool.linesAdded ?? 0}</ins>{' '}
            <del>-{tool.linesRemoved ?? 0}</del>
          </span>
        )}
        {verification && (
          <span>验证：{verificationLabel(verification.status)}</span>
        )}
      </CardFooter>
    </Card>
  );
}

function ToolDisclosure(props: {
  label: string;
  children: ReactNode;
}) {
  return (
    <Collapsible className="tool-disclosure">
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm" className="tool-disclosure-trigger">
          <ChevronRight />
          {props.label}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {props.children}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ToolCard({
  type,
  payload
}: {
  type: string;
  payload: Record<string, unknown>;
}) {
  const status = type.split('.').at(-1) ?? 'running';
  return (
    <Card className={`tool-card ${status}`}>
      <CardHeader className="tool-card-header">
        <div>
          <Badge variant="outline">工具</Badge>
          <CardTitle>
            {String(payload.toolName ?? payload.name ?? 'Tool')}
          </CardTitle>
        </div>
        <Badge variant={toolStatusVariant(status)}>
          {toolStatusLabel(status)}
        </Badge>
      </CardHeader>
      {(payload.input !== undefined || payload.contentPreview !== undefined) && (
        <CardContent className="tool-card-content">
          <ToolDisclosure label="查看调用内容">
            <pre>{formatToolValue(payload.input ?? payload.contentPreview)}</pre>
          </ToolDisclosure>
        </CardContent>
      )}
    </Card>
  );
}

export function ApprovalCard(props: {
  title: string;
  detail: string;
  risk: string;
  onChoose: (approved: boolean, reason?: string) => void;
}) {
  const risk = riskPresentation(props.risk);
  const [processing, setProcessing] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const choose = (approved: boolean) => {
    if (!approved && !rejecting) {
      setRejecting(true);
      return;
    }
    setProcessing(true);
    props.onChoose(approved, approved ? undefined : reason.trim() || undefined);
  };
  return (
    <Card
      className={`approval risk-${risk.level}`}
      role="region"
      aria-label={props.title}
    >
      <CardHeader className="approval-header">
        <div className="approval-icon">{risk.icon}</div>
        <div>
          <Badge variant={risk.level === 'high' ? 'destructive' : 'outline'}>
            {risk.label}
          </Badge>
          <CardTitle>{props.title}</CardTitle>
          <CardDescription>{risk.description}</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="approval-body">
        <ScrollArea className="approval-detail">
          <pre>{props.detail}</pre>
        </ScrollArea>
        {rejecting && (
          <Textarea
            aria-label="拒绝原因"
            placeholder="可选：告诉 Agent 应该如何调整"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            disabled={processing}
            rows={2}
          />
        )}
      </CardContent>
      <CardFooter className="approval-actions">
        <Button
          variant="outline"
          disabled={processing}
          onClick={() => choose(false)}
        >
          {rejecting ? '确认拒绝' : '拒绝'}
        </Button>
        <Button
          disabled={processing}
          onClick={() => choose(true)}
        >
          {processing ? '处理中…' : '仅批准这一次'}
        </Button>
      </CardFooter>
    </Card>
  );
}

export function ExecutionSummary(props: {
  running: boolean;
  pendingApproval: boolean;
  result?: AgentResult;
}) {
  const status = props.pendingApproval
    ? '等待审批'
    : props.running
      ? '执行中'
      : props.result
        ? resultLabel(props.result.status)
        : '尚未运行';
  return (
    <Card className="execution-summary">
      <CardHeader>
        <div>
          <span className={`run-status ${props.running ? 'running' : ''}`} />
          <CardTitle>{status}</CardTitle>
        </div>
      </CardHeader>
      {props.result && (
        <CardContent>
          <CardDescription>{props.result.summary}</CardDescription>
          <dl>
            <div>
              <dt>修改文件</dt>
              <dd>{props.result.report.changedFiles.length}</dd>
            </div>
            <div>
              <dt>验证</dt>
              <dd>{verificationLabel(props.result.report.verification.status)}</dd>
            </div>
            <div>
              <dt>风险</dt>
              <dd>{props.result.report.risks.length}</dd>
            </div>
          </dl>
        </CardContent>
      )}
    </Card>
  );
}

function toolStatusVariant(
  status: string
): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'failed' || status === 'denied') return 'destructive';
  if (status === 'completed') return 'secondary';
  if (status === 'running') return 'default';
  return 'outline';
}

function toolStatusLabel(status: string): string {
  return {
    awaiting: '等待中',
    running: '执行中',
    completed: '已完成',
    failed: '失败',
    denied: '已拒绝'
  }[status] ?? status;
}

function riskPresentation(value: string): {
  level: 'low' | 'medium' | 'high';
  label: string;
  description: string;
  icon: string;
} {
  const normalized = value.toLowerCase();
  if (
    normalized.includes('high') ||
    normalized.includes('destructive') ||
    normalized.includes('danger')
  ) {
    return {
      level: 'high',
      label: '高风险',
      icon: '!',
      description: '该操作可能造成不可逆变化，请确认范围和参数。'
    };
  }
  if (normalized === 'plan' || normalized.includes('medium')) {
    return {
      level: 'medium',
      label: normalized === 'plan' ? '计划确认' : '需要确认',
      icon: '?',
      description: normalized === 'plan'
        ? '批准后 Agent 将按此计划开始执行。'
        : '该操作会改变工作区，请确认后继续。'
    };
  }
  return {
    level: 'low',
    label: '受控操作',
    icon: '✓',
    description: '审批只对本次工具调用生效。'
  };
}

function resultLabel(status: AgentResult['status']): string {
  return {
    completed: '执行完成',
    failed: '执行失败',
    cancelled: '已取消',
    'approval-required': '等待审批'
  }[status];
}

function verificationLabel(
  status: AgentResult['report']['verification']['status']
): string {
  return {
    passed: '已通过',
    failed: '失败',
    'not-run': '未运行',
    'not-needed': '无需验证'
  }[status];
}

function formatToolValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
