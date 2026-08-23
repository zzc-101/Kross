import { BulbOutlined, CheckCircleFilled, DownloadOutlined, DeleteOutlined } from '@ant-design/icons';
import { App, Avatar, Button, Card, Col, Popconfirm, Row, Space, Tag, Typography } from 'antd';
import { AdminApiClient } from '../../../apiClient';
import type { OrganizationSkill } from '../../../contracts';
import { Page } from '../../../components/Page';
import { RefreshButton } from '../../../components/RefreshButton';
import { ResourceState } from '../../../components/ResourceState';
import { useResource } from '../../../hooks/useResource';

export function OrganizationSkillsPage({ api }: { api: AdminApiClient }) {
  const state = useResource(() => api.organizationSkills(), [api]);
  const { message } = App.useApp();

  const install = async (skill: OrganizationSkill) => {
    await api.installSkill(skill.id);
    message.success(`${skill.name} 已安装，组织成员现在可以使用`);
    await state.reload();
  };
  const uninstall = async (skill: OrganizationSkill) => {
    await api.uninstallSkill(skill.id);
    message.success(`${skill.name} 已卸载`);
    await state.reload();
  };

  return (
    <Page
      title="组织技能"
      subtitle="从平台技能库按需安装。Skill 由平台统一更新，组织无需维护版本。"
      action={<RefreshButton onClick={state.reload} />}
    >
      <ResourceState state={state} empty="平台技能库中还没有可安装的 Skill。">
        {(items) => (
          <Row gutter={[18, 18]}>
            {items.map((skill) => (
              <Col key={skill.id} xs={24} lg={12} xl={8}>
                <Card className={skill.installed ? 'skill-market-card installed' : 'skill-market-card'}>
                  <div className="skill-market-head">
                    <Avatar shape="square" size={44} icon={<BulbOutlined />} />
                    <div>
                      <Space><Typography.Title level={4}>{skill.name}</Typography.Title>{skill.installed && <CheckCircleFilled className="skill-installed-icon" />}</Space>
                      <Typography.Text type="secondary">{skill.id} · r{skill.revision}</Typography.Text>
                    </div>
                  </div>
                  <Typography.Paragraph className="skill-market-description" ellipsis={{ rows: 3 }}>
                    {skill.description || '暂无说明'}
                  </Typography.Paragraph>
                  <Space wrap><Tag>{skill.category}</Tag><Tag>{launchModeLabel(skill.launchMode)}</Tag>{skill.status === 'disabled' && <Tag color="error">平台已禁用</Tag>}</Space>
                  <div className="skill-market-actions">
                    {skill.installed ? (
                      <Popconfirm title={`卸载 ${skill.name}？`} description="组织成员将无法继续应用该 Skill，历史消息仍会保留。" okText="卸载" cancelText="取消" onConfirm={() => uninstall(skill)}>
                        <Button danger icon={<DeleteOutlined />}>卸载</Button>
                      </Popconfirm>
                    ) : (
                      <Button type="primary" icon={<DownloadOutlined />} disabled={skill.status !== 'active'} onClick={() => void install(skill)}>安装到组织</Button>
                    )}
                  </div>
                </Card>
              </Col>
            ))}
          </Row>
        )}
      </ResourceState>
    </Page>
  );
}

function launchModeLabel(value: OrganizationSkill['launchMode']) {
  return value === 'file' ? '需要文件' : value === 'form' ? '启动前填写参数' : '一键开始';
}
