import type { AgentModel } from '../api/types';

export function ModelBadge({ model }: { model?: AgentModel | null }) {
  if (model?.provider === 'openai') return <img src="/openai.svg" alt="" />;
  return <span className="model-provider-badge" aria-hidden="true">{model?.provider.slice(0, 2).toUpperCase() ?? 'AI'}</span>;
}

export function modelLabel(model?: AgentModel | null): string {
  return model?.model ?? '未配置模型';
}
