import type { ModelProfile } from '@kross/protocol';
import { AlertTriangle, Check, Server, Trash2, X } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { Badge } from './components/ui/badge';
import { Button } from './components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from './components/ui/dialog';
import { Input } from './components/ui/input';
import { Label } from './components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from './components/ui/select';
import { Switch } from './components/ui/switch';
import {
  fetchSetupStatus,
  saveProvider,
  type ProviderInput,
  type SetupStatus
} from './setupApi';

interface SetupPanelProps {
  endpoint: string;
  token: string;
  workspaceCount: number;
  workspaceId?: string;
  models: ModelProfile[];
  onSaveWorkspaceProvider: (profile: {
    label: string;
    provider: ProviderInput['provider'];
    model: string;
    baseUrl?: string;
    apiKey: string;
  }) => void;
  onDeleteWorkspaceProvider: (profileId: string) => void;
  onClose: () => void;
  onStatus: (status: SetupStatus) => void;
}

const PROVIDERS: Array<{
  value: ProviderInput['provider'];
  label: string;
  model: string;
}> = [
  { value: 'openai', label: 'OpenAI', model: 'gpt-5.2' },
  { value: 'anthropic', label: 'Anthropic', model: 'claude-sonnet-4-5' },
  { value: 'openrouter', label: 'OpenRouter', model: 'openai/gpt-5.2' },
  { value: 'deepseek', label: 'DeepSeek', model: 'deepseek-chat' },
  { value: 'xai', label: 'xAI', model: 'grok-4' }
];

export function SetupPanel(props: SetupPanelProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<SetupStatus>();
  const [provider, setProvider] =
    useState<ProviderInput['provider']>('openai');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [applyToWorkers, setApplyToWorkers] = useState(
    props.workspaceCount > 0
  );
  const [privateLabel, setPrivateLabel] = useState('');
  const [privateProvider, setPrivateProvider] =
    useState<ProviderInput['provider']>('openai');
  const [privateModel, setPrivateModel] = useState('');
  const [privateBaseUrl, setPrivateBaseUrl] = useState('');
  const [privateApiKey, setPrivateApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [savedMessage, setSavedMessage] = useState<string>();

  useEffect(() => {
    void fetchSetupStatus(props.endpoint, props.token)
      .then((next) => {
        setStatus(next);
        props.onStatus(next);
        if (next.provider.provider) setProvider(next.provider.provider);
        if (next.provider.model) setModel(next.provider.model);
        if (next.provider.baseUrl) setBaseUrl(next.provider.baseUrl);
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason))
      );
  }, [props.endpoint, props.token]);

  const changeProvider = (next: ProviderInput['provider']) => {
    setProvider(next);
    const recommendation = PROVIDERS.find((item) => item.value === next);
    setModel(recommendation?.model ?? '');
    setBaseUrl('');
    setApiKey('');
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    setSavedMessage(undefined);
    try {
      const result = await saveProvider(
        props.endpoint,
        props.token,
        {
          provider,
          model: model.trim(),
          ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {})
        },
        applyToWorkers
      );
      setApiKey('');
      setSavedMessage(
        result.updated.length
          ? t('setup.savedWithWorkers', { count: result.updated.length })
          : t('setup.saved')
      );
      if (result.failed.length > 0) {
        setError(t('setup.workerUpdateFailed', { count: result.failed.length }));
      }
      const next = await fetchSetupStatus(props.endpoint, props.token);
      setStatus(next);
      props.onStatus(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const submitPrivate = (event: FormEvent) => {
    event.preventDefault();
    props.onSaveWorkspaceProvider({
      label: privateLabel.trim(),
      provider: privateProvider,
      model: privateModel.trim(),
      ...(privateBaseUrl.trim() ? { baseUrl: privateBaseUrl.trim() } : {}),
      apiKey: privateApiKey.trim()
    });
    setPrivateLabel('');
    setPrivateModel('');
    setPrivateBaseUrl('');
    setPrivateApiKey('');
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent className="setup-panel">
        <DialogHeader>
          <span className="eyebrow">{t('setup.eyebrow')}</span>
          <DialogTitle>{t('setup.title')}</DialogTitle>
          <DialogDescription>
            {t('setup.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="setup-checks">
          {status?.checks.map((check) => {
            const StatusIcon =
              check.status === 'passed'
                ? Check
                : check.status === 'failed'
                  ? X
                  : AlertTriangle;
            return (
              <article key={check.id} className={`setup-check ${check.status}`}>
                <span><StatusIcon /></span>
                <div>
                  <div className="setup-check-title">
                    <strong>{check.label}</strong>
                    <Badge
                      variant={
                        check.status === 'failed'
                          ? 'destructive'
                          : check.status === 'passed'
                            ? 'secondary'
                            : 'outline'
                      }
                    >
                      {check.status === 'passed'
                        ? t('setup.passed')
                        : check.status === 'failed'
                          ? t('setup.failed')
                          : t('setup.warning')}
                    </Badge>
                  </div>
                  <small>{check.detail}</small>
                </div>
              </article>
            );
          }) ?? <p className="quiet">{t('setup.checking')}</p>}
        </div>

        <section className="worker-admin">
          <div>
            <span className="eyebrow">{t('setup.workers')}</span>
            <h2>{t('setup.workerTitle')}</h2>
          </div>
          <div className="worker-list">
            {status?.workers.length ? status.workers.map((worker) => (
              <article className="worker-row" key={worker.workspaceId}>
                <span className={worker.running ? 'worker-online' : 'worker-offline'}>
                  <Server />
                </span>
                <div>
                  <strong>{worker.name}</strong>
                  <small>{worker.containerName}</small>
                </div>
                <Badge variant={worker.running ? 'secondary' : 'outline'}>
                  {worker.running ? t('setup.running') : t('setup.stopped')}
                </Badge>
              </article>
            )) : (
              <p className="quiet">{t('setup.noWorkers')}</p>
            )}
          </div>
        </section>

        <form className="provider-form" onSubmit={(event) => void submit(event)}>
          <div>
            <span className="eyebrow">{t('setup.provider')}</span>
            <h2>{t('setup.modelConfig')}</h2>
            <p>{t('setup.keyNotice')}</p>
            {status && (
              <Badge variant="outline">
                {t(`setup.source.${status.provider.source}`)}
              </Badge>
            )}
          </div>

          <div className="provider-grid">
            <Label className="setup-field">
              {t('setup.providerLabel')}
              <Select
                value={provider}
                onValueChange={(value) =>
                  changeProvider(value as ProviderInput['provider'])
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROVIDERS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Label>
            <Label className="setup-field">
              {t('setup.modelId')}
              <Input
                required
                value={model}
                onChange={(event) => setModel(event.target.value)}
              />
            </Label>
          </div>

          <Label className="setup-field">
            {t('setup.baseUrl')}
            <Input
              inputMode="url"
              placeholder={t('setup.baseUrlPlaceholder')}
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </Label>

          <Label className="setup-field">
            API Key
            <Input
              type="password"
              autoComplete="new-password"
              required={!status?.provider.hasApiKey}
              placeholder={
                status?.provider.hasApiKey
                  ? t('setup.keyConfigured')
                  : t('setup.keyRequired')
              }
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </Label>

          {props.workspaceCount > 0 && (
            <Label className="restart-option">
              <span>
                {t('setup.restartWorkers')}
                <small>{t('setup.restartHint')}</small>
              </span>
              <Switch
                checked={applyToWorkers}
                onCheckedChange={setApplyToWorkers}
                aria-label={t('setup.restartWorkers')}
              />
            </Label>
          )}

          {error && <p className="form-error" role="alert">{error}</p>}
          {savedMessage && (
            <p className="form-success" role="status">{savedMessage}</p>
          )}

          <DialogFooter className="form-actions">
            <Button type="button" variant="outline" onClick={props.onClose}>
              {t('common.cancel')}
            </Button>
            <Button disabled={saving}>
              {saving ? t('setup.saving') : t('setup.save')}
            </Button>
          </DialogFooter>
        </form>

        {props.workspaceId && (
          <section className="workspace-provider-admin">
            <div>
              <span className="eyebrow">{t('setup.workspaceModels')}</span>
              <h2>{t('setup.workspaceModelTitle')}</h2>
              <p>{t('setup.workspaceModelNotice')}</p>
            </div>
            <div className="workspace-provider-list">
              {props.models
                .filter((profile) => profile.scope === 'workspace')
                .map((profile) => (
                  <article key={profile.id}>
                    <div>
                      <strong>{profile.label}</strong>
                      <small>{profile.provider} · {profile.model}</small>
                    </div>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={t('common.delete')}
                      onClick={() => props.onDeleteWorkspaceProvider(profile.id)}
                    >
                      <Trash2 />
                    </Button>
                  </article>
                ))}
            </div>
            <form className="provider-form private-provider-form" onSubmit={submitPrivate}>
              <div className="provider-grid">
                <Label className="setup-field">
                  {t('setup.profileName')}
                  <Input required value={privateLabel} onChange={(event) => setPrivateLabel(event.target.value)} />
                </Label>
                <Label className="setup-field">
                  {t('setup.providerLabel')}
                  <Select
                    value={privateProvider}
                    onValueChange={(value) => setPrivateProvider(value as ProviderInput['provider'])}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {PROVIDERS.map((item) => (
                        <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Label>
                <Label className="setup-field">
                  {t('setup.modelId')}
                  <Input required value={privateModel} onChange={(event) => setPrivateModel(event.target.value)} />
                </Label>
                <Label className="setup-field">
                  API Key
                  <Input required type="password" autoComplete="new-password" value={privateApiKey} onChange={(event) => setPrivateApiKey(event.target.value)} />
                </Label>
              </div>
              <Label className="setup-field">
                {t('setup.baseUrl')}
                <Input inputMode="url" value={privateBaseUrl} onChange={(event) => setPrivateBaseUrl(event.target.value)} />
              </Label>
              <Button>{t('setup.addWorkspaceModel')}</Button>
            </form>
          </section>
        )}
      </DialogContent>
    </Dialog>
  );
}
