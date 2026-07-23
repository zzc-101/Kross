import type { CloudWorkspace, WorkspaceProgress } from '@kross/protocol';
import type { TFunction } from 'i18next';
import { Bot, CircleCheck, FolderGit2, Plus, Settings } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { SetupStatus } from '../../setupApi';
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Progress } from '../ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../ui/select';
import { Textarea } from '../ui/textarea';

export type WorkspaceCredential =
  | { type: 'https-token'; token: string }
  | { type: 'ssh-key'; privateKey: string };

export function EmptyState(props: {
  hasWorkspace: boolean;
  setupStatus?: SetupStatus;
  onCreate: () => void;
  onAddWorkspace: () => void;
  onOpenSetup: () => void;
}) {
  const { t } = useTranslation();
  const providerReady = Boolean(
    props.setupStatus?.provider.hasApiKey &&
    props.setupStatus.provider.model
  );
  return (
    <Card className="empty">
      <CardContent className="empty-content">
        <div className="empty-mark">K</div>
        <span className="eyebrow">{t('onboarding.eyebrow')}</span>
        <h1>{props.hasWorkspace ? t('onboarding.newSession') : t('onboarding.firstWorkspace')}</h1>
        <p>
          {props.hasWorkspace
            ? t('onboarding.sessionDescription')
            : t('onboarding.workspaceDescription')}
        </p>
        <div className="onboarding-steps">
          <Button
            variant="ghost"
            className={providerReady ? 'complete' : ''}
            onClick={props.onOpenSetup}
          >
            <span>{providerReady ? <CircleCheck /> : <Settings />}</span>
            <div>
              <strong>{t('onboarding.configureModel')}</strong>
              <small>
                {providerReady
                  ? t('onboarding.providerReady', {
                      provider: props.setupStatus?.provider.provider
                    })
                  : t('onboarding.providerHint')}
              </small>
            </div>
          </Button>
          <Button
            variant="ghost"
            className={props.hasWorkspace ? 'complete' : ''}
            onClick={props.onAddWorkspace}
          >
            <span>{props.hasWorkspace ? <CircleCheck /> : <FolderGit2 />}</span>
            <div>
              <strong>{t('onboarding.connectRepository')}</strong>
              <small>{props.hasWorkspace ? t('onboarding.workspaceReady') : t('onboarding.repositoryHint')}</small>
            </div>
          </Button>
          <Button variant="ghost" disabled={!props.hasWorkspace} onClick={props.onCreate}>
            <span><Bot /></span>
            <div><strong>{t('onboarding.createTask')}</strong><small>{t('onboarding.taskHint')}</small></div>
          </Button>
        </div>
        {props.hasWorkspace && (
          <Button onClick={props.onCreate}><Plus /> {t('session.new')}</Button>
        )}
      </CardContent>
    </Card>
  );
}

export function WorkspaceForm(props: {
  onClose: () => void;
  onCreate: (
    name: string,
    url: string,
    defaultBranch: string,
    credential?: WorkspaceCredential
  ) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('');
  const [credentialType, setCredentialType] = useState<'none' | 'https-token' | 'ssh-key'>('none');
  const [secret, setSecret] = useState('');
  const credential: WorkspaceCredential | undefined =
    credentialType === 'https-token'
      ? { type: 'https-token', token: secret }
      : credentialType === 'ssh-key'
        ? { type: 'ssh-key', privateKey: secret }
        : undefined;
  const validationError = validateWorkspaceInput(
    url,
    credentialType,
    secret,
    t
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent className="workspace-dialog">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!validationError) {
              props.onCreate(
                name.trim(),
                url.trim(),
                defaultBranch.trim(),
                credential
              );
            }
          }}
        >
          <DialogHeader>
            <span className="eyebrow">{t('workspace.dialogEyebrow')}</span>
            <DialogTitle>{t('workspace.add')}</DialogTitle>
            <DialogDescription>
              {t('workspace.description')}
            </DialogDescription>
          </DialogHeader>

          <Label className="dialog-field">
            {t('workspace.name')}
            <Input
              autoFocus
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Label>
          <Label className="dialog-field">
            Git URL
            <Input
              required
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://github.com/org/repo.git"
            />
          </Label>
          <Label className="dialog-field">
            {t('workspace.defaultBranch')}
            <Input
              value={defaultBranch}
              onChange={(event) => setDefaultBranch(event.target.value)}
              placeholder={t('workspace.autoDetect')}
              pattern="[A-Za-z0-9][A-Za-z0-9._/-]*"
            />
          </Label>
          <Label className="dialog-field">
            {t('workspace.credential')}
            <Select
              value={credentialType}
              onValueChange={(value) => {
                setCredentialType(value as typeof credentialType);
                setSecret('');
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t('workspace.publicRepository')}</SelectItem>
                <SelectItem value="https-token">{t('workspace.httpsToken')}</SelectItem>
                <SelectItem value="ssh-key">{t('workspace.sshKey')}</SelectItem>
              </SelectContent>
            </Select>
          </Label>

          {credentialType === 'https-token' && (
            <Label className="dialog-field">
              {t('workspace.token')}
              <Input
                required
                type="password"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                autoComplete="new-password"
              />
            </Label>
          )}
          {credentialType === 'ssh-key' && (
            <Label className="dialog-field">
              {t('workspace.privateKey')}
              <Textarea
                required
                rows={6}
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                autoComplete="off"
              />
            </Label>
          )}

          {url && validationError && <p className="form-error">{validationError}</p>}
          <p className="credential-note">
            {t('workspace.credentialNote')}
          </p>
          <DialogFooter className="form-actions">
            <Button type="button" variant="outline" onClick={props.onClose}>
              {t('common.cancel')}
            </Button>
            <Button disabled={Boolean(validationError)}>{t('workspace.create')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function WorkspaceActions(props: {
  workspace: CloudWorkspace;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const workspace = props.workspace;
  return (
    <Card className="workspace-actions">
      <CardHeader>
        <div className="workspace-status">
          <CardTitle>{workspace.name}</CardTitle>
          <Badge variant={workspace.status === 'ready' ? 'secondary' : 'outline'}>
            {workspaceStatusLabel(workspace.status, t)}
          </Badge>
        </div>
        <CardDescription>{workspace.gitUrl}</CardDescription>
      </CardHeader>
      <CardFooter>
        <Button variant="outline" size="sm" onClick={props.onToggle}>
          {workspace.status === 'stopped' ? t('workspace.start') : t('workspace.stop')}
        </Button>
        <Button variant="destructive" size="sm" onClick={props.onDelete}>
          {t('common.delete')}
        </Button>
      </CardFooter>
    </Card>
  );
}

export function WorkspaceProgressPanel(props: {
  progress: WorkspaceProgress;
  onClose: () => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const stages: Array<{
    id: WorkspaceProgress['stage'];
    label: string;
  }> = [
    { id: 'validating', label: t('workspace.stageValidate') },
    { id: 'provisioning', label: t('workspace.stagePrepare') },
    { id: 'cloning', label: t('workspace.stageClone') },
    { id: 'starting', label: t('workspace.stageStart') },
    { id: 'ready', label: t('workspace.stageReady') }
  ];
  const currentIndex =
    props.progress.stage === 'failed'
      ? -1
      : stages.findIndex((stage) => stage.id === props.progress.stage);
  const terminal =
    props.progress.stage === 'ready' || props.progress.stage === 'failed';
  const progressValue =
    props.progress.stage === 'failed'
      ? 0
      : Math.max(0, ((currentIndex + 1) / stages.length) * 100);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && terminal) props.onClose();
      }}
    >
      <DialogContent className={`provision-panel ${terminal ? 'terminal' : ''}`}>
        <DialogHeader>
          <span className="eyebrow">{t('workspace.provisioning')}</span>
          <DialogTitle>{props.progress.name}</DialogTitle>
          <DialogDescription role="status" aria-live="polite">
            {props.progress.message}
          </DialogDescription>
        </DialogHeader>
        <Progress
          value={progressValue}
          aria-label={t('workspace.progressLabel')}
          className={props.progress.stage === 'failed' ? 'failed' : undefined}
        />
        <div className="provision-steps">
          {stages.map((stage, index) => (
            <div
              key={stage.id}
              className={
                currentIndex > index || props.progress.stage === 'ready'
                  ? 'complete'
                  : currentIndex === index
                    ? 'active'
                    : ''
              }
            >
              <span>
                {currentIndex > index || props.progress.stage === 'ready'
                  ? '✓'
                  : index + 1}
              </span>
              <strong>{stage.label}</strong>
            </div>
          ))}
        </div>
        {props.progress.stage === 'failed' && (
          <p className="form-error">
            {t('workspace.createFailed')}
          </p>
        )}
        <DialogFooter className="form-actions">
          {props.progress.stage === 'failed' && (
            <Button variant="outline" onClick={props.onRetry}>{t('common.retry')}</Button>
          )}
          {terminal && (
            <Button onClick={props.onClose}>
              {props.progress.stage === 'ready' ? t('workspace.enter') : t('common.close')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function workspaceStatusLabel(
  status: CloudWorkspace['status'],
  t: TFunction
): string {
  return {
    ready: t('workspace.statusReady'),
    stopped: t('workspace.statusStopped'),
    creating: t('workspace.statusCreating'),
    error: t('workspace.statusError')
  }[status] ?? status;
}

function validateWorkspaceInput(
  value: string,
  credentialType: 'none' | 'https-token' | 'ssh-key',
  secret: string,
  t: TFunction
): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const scpStyle = /^[\w.-]+@[\w.-]+:.+/.test(trimmed);
  if (scpStyle) {
    if (credentialType === 'https-token') {
      return t('workspace.validation.tokenWithSsh');
    }
  } else {
    try {
      const url = new URL(trimmed);
      if (!['https:', 'ssh:', 'git:', 'git+ssh:'].includes(url.protocol)) {
        return t('workspace.validation.protocol');
      }
      if (url.username || url.password) {
        return t('workspace.validation.embeddedCredential');
      }
      if (credentialType === 'https-token' && url.protocol !== 'https:') {
        return t('workspace.validation.tokenProtocol');
      }
      if (
        credentialType === 'ssh-key' &&
        !['ssh:', 'git+ssh:'].includes(url.protocol)
      ) {
        return t('workspace.validation.sshProtocol');
      }
    } catch {
      return t('workspace.validation.completeUrl');
    }
  }
  if (credentialType !== 'none' && !secret.trim()) {
    return credentialType === 'https-token'
      ? t('workspace.validation.tokenRequired')
      : t('workspace.validation.keyRequired');
  }
  if (
    credentialType === 'ssh-key' &&
    secret &&
    !secret.includes('PRIVATE KEY')
  ) {
    return t('workspace.validation.invalidKey');
  }
  return undefined;
}
