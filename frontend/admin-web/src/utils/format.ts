export function formatDate(value?: string | null) {
  return value
    ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
    : '—';
}

export function agentStatus(status: string) {
  if (status === 'running') return '运行中';
  if (status === 'stopped') return '已休眠';
  if (status === 'starting') return '启动中';
  if (status === 'error') return '异常';
  return status;
}

export function workbenchUrl() {
  return location.port === '4174' ? `${location.protocol}//${location.hostname}:4173` : `${location.origin}/`;
}

export function inviteUrl(path: string) {
  const origin = workbenchUrl().replace(/\/$/, '');
  return `${origin}${path.startsWith('/') ? path : `/${path}`}`;
}
