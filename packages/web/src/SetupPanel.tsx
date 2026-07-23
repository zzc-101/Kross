import { AlertTriangle, Check, X } from 'lucide-react';
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
  const [restartWorkers, setRestartWorkers] = useState(
    props.workspaceCount > 0
  );
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
        restartWorkers
      );
      setApiKey('');
      setSavedMessage(
        result.restarted.length
          ? t('setup.savedWithWorkers', { count: result.restarted.length })
          : t('setup.saved')
      );
      const next = await fetchSetupStatus(props.endpoint, props.token);
      setStatus(next);
      props.onStatus(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
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

        <form className="provider-form" onSubmit={(event) => void submit(event)}>
          <div>
            <span className="eyebrow">{t('setup.provider')}</span>
            <h2>{t('setup.modelConfig')}</h2>
            <p>{t('setup.keyNotice')}</p>
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
                checked={restartWorkers}
                onCheckedChange={setRestartWorkers}
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
      </DialogContent>
    </Dialog>
  );
}
