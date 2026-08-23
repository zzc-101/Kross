import { useState } from 'react';
import { Card, Descriptions, Drawer, Table, Typography } from 'antd';
import { AdminApiClient } from '../../../apiClient';
import type { AuditLog } from '../../../contracts';
import { Page } from '../../../components/Page';
import { RefreshButton } from '../../../components/RefreshButton';
import { ResourceState } from '../../../components/ResourceState';
import { useResource } from '../../../hooks/useResource';
import { formatDate } from '../../../utils/format';

export function AuditPage({ api }: { api: AdminApiClient }) {
  const state = useResource(() => api.auditLogs(), [api]);
  const [selected, setSelected] = useState<AuditLog>();
  return (
    <Page
      title="审计日志"
      subtitle="追踪管理操作、权限决策和配置变更。"
      action={<RefreshButton onClick={state.reload} />}
    >
      <Card>
        <ResourceState state={state} empty="暂无审计事件。">
          {(items) => (
            <Table
              rowKey="id"
              dataSource={items}
              pagination={{ pageSize: 12 }}
              onRow={(record) => ({ onClick: () => setSelected(record) })}
              columns={columns}
            />
          )}
        </ResourceState>
      </Card>
      <Drawer
        title="审计事件详情"
        open={Boolean(selected)}
        onClose={() => setSelected(undefined)}
        width={520}
      >
        {selected && (
          <>
            <Descriptions
              column={1}
              items={[
                { key: 'actor', label: '操作者', children: selected.actorUserId || '系统' },
                { key: 'action', label: '操作', children: selected.action },
                {
                  key: 'resource',
                  label: '资源',
                  children: `${selected.resourceType}${selected.resourceId ? ` / ${selected.resourceId}` : ''}`
                },
                { key: 'time', label: '发生时间', children: formatDate(selected.occurredAt) }
              ]}
            />
            <Typography.Title level={5}>操作详情</Typography.Title>
            <pre className="json-view">{JSON.stringify(selected.payload, null, 2)}</pre>
          </>
        )}
      </Drawer>
    </Page>
  );
}
const columns = [
  { title: '操作者', dataIndex: 'actorUserId', render: (value: string | null) => value || '系统' },
  { title: '操作', dataIndex: 'action' },
  {
    title: '资源',
    dataIndex: 'resourceType',
    render: (value: string, record: AuditLog) =>
      `${value}${record.resourceId ? ` / ${record.resourceId}` : ''}`
  },
  { title: '发生时间', dataIndex: 'occurredAt', render: formatDate }
];
