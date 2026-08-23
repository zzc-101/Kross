import { ClockCircleOutlined, CloudServerOutlined, MessageOutlined, TeamOutlined } from '@ant-design/icons';
import { Avatar, Card, Col, Empty, List, Row, Table, Tag } from 'antd';
import { AdminApiClient } from '../../../apiClient';
import type { AgentRuntime, NodeHealth } from '../../../contracts';
import { MetricGrid } from '../../../components/MetricGrid';
import { Page } from '../../../components/Page';
import { PersonCell } from '../../../components/PersonCell';
import { RefreshButton } from '../../../components/RefreshButton';
import { ResourceState } from '../../../components/ResourceState';
import { useResource } from '../../../hooks/useResource';
import { agentStatus, formatDate } from '../../../utils/format';

export function OrganizationOverviewPage({ api }: { api: AdminApiClient }) {
  const state = useResource(() => api.dashboard(), [api]);
  return (
    <Page
      title="组织概览"
      subtitle="查看成员用量、Agent 运行状态与节点健康。"
      action={<RefreshButton onClick={state.reload} />}
    >
      <ResourceState state={state}>
        {(dashboard) => (
          <>
            <MetricGrid
              items={[
                {
                  title: '活跃成员',
                  value: dashboard.counts.activeMembers,
                  icon: <TeamOutlined />,
                  tone: 'blue',
                  note: '当前组织'
                },
                {
                  title: '运行中 Agent',
                  value: dashboard.counts.runningAgents,
                  icon: <CloudServerOutlined />,
                  tone: 'green',
                  note: '正在提供服务'
                },
                {
                  title: '休眠 Agent',
                  value: dashboard.counts.stoppedAgents,
                  icon: <ClockCircleOutlined />,
                  tone: 'violet',
                  note: '可按需唤醒'
                },
                {
                  title: '近 7 天消息',
                  value: dashboard.usage.messages7d,
                  icon: <MessageOutlined />,
                  tone: 'amber',
                  note: `今日 ${dashboard.usage.messages1d}`
                }
              ]}
            />
            <Row gutter={[20, 20]} className="overview-row">
              <Col xs={24} xl={15}>
                <Card title="Agent 运行状态">
                  <AgentTable data={dashboard.agents} />
                </Card>
              </Col>
              <Col xs={24} xl={9}>
                <Card title="节点健康">
                  <NodeList data={dashboard.nodes} />
                </Card>
              </Col>
            </Row>
          </>
        )}
      </ResourceState>
    </Page>
  );
}

function AgentTable({ data }: { data: AgentRuntime[] }) {
  return (
    <Table
      rowKey="id"
      dataSource={data}
      pagination={false}
      columns={[
        {
          title: 'Agent',
          dataIndex: 'displayName',
          render: (name, record) => <PersonCell name={name} username={record.username} />
        },
        {
          title: '状态',
          dataIndex: 'status',
          render: (status) => (
            <Tag color={status === 'running' ? 'success' : status === 'error' ? 'error' : 'default'}>
              {agentStatus(status)}
            </Tag>
          )
        },
        { title: '节点', dataIndex: 'nodeId', responsive: ['lg'], render: (value) => value || '—' },
        { title: '最后活跃', dataIndex: 'lastActiveAt', responsive: ['md'], render: formatDate }
      ]}
    />
  );
}
function NodeList({ data }: { data: NodeHealth[] }) {
  return data.length ? (
    <List
      dataSource={data}
      renderItem={(node) => (
        <List.Item
          extra={
            <Tag color={node.connected && node.juicefsOk ? 'success' : 'warning'}>
              {node.connected && node.juicefsOk ? '健康' : '需关注'}
            </Tag>
          }
        >
          <List.Item.Meta
            avatar={<Avatar icon={<CloudServerOutlined />} />}
            title={node.hostname || node.id}
            description={`${node.runningAgents} 个 Agent · ${formatDate(node.lastSeenAt)}`}
          />
        </List.Item>
      )}
    />
  ) : (
    <Empty description="当前为单机运行，无独立节点数据" />
  );
}
