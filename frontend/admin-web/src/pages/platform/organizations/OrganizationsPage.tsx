import { useState } from 'react';
import { PlusOutlined } from '@ant-design/icons';
import { App, Button, Card, Form, Input, Modal } from 'antd';
import { AdminApiClient } from '../../../apiClient';
import type { PlatformOrganization } from '../../../contracts';
import { Page } from '../../../components/Page';
import { ResourceState } from '../../../components/ResourceState';
import { useResource } from '../../../hooks/useResource';
import { OrganizationsTable } from './components/OrganizationsTable';

export function OrganizationsPage({
  api,
  currentUsername
}: {
  api: AdminApiClient;
  currentUsername: string;
}) {
  const state = useResource(() => api.organizations(), [api]);
  const [createOpen, setCreateOpen] = useState(false);
  const [adminTarget, setAdminTarget] = useState<PlatformOrganization>();
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [adminForm] = Form.useForm();
  const create = async () => {
    const values = await form.validateFields();
    await api.createOrganization({
      ...values,
      defaultTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'
    });
    message.success('组织已创建');
    setCreateOpen(false);
    form.resetFields();
    state.reload();
  };
  const assignAdmin = async () => {
    if (!adminTarget) return;
    await api.assignAdmin(adminTarget.id, await adminForm.validateFields());
    message.success('组织管理员已分配');
    setAdminTarget(undefined);
    adminForm.resetFields();
    state.reload();
  };
  const updateStatus = async (record: PlatformOrganization) => {
    const status = record.status === 'active' ? 'suspended' : 'active';
    await api.updateOrganization(record.id, { status });
    message.success(status === 'active' ? '组织已启用' : '组织已停用');
    state.reload();
  };
  return (
    <Page
      title="组织管理"
      subtitle="创建组织、控制组织状态并分配组织管理员。"
      action={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          创建组织
        </Button>
      }
    >
      <Card>
        <ResourceState state={state} empty="还没有组织。">
          {(organizations) => (
            <OrganizationsTable
              data={organizations}
              onAdmin={setAdminTarget}
              onStatus={(record) => void updateStatus(record)}
            />
          )}
        </ResourceState>
      </Card>
      <Modal
        title="创建组织"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => void create()}
        okText="创建"
      >
        <OrganizationForm form={form} initialUsername={currentUsername} />
      </Modal>
      <Modal
        title={`为 ${adminTarget?.name ?? ''} 分配管理员`}
        open={Boolean(adminTarget)}
        onCancel={() => setAdminTarget(undefined)}
        onOk={() => void assignAdmin()}
        okText="分配"
      >
        <AdminForm form={adminForm} />
      </Modal>
    </Page>
  );
}

function OrganizationForm({
  form,
  initialUsername
}: {
  form: ReturnType<typeof Form.useForm>[0];
  initialUsername: string;
}) {
  return (
    <Form form={form} layout="vertical" initialValues={{ adminUsername: initialUsername }}>
      <Form.Item name="name" label="组织名称" rules={[{ required: true }]}>
        <Input
          onChange={(event) => {
            const slug = event.target.value
              .trim()
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '-')
              .replace(/^-+|-+$/g, '')
              .slice(0, 48);
            if (slug.length >= 2) form.setFieldValue('slug', slug);
          }}
        />
      </Form.Item>
      <Form.Item
        name="slug"
        label="组织标识（Slug）"
        rules={[{ required: true, pattern: /^[a-z0-9][a-z0-9-]{1,47}$/ }]}
      >
        <Input placeholder="acme" />
      </Form.Item>
      <Form.Item name="adminUsername" label="初始管理员用户名" rules={[{ required: true }]}>
        <Input />
      </Form.Item>
      <Form.Item name="adminDisplayName" label="管理员昵称">
        <Input />
      </Form.Item>
      <Form.Item name="adminPassword" label="新账号初始密码">
        <Input.Password placeholder="已有账号可留空" />
      </Form.Item>
    </Form>
  );
}
function AdminForm({ form }: { form: ReturnType<typeof Form.useForm>[0] }) {
  return (
    <Form form={form} layout="vertical">
      <Form.Item name="username" label="用户名" rules={[{ required: true }]}>
        <Input />
      </Form.Item>
      <Form.Item name="displayName" label="昵称">
        <Input />
      </Form.Item>
      <Form.Item name="password" label="新账号初始密码">
        <Input.Password placeholder="已有账号可留空" />
      </Form.Item>
    </Form>
  );
}
