import { useState } from 'react';
import { BulbOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import {
  App,
  Avatar,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography
} from 'antd';
import { AdminApiClient } from '../../../apiClient';
import type { PlatformSkill } from '../../../contracts';
import { Page } from '../../../components/Page';
import { RefreshButton } from '../../../components/RefreshButton';
import { ResourceState } from '../../../components/ResourceState';
import { useResource } from '../../../hooks/useResource';
import { formatDate } from '../../../utils/format';

type SkillForm = Pick<PlatformSkill,
  'id' | 'name' | 'description' | 'category' | 'icon' | 'launchMode' | 'starterPrompt' | 'content'>;

export function PlatformSkillsPage({ api }: { api: AdminApiClient }) {
  const state = useResource(() => api.platformSkills(), [api]);
  const [editing, setEditing] = useState<PlatformSkill>();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<SkillForm>();
  const { message } = App.useApp();

  const openCreate = () => {
    setEditing(undefined);
    form.setFieldsValue({
      id: '', name: '', description: '', category: '办公效率', icon: 'sparkles',
      launchMode: 'instant', starterPrompt: '', content: ''
    });
    setOpen(true);
  };

  const openEdit = (skill: PlatformSkill) => {
    setEditing(skill);
    form.setFieldsValue(skill);
    setOpen(true);
  };

  const save = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      if (editing) {
        await api.updatePlatformSkill(editing.id, values);
        message.success('Skill 已更新，所有已安装组织将在下一轮任务使用最新版');
      } else {
        await api.createPlatformSkill(values);
        message.success('Skill 已创建');
      }
      setOpen(false);
      form.resetFields();
      await state.reload();
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (skill: PlatformSkill) => {
    await api.updatePlatformSkill(skill.id, { status: skill.status === 'active' ? 'disabled' : 'active' });
    message.success(skill.status === 'active' ? 'Skill 已全局禁用' : 'Skill 已重新启用');
    await state.reload();
  };

  return (
    <Page
      title="技能库"
      subtitle="平台 Skill 只有一份，由超级管理员统一维护；更新后所有已安装组织自动使用最新版。"
      action={<Space><RefreshButton onClick={state.reload} /><Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>创建 Skill</Button></Space>}
    >
      <Card>
        <ResourceState state={state} empty="技能库中还没有 Skill。">
          {(items) => (
            <Table
              rowKey="id"
              dataSource={items}
              pagination={false}
              columns={[
                {
                  title: 'Skill',
                  dataIndex: 'name',
                  render: (name: string, record: PlatformSkill) => (
                    <Space><Avatar shape="square" icon={<BulbOutlined />} /><div className="person-cell"><strong>{name}</strong><span>{record.id}</span></div></Space>
                  )
                },
                { title: '分类', dataIndex: 'category' },
                { title: '启动方式', dataIndex: 'launchMode', render: launchModeLabel },
                { title: 'Revision', dataIndex: 'revision', render: (value: number) => <Tag>r{value}</Tag> },
                { title: '安装组织', dataIndex: 'installCount', render: (value: number) => `${value} 个` },
                {
                  title: '状态', dataIndex: 'status',
                  render: (value: string, record: PlatformSkill) => (
                    <Space><Switch checked={value === 'active'} onChange={() => void toggle(record)} /><Typography.Text type="secondary">{value === 'active' ? '可安装' : '全局禁用'}</Typography.Text></Space>
                  )
                },
                { title: '更新时间', dataIndex: 'updatedAt', render: formatDate },
                { title: '操作', render: (_: unknown, record: PlatformSkill) => <Button type="link" icon={<EditOutlined />} onClick={() => openEdit(record)}>编辑</Button> }
              ]}
            />
          )}
        </ResourceState>
      </Card>
      <Modal
        title={editing ? `编辑 ${editing.name}` : '创建 Skill'}
        width={760}
        open={open}
        confirmLoading={saving}
        okText={editing ? '发布更新' : '创建'}
        onCancel={() => setOpen(false)}
        onOk={() => void save()}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Form.Item name="id" label="Skill 标识" rules={[{ required: true }, { pattern: /^[a-z][a-z0-9-]{1,63}$/, message: '使用 2-64 位小写字母、数字或连字符' }]}>
            <Input disabled={Boolean(editing)} placeholder="meeting-minutes" />
          </Form.Item>
          <Form.Item name="name" label="名称" rules={[{ required: true }]}><Input placeholder="会议纪要" /></Form.Item>
          <Form.Item name="description" label="一句话说明"><Input.TextArea rows={2} maxLength={500} showCount /></Form.Item>
          <Space size="large" align="start" wrap>
            <Form.Item name="category" label="分类" rules={[{ required: true }]}><Input style={{ width: 190 }} /></Form.Item>
            <Form.Item name="icon" label="图标标识" rules={[{ required: true }]}><Input style={{ width: 190 }} /></Form.Item>
            <Form.Item name="launchMode" label="启动方式" rules={[{ required: true }]}>
              <Select style={{ width: 190 }} options={[
                { value: 'instant', label: '直接开始' },
                { value: 'form', label: '填写参数' },
                { value: 'file', label: '选择文件' }
              ]} />
            </Form.Item>
          </Space>
          <Form.Item name="starterPrompt" label="输入框引导语"><Input maxLength={1000} placeholder="上传会议记录，或直接粘贴会议内容…" /></Form.Item>
          <Form.Item name="content" label="SKILL.md 指令" rules={[{ required: true, message: '请输入 Skill 指令' }]} extra="发布后，已安装组织下一轮调用会自动使用新 revision。">
            <Input.TextArea className="skill-content-editor" rows={14} spellCheck={false} />
          </Form.Item>
        </Form>
      </Modal>
    </Page>
  );
}

function launchModeLabel(value: PlatformSkill['launchMode']) {
  return value === 'file' ? '选择文件' : value === 'form' ? '填写参数' : '直接开始';
}
