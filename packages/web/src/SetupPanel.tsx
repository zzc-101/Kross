import { AlertTriangle, Check, X } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';

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
          ? `配置已保存，并重建了 ${result.restarted.length} 个 Worker`
          : '配置已安全保存，新建 Worker 将立即使用'
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
          <span className="eyebrow">环境与模型</span>
          <DialogTitle>运行环境检查</DialogTitle>
          <DialogDescription>
            确认 Agent 执行所需的基础能力，并安全配置模型。
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
                        ? '正常'
                        : check.status === 'failed'
                          ? '异常'
                          : '注意'}
                    </Badge>
                  </div>
                  <small>{check.detail}</small>
                </div>
              </article>
            );
          }) ?? <p className="quiet">正在检查运行环境…</p>}
        </div>

        <form className="provider-form" onSubmit={(event) => void submit(event)}>
          <div>
            <span className="eyebrow">Provider</span>
            <h2>模型配置</h2>
            <p>API Key 仅写入 Gateway 的私有配置文件，界面不会回显。</p>
          </div>

          <div className="provider-grid">
            <Label className="setup-field">
              服务商
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
              模型 ID
              <Input
                required
                value={model}
                onChange={(event) => setModel(event.target.value)}
              />
            </Label>
          </div>

          <Label className="setup-field">
            Base URL（可选）
            <Input
              inputMode="url"
              placeholder="使用服务商默认地址"
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
                  ? '已配置；留空表示保持不变'
                  : '请输入 API Key'
              }
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </Label>

          {props.workspaceCount > 0 && (
            <Label className="restart-option">
              <span>
                重建现有 Worker 以立即应用配置
                <small>保留仓库和会话卷，运行中的任务会被中断。</small>
              </span>
              <Switch
                checked={restartWorkers}
                onCheckedChange={setRestartWorkers}
                aria-label="重建现有 Worker"
              />
            </Label>
          )}

          {error && <p className="form-error" role="alert">{error}</p>}
          {savedMessage && (
            <p className="form-success" role="status">{savedMessage}</p>
          )}

          <DialogFooter className="form-actions">
            <Button type="button" variant="outline" onClick={props.onClose}>
              取消
            </Button>
            <Button disabled={saving}>
              {saving ? '正在保存…' : '保存配置'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
