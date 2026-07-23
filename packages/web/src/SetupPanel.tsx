import { useEffect, useState, type FormEvent } from 'react';

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

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [props.onClose]);

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
    <div className="modal-backdrop">
      <section
        className="setup-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="setup-title"
      >
        <header>
          <div>
            <span className="eyebrow">环境与模型</span>
            <h2 id="setup-title">运行环境检查</h2>
            <p>确认 Agent 执行所需的基础能力，并安全配置模型。</p>
          </div>
          <button onClick={props.onClose}>关闭</button>
        </header>

        <div className="setup-checks">
          {status?.checks.map((check) => (
            <article key={check.id} className={`setup-check ${check.status}`}>
              <span>{check.status === 'passed' ? '✓' : check.status === 'failed' ? '×' : '!'}</span>
              <div>
                <strong>{check.label}</strong>
                <small>{check.detail}</small>
              </div>
            </article>
          )) ?? <p className="quiet">正在检查运行环境…</p>}
        </div>

        <form className="provider-form" onSubmit={(event) => void submit(event)}>
          <div>
            <span className="eyebrow">Provider</span>
            <h2>模型配置</h2>
            <p>
              API Key 仅写入 Gateway 的私有配置文件，界面不会回显。
            </p>
          </div>
          <div className="provider-grid">
            <label>
              服务商
              <select
                value={provider}
                onChange={(event) =>
                  changeProvider(event.target.value as ProviderInput['provider'])
                }
              >
                {PROVIDERS.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              模型 ID
              <input
                required
                value={model}
                onChange={(event) => setModel(event.target.value)}
              />
            </label>
          </div>
          <label>
            Base URL（可选）
            <input
              inputMode="url"
              placeholder="使用服务商默认地址"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </label>
          <label>
            API Key
            <input
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
          </label>
          {props.workspaceCount > 0 && (
            <label className="check-row">
              <input
                type="checkbox"
                checked={restartWorkers}
                onChange={(event) => setRestartWorkers(event.target.checked)}
              />
              <span>
                重建现有 Worker 以立即应用配置
                <small>保留仓库和会话卷，运行中的任务会被中断。</small>
              </span>
            </label>
          )}
          {error && <p className="form-error" role="alert">{error}</p>}
          {savedMessage && (
            <p className="form-success" role="status">{savedMessage}</p>
          )}
          <div className="form-actions">
            <button type="button" onClick={props.onClose}>取消</button>
            <button className="primary" disabled={saving}>
              {saving ? '正在保存…' : '保存配置'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
