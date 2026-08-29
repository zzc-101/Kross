import { useState } from 'react';
import { PlusOutlined } from '@ant-design/icons';
import {
  App,
  Button,
  Card,
  Col,
  Descriptions,
  Form,
  Input,
  Modal,
  Row,
  Switch,
  Table,
  Typography
} from 'antd';
import { AdminApiClient } from '../../../apiClient';
import type { UserAccount } from '../../../contracts';
import { Page } from '../../../components/Page';
import { PersonCell } from '../../../components/PersonCell';
import { ResourceState } from '../../../components/ResourceState';
import { SettingRow } from '../../../components/SettingRow';
import { StatusTag } from '../../../components/StatusTag';
import { useResource } from '../../../hooks/useResource';
import { formatDate } from '../../../utils/format';

export function PlatformSettingsPage({ api }: { api: AdminApiClient }) {
  const platform = useResource(() => api.platform(), [api]);
  const sso = useResource(() => api.sso(), [api]);
  const users = useResource(() => api.users(), [api]);
  const { message } = App.useApp();
  const [userOpen, setUserOpen] = useState(false);
  const [ssoOpen, setSsoOpen] = useState(false);
  const [userForm] = Form.useForm();
  const [ssoForm] = Form.useForm();
  const createUser = async () => {
    await api.createUser(await userForm.validateFields());
    message.success('平台账号已创建');
    setUserOpen(false);
    userForm.resetFields();
    users.reload();
  };
  const saveSso = async () => {
    await api.updateSso(await ssoForm.validateFields());
    message.success('SSO 配置已保存');
    setSsoOpen(false);
    sso.reload();
  };
  return (
    <Page
      title="平台设置"
      subtitle="配置注册策略、企业身份登录与平台账号。"
      action={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setUserOpen(true)}>
          创建账号
        </Button>
      }
    >
      <Row gutter={[20, 20]}>
        <Col xs={24} xl={12}>
          <Card title="注册策略">
            <ResourceState state={platform}>
              {(settings) => (
                <>
                  <SettingRow title="允许自助注册" description="关闭后仅超级管理员或组织邀请链接可以创建账号。">
                    <Switch
                      checked={settings.registrationEnabled}
                      onChange={(checked) =>
                        void api
                          .updatePlatform({ registrationEnabled: checked })
                          .then(platform.setData)
                          .then(() => message.success('注册策略已更新'))
                      }
                    />
                  </SettingRow>
                  <SettingRow
                    title="启用知识库"
                    description={
                      settings.knowledgeAvailable
                        ? '开启后工作台可检索已发布的平台文档、PDF、Word 和图片。未部署 knowledge 服务时开关不可用。'
                        : '尚未部署 knowledge 服务。本地可用 ./scripts/start-cloud.sh --knowledge 启动。'
                    }
                  >
                    <Switch
                      checked={settings.knowledgeEnabled}
                      disabled={!settings.knowledgeAvailable}
                      onChange={(checked) =>
                        void api
                          .updatePlatform({ knowledgeEnabled: checked })
                          .then(platform.setData)
                          .then(() => message.success('知识库开关已更新'))
                      }
                    />
                  </SettingRow>
                </>
              )}
            </ResourceState>
          </Card>
        </Col>
        <Col xs={24} xl={12}>
          <Card
            title="企业 SSO"
            extra={
              <Button
                onClick={() => {
                  if (sso.data) ssoForm.setFieldsValue(sso.data);
                  setSsoOpen(true);
                }}
              >
                配置
              </Button>
            }
          >
            <ResourceState state={sso}>
              {(settings) => (
                <Descriptions
                  column={1}
                  size="small"
                  items={[
                    { key: 'status', label: '状态', children: <StatusTag active={settings.enabled} /> },
                    { key: 'name', label: '登录名称', children: settings.displayName || '企业账号' },
                    {
                      key: 'redirect',
                      label: '回调地址',
                      children: <Typography.Text copyable>{settings.redirectUri}</Typography.Text>
                    }
                  ]}
                />
              )}
            </ResourceState>
          </Card>
        </Col>
        <Col span={24}>
          <Card title="平台账号">
            <ResourceState state={users} empty="还没有账号。">
              {(items) => (
                <Table
                  rowKey="userId"
                  dataSource={items}
                  pagination={{ pageSize: 8 }}
                  columns={userColumns}
                />
              )}
            </ResourceState>
          </Card>
        </Col>
      </Row>
      <Modal
        title="创建平台账号"
        open={userOpen}
        onCancel={() => setUserOpen(false)}
        onOk={() => void createUser()}
        okText="创建"
      >
        <Form form={userForm} layout="vertical">
          <Form.Item name="username" label="用户名" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="displayName" label="昵称">
            <Input />
          </Form.Item>
          <Form.Item name="password" label="初始密码" rules={[{ required: true, min: 8 }]}>
            <Input.Password />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title="企业 OIDC SSO"
        width={680}
        open={ssoOpen}
        onCancel={() => setSsoOpen(false)}
        onOk={() => void saveSso()}
        okText="保存"
      >
        <Form form={ssoForm} layout="vertical">
          <Form.Item name="enabled" label="启用 OIDC" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="displayName" label="登录按钮名称">
            <Input placeholder="企业账号" />
          </Form.Item>
          <Form.Item name="issuer" label="Issuer URL">
            <Input placeholder="https://login.example.com/realms/corp" />
          </Form.Item>
          <Form.Item name="clientId" label="Client ID">
            <Input />
          </Form.Item>
          <Form.Item name="clientSecret" label="Client Secret">
            <Input.Password placeholder="留空表示不修改" />
          </Form.Item>
        </Form>
      </Modal>
    </Page>
  );
}

const userColumns = [
  {
    title: '用户',
    dataIndex: 'displayName',
    render: (name: string, record: UserAccount) => (
      <PersonCell name={name} username={record.username} avatar={record.avatarUrl} />
    )
  },
  {
    title: '平台角色',
    dataIndex: 'platformRole',
    render: (role: string) => (role === 'super_admin' ? '超级管理员' : '用户')
  },
  {
    title: '状态',
    dataIndex: 'status',
    render: (status: string) => <StatusTag active={status === 'active'} />
  },
  { title: '创建时间', dataIndex: 'createdAt', responsive: ['md' as const], render: formatDate }
];
