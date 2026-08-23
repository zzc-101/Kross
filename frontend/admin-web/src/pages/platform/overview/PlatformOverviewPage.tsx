import {
  ApartmentOutlined,
  CheckCircleOutlined,
  PlusOutlined,
  SafetyCertificateOutlined,
  TeamOutlined,
  UserOutlined,
  ThunderboltOutlined
} from '@ant-design/icons';
import { Button, Card, Col, Row, Space, Tag, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import { AdminApiClient } from '../../../apiClient';
import { MetricGrid } from '../../../components/MetricGrid';
import { Page } from '../../../components/Page';
import { RefreshButton } from '../../../components/RefreshButton';
import { ResourceState } from '../../../components/ResourceState';
import { useResource } from '../../../hooks/useResource';
import { OrganizationsTable } from '../organizations/components/OrganizationsTable';

export function PlatformOverviewPage({ api }: { api: AdminApiClient }) {
  const navigate = useNavigate();
  const state = useResource(async () => {
    const [organizations, users, tokenUsage] = await Promise.all([
      api.organizations(),
      api.users(),
      api.tokenUsage(30)
    ]);
    return { organizations, users, tokenUsage };
  }, [api]);
  return (
    <Page
      title="平台概览"
      subtitle="全局查看组织规模、账号状态与平台运行范围。"
      action={
        <Space>
          <RefreshButton onClick={state.reload} />
          <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/platform/organizations')}>
            创建组织
          </Button>
        </Space>
      }
    >
      <ResourceState state={state}>
        {({ organizations, users, tokenUsage }) => (
          <>
            <MetricGrid
              items={[
                {
                  title: '组织总数',
                  value: organizations.length,
                  icon: <ApartmentOutlined />,
                  tone: 'blue',
                  note: `${organizations.filter((item) => item.status === 'active').length} 个正常运行`
                },
                {
                  title: '平台账号',
                  value: users.length,
                  icon: <UserOutlined />,
                  tone: 'violet',
                  note: `${users.filter((item) => item.status === 'active').length} 个活跃账号`
                },
                {
                  title: '组织成员',
                  value: organizations.reduce((sum, item) => sum + item.memberCount, 0),
                  icon: <TeamOutlined />,
                  tone: 'green',
                  note: '来自全部组织'
                },
                {
                  title: '组织管理员',
                  value: organizations.reduce((sum, item) => sum + item.adminCount, 0),
                  icon: <SafetyCertificateOutlined />,
                  tone: 'amber',
                  note: '拥有组织管理权限'
                },
                {
                  title: '近 30 天 Token',
                  value: tokenUsage.totalTokens,
                  icon: <ThunderboltOutlined />,
                  tone: 'blue',
                  note: `输入 ${tokenUsage.inputTokens.toLocaleString()} · 输出 ${tokenUsage.outputTokens.toLocaleString()}`
                },
                {
                  title: '近 30 天模型调用',
                  value: tokenUsage.llmCalls,
                  icon: <ThunderboltOutlined />,
                  tone: 'green',
                  note: tokenUsage.llmCalls
                    ? `平均 ${Math.round(tokenUsage.totalTokens / tokenUsage.llmCalls).toLocaleString()} Token/次`
                    : '暂无调用'
                }
              ]}
            />
            <Row gutter={[20, 20]} className="overview-row">
              <Col xs={24} xl={16}>
                <Card
                  title="最近组织"
                  extra={
                    <Button type="link" onClick={() => navigate('/platform/organizations')}>
                      前往组织管理
                    </Button>
                  }
                >
                  <OrganizationsTable data={organizations.slice(0, 6)} compact />
                </Card>
              </Col>
              <Col xs={24} xl={8}>
                <Card title="平台状态" className="health-card">
                  {['身份认证服务', '组织权限服务', '模型配置服务', '审计服务'].map((label) => (
                    <div className="health-row" key={label}>
                      <Space>
                        <CheckCircleOutlined className="success-icon" />
                        {label}
                      </Space>
                      <Space>
                        <Tag color="success">正常</Tag>
                        <Typography.Text type="secondary">刚刚</Typography.Text>
                      </Space>
                    </div>
                  ))}
                </Card>
              </Col>
            </Row>
          </>
        )}
      </ResourceState>
    </Page>
  );
}
