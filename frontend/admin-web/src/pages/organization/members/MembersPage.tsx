import { useState } from 'react';
import { LinkOutlined, PlusOutlined } from '@ant-design/icons';
import {
  Alert,
  App,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography
} from 'antd';
import { AdminApiClient, AdminApiError } from '../../../apiClient';
import type { CreatedInvite, Invite, Member } from '../../../contracts';
import { Page } from '../../../components/Page';
import { PersonCell } from '../../../components/PersonCell';
import { ResourceState } from '../../../components/ResourceState';
import { useResource } from '../../../hooks/useResource';
import { formatDate, inviteUrl } from '../../../utils/format';

export function MembersPage({ api }: { api: AdminApiClient }) {
  const members = useResource(() => api.members(), [api]);
  const invites = useResource(() => api.invites(), [api]);
  const [memberOpen, setMemberOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [memberSaving, setMemberSaving] = useState(false);
  const [inviteSaving, setInviteSaving] = useState(false);
  const [created, setCreated] = useState<CreatedInvite>();
  const [memberForm] = Form.useForm();
  const [inviteForm] = Form.useForm();
  const { message } = App.useApp();
  const createMember = async () => {
    let values;
    try {
      values = await memberForm.validateFields();
    } catch {
      return;
    }
    setMemberSaving(true);
    try {
      await api.inviteMember(values);
      message.success('成员已登记');
      setMemberOpen(false);
      memberForm.resetFields();
      await members.reload();
    } catch (error) {
      const text = adminErrorMessage(error);
      if (error instanceof AdminApiError && error.message === 'Password must be 8-128 characters') {
        memberForm.setFields([{ name: 'password', errors: [text] }]);
      }
      message.error(text);
    } finally {
      setMemberSaving(false);
    }
  };
  const createInvite = async () => {
    let values;
    try {
      values = await inviteForm.validateFields();
    } catch {
      return;
    }
    setInviteSaving(true);
    try {
      const next = await api.createInvite(values);
      setCreated(next);
      message.success('邀请链接已生成');
      await invites.reload();
    } catch (error) {
      message.error(adminErrorMessage(error));
    } finally {
      setInviteSaving(false);
    }
  };
  const update = async (record: Member, field: 'role' | 'status', value: string) => {
    try {
      await api.updateMember(record.id, { [field]: value });
      message.success('成员信息已更新');
      await members.reload();
    } catch (error) {
      message.error(adminErrorMessage(error));
    }
  };
  const revoke = async (record: Invite) => {
    try {
      await api.revokeInvite(record.id);
      message.success('邀请已撤销');
      await invites.reload();
    } catch (error) {
      message.error(adminErrorMessage(error));
    }
  };
  return (
    <Page
      title="成员与角色"
      subtitle="管理组织成员、角色和可转发邀请链接。"
      action={
        <Space>
          <Button icon={<LinkOutlined />} onClick={() => setInviteOpen(true)}>
            生成邀请
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setMemberOpen(true)}>
            登记成员
          </Button>
        </Space>
      }
    >
      <Card>
        <ResourceState state={members} empty="组织中还没有成员。">
          {(items) => (
            <Table
              rowKey="id"
              dataSource={items}
              pagination={{ pageSize: 10 }}
              columns={memberColumns(update)}
            />
          )}
        </ResourceState>
      </Card>
      <Card title="邀请链接" className="section-card">
        <ResourceState state={invites} empty="还没有邀请链接。">
          {(items) => (
            <Table
              rowKey="id"
              dataSource={items}
              pagination={false}
              columns={inviteColumns((record) => void revoke(record))}
            />
          )}
        </ResourceState>
      </Card>
      <Modal
        title="登记成员"
        open={memberOpen}
        onCancel={() => setMemberOpen(false)}
        onOk={() => void createMember()}
        okText="登记并加入"
        confirmLoading={memberSaving}
      >
        <Form form={memberForm} layout="vertical" initialValues={{ role: 'member' }}>
          <Form.Item
            name="username"
            label="用户名"
            rules={[
              { required: true, message: '请输入用户名' },
              {
                pattern: /^[A-Za-z][A-Za-z0-9_-]{2,31}$/,
                message: '用户名须为 3–32 位，并以字母开头，仅可包含字母、数字、下划线或连字符'
              }
            ]}
          >
            <Input />
          </Form.Item>
          <Form.Item name="displayName" label="昵称">
            <Input />
          </Form.Item>
          <Form.Item
            name="password"
            label="新账号初始密码"
            rules={[{ min: 8, max: 128, message: '密码长度必须为 8–128 个字符' }]}
          >
            <Input.Password placeholder="已有账号可留空" />
          </Form.Item>
          <Form.Item name="role" label="角色">
            <Select options={roleOptions} />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title="生成邀请链接"
        open={inviteOpen}
        onCancel={() => {
          setInviteOpen(false);
          setCreated(undefined);
        }}
        onOk={() => void createInvite()}
        okText="生成链接"
        confirmLoading={inviteSaving}
      >
        <Form form={inviteForm} layout="vertical" initialValues={{ role: 'member', expiresInDays: 14 }}>
          <Form.Item name="role" label="加入后的角色">
            <Select options={roleOptions} />
          </Form.Item>
          <Form.Item name="expiresInDays" label="有效天数">
            <InputNumber min={1} max={90} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
        {created && (
          <Alert
            type="success"
            message="邀请地址"
            description={<Typography.Text copyable>{inviteUrl(created.path)}</Typography.Text>}
          />
        )}
      </Modal>
    </Page>
  );
}

function adminErrorMessage(error: unknown) {
  if (error instanceof AdminApiError) {
    if (error.message === 'Password must be 8-128 characters') return '密码长度必须为 8–128 个字符';
    return error.message;
  }
  return error instanceof Error ? error.message : '操作失败，请稍后重试';
}
const roleOptions = [
  { value: 'member', label: '成员' },
  { value: 'admin', label: '组织管理员' }
];
function memberColumns(update: (record: Member, field: 'role' | 'status', value: string) => Promise<void>) {
  return [
    {
      title: '成员',
      dataIndex: 'displayName',
      render: (name: string, record: Member) => (
        <PersonCell name={name} username={record.username} avatar={record.avatarUrl} />
      )
    },
    {
      title: '角色',
      dataIndex: 'role',
      width: 180,
      render: (value: string, record: Member) => (
        <Select value={value} options={roleOptions} onChange={(next) => void update(record, 'role', next)} />
      )
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 160,
      render: (value: string, record: Member) => (
        <Select
          value={value}
          options={[
            { value: 'active', label: '正常' },
            { value: 'disabled', label: '已停用' }
          ]}
          onChange={(next) => void update(record, 'status', next)}
        />
      )
    },
    { title: '更新时间', dataIndex: 'updatedAt', responsive: ['md' as const], render: formatDate }
  ];
}
function inviteColumns(revoke: (record: Invite) => void) {
  return [
    {
      title: '角色',
      dataIndex: 'role',
      render: (value: string) => (value === 'admin' ? '组织管理员' : '成员')
    },
    {
      title: '状态',
      key: 'state',
      render: (_: unknown, record: Invite) =>
        record.acceptedAt ? (
          <Tag>已加入</Tag>
        ) : new Date(record.expiresAt).getTime() < Date.now() ? (
          <Tag>已过期</Tag>
        ) : (
          <Tag color="processing">待使用</Tag>
        )
    },
    { title: '有效期至', dataIndex: 'expiresAt', render: formatDate },
    {
      title: '操作',
      key: 'action',
      width: 90,
      render: (_: unknown, record: Invite) =>
        record.acceptedAt ? null : (
          <Button type="link" danger onClick={() => revoke(record)}>
            撤销
          </Button>
        )
    }
  ];
}
