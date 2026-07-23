import type { AgentResult } from '@kross/protocol';
import type { TFunction } from 'i18next';
import { ChevronRight } from 'lucide-react';
import { memo, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import { useTranslation } from 'react-i18next';

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
  const { t } = useTranslation();
  if (message.tool) {
    return (
      <article className="message tool">
        <div className="message-author">{t('session.toolRecord')}</div>
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
        {message.from === 'user'
          ? t('session.you')
          : message.from === 'thinking'
            ? t('session.thinking')
            : t('session.assistant')}
      </div>
      {message.from === 'thinking' ? (
        <ToolDisclosure label={t('session.viewThinking')}>
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
  const { t } = useTranslation();
  const details = tool.detailLines ?? [];
  return (
    <Card className={`tool-card history ${tool.status}`}>
      <CardHeader className="tool-card-header">
        <div>
          <Badge variant="outline">{t('session.tool')}</Badge>
          <CardTitle>{tool.name}</CardTitle>
        </div>
        <Badge variant={toolStatusVariant(tool.status)}>
          {toolStatusLabel(tool.status, t)}
        </Badge>
      </CardHeader>
      <CardContent className="tool-card-content">
        <CardDescription>{tool.summary || fallbackText}</CardDescription>
        {tool.inputPreview && (
          <ToolDisclosure label={t('session.viewInput')}>
            <pre>{tool.inputPreview}</pre>
          </ToolDisclosure>
        )}
        {details.length > 0 && (
          <ToolDisclosure
            label={t('session.viewDetails', {
              suffix: tool.detailTruncated ? t('session.truncated') : ''
            })}
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
                <strong>{item.path ?? item.callId ?? t('session.step', { number: index + 1 })}</strong>
                <Badge variant={toolStatusVariant(item.status)}>
                  {toolStatusLabel(item.status, t)}
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
          <span>{t('session.verification', {
            status: verificationLabel(verification.status, t)
          })}</span>
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
  const { t } = useTranslation();
  const status = type.split('.').at(-1) ?? 'running';
  return (
    <Card className={`tool-card ${status}`}>
      <CardHeader className="tool-card-header">
        <div>
          <Badge variant="outline">{t('session.tool')}</Badge>
          <CardTitle>
            {String(payload.toolName ?? payload.name ?? 'Tool')}
          </CardTitle>
        </div>
        <Badge variant={toolStatusVariant(status)}>
          {toolStatusLabel(status, t)}
        </Badge>
      </CardHeader>
      {(payload.input !== undefined || payload.contentPreview !== undefined) && (
        <CardContent className="tool-card-content">
          <ToolDisclosure label={t('session.viewCall')}>
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
  const { t } = useTranslation();
  const risk = riskPresentation(props.risk, t);
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
            aria-label={t('approval.reasonLabel')}
            placeholder={t('approval.reasonPlaceholder')}
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
          {rejecting ? t('approval.confirmReject') : t('approval.reject')}
        </Button>
        <Button
          disabled={processing}
          onClick={() => choose(true)}
        >
          {processing ? t('approval.processing') : t('approval.approveOnce')}
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
  const { t } = useTranslation();
  const status = props.pendingApproval
    ? t('status.approvalRequired')
    : props.running
      ? t('status.running')
      : props.result
        ? resultLabel(props.result.status, t)
        : t('execution.idle');
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
              <dt>{t('execution.changedFiles')}</dt>
              <dd>{props.result.report.changedFiles.length}</dd>
            </div>
            <div>
              <dt>{t('execution.verification')}</dt>
              <dd>{verificationLabel(props.result.report.verification.status, t)}</dd>
            </div>
            <div>
              <dt>{t('execution.risks')}</dt>
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

function toolStatusLabel(status: string, t: TFunction): string {
  return {
    awaiting: t('status.awaiting'),
    running: t('status.running'),
    completed: t('status.completed'),
    failed: t('status.failed'),
    denied: t('status.denied')
  }[status] ?? status;
}

function riskPresentation(value: string, t: TFunction): {
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
      label: t('approval.highRisk'),
      icon: '!',
      description: t('approval.highRiskDescription')
    };
  }
  if (normalized === 'plan' || normalized.includes('medium')) {
    return {
      level: 'medium',
      label: normalized === 'plan'
        ? t('approval.planConfirmation')
        : t('approval.confirmationRequired'),
      icon: '?',
      description: normalized === 'plan'
        ? t('approval.planDescription')
        : t('approval.mediumDescription')
    };
  }
  return {
    level: 'low',
    label: t('approval.controlled'),
    icon: '✓',
    description: t('approval.controlledDescription')
  };
}

function resultLabel(status: AgentResult['status'], t: TFunction): string {
  return {
    completed: t('execution.completed'),
    failed: t('execution.failed'),
    cancelled: t('execution.cancelled'),
    'approval-required': t('status.approvalRequired')
  }[status];
}

function verificationLabel(
  status: AgentResult['report']['verification']['status'],
  t: TFunction
): string {
  return {
    passed: t('status.passed'),
    failed: t('status.failed'),
    'not-run': t('status.notRun'),
    'not-needed': t('status.notNeeded')
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
