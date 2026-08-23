import { Card, Table, Tag } from 'antd';
import { AdminApiClient } from '../../../apiClient';
import type { AuthLoginEvent } from '../../../contracts';
import { Page } from '../../../components/Page';
import { RefreshButton } from '../../../components/RefreshButton';
import { ResourceState } from '../../../components/ResourceState';
import { useResource } from '../../../hooks/useResource';
import { formatDate } from '../../../utils/format';

export function AuthLogsPage({ api }: { api: AdminApiClient }) {
  const state = useResource(() => api.authLogs(), [api]);
  return (
    <Page
      title="登录日志"
      subtitle="查看密码与 SSO 登录、登出及失败尝试。"
      action={<RefreshButton onClick={state.reload} />}
    >
      <Card>
        <ResourceState state={state} empty="暂无登录事件。">
          {(items) => (
            <Table rowKey="id" dataSource={items} pagination={{ pageSize: 12 }} columns={columns} />
          )}
        </ResourceState>
      </Card>
    </Page>
  );
}
const columns = [
  {
    title: '结果',
    dataIndex: 'outcome',
    width: 100,
    render: (value: string) => (
      <Tag color={value === 'success' ? 'success' : 'error'}>{value === 'success' ? '成功' : '失败'}</Tag>
    )
  },
  {
    title: '账号',
    dataIndex: 'username',
    render: (value: string | null, record: AuthLoginEvent) => value || record.userId || '未知账号'
  },
  {
    title: '事件',
    key: 'event',
    render: (_: unknown, record: AuthLoginEvent) =>
      record.eventType === 'logout' ? '登出' : record.method === 'sso' ? 'SSO 登录' : '密码登录'
  },
  {
    title: '来源 IP',
    dataIndex: 'ip',
    responsive: ['md' as const],
    render: (value: string | null) => value || '—'
  },
  { title: '时间', dataIndex: 'occurredAt', render: formatDate }
];
