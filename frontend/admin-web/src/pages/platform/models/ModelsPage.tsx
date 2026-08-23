import { useState } from 'react';
import { BuildOutlined, DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import {
  App,
  Avatar,
  Button,
  Card,
  Col,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography
} from 'antd';
import { AdminApiClient } from '../../../apiClient';
import type { ModelConfig } from '../../../contracts';
import { Page } from '../../../components/Page';
import { RefreshButton } from '../../../components/RefreshButton';
import { ResourceState } from '../../../components/ResourceState';
import { useResource } from '../../../hooks/useResource';
import { formatDate } from '../../../utils/format';

type ModelForm = {
  name: string;
  provider: string;
  model: string;
  contextWindow: number;
  apiKey?: string;
  baseUrl?: string;
};

export function ModelsPage({ api }: { api: AdminApiClient }) {
  const state = useResource(() => api.models(), [api]);
  const [editing, setEditing] = useState<ModelConfig>();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<ModelForm>();
  const { message } = App.useApp();

  const openCreate = () => {
    setEditing(undefined);
    form.setFieldsValue({
      name: '',
      provider: 'openai',
      model: '',
      contextWindow: 256_000,
      apiKey: '',
      baseUrl: ''
    });
    setOpen(true);
  };

  const openEdit = (record: ModelConfig) => {
    setEditing(record);
    form.setFieldsValue({
      name: record.name,
      provider: record.provider,
      model: record.model,
      contextWindow: record.contextWindow,
      apiKey: '',
      baseUrl: ''
    });
    setOpen(true);
  };

  const save = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      if (editing) {
        const input = {
          name: values.name,
          provider: values.provider,
          model: values.model,
          contextWindow: values.contextWindow,
          ...(values.apiKey?.trim() ? { apiKey: values.apiKey.trim(), baseUrl: values.baseUrl?.trim() } : {})
        };
        await api.updateModel(editing.id, input);
        message.success('模型配置已更新');
      } else {
        await api.createModel({
          name: values.name,
          provider: values.provider,
          model: values.model,
          contextWindow: values.contextWindow,
          apiKey: values.apiKey ?? '',
          baseUrl: values.baseUrl?.trim() || undefined
        });
        message.success('模型配置已创建');
      }
      setOpen(false);
      form.resetFields();
      await state.reload();
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (record: ModelConfig) => {
    await api.updateModel(record.id, { status: record.status === 'active' ? 'disabled' : 'active' });
    message.success(record.status === 'active' ? '模型已禁用' : '模型已启用');
    await state.reload();
  };

  const remove = async (record: ModelConfig) => {
    await api.deleteModel(record.id);
    message.success('模型配置已删除');
    await state.reload();
  };

  return (
    <Page
      title="模型配置"
      subtitle="平台级模型档案由超级管理员统一维护，所有组织共享已启用的模型。"
      action={
        <Space>
          <RefreshButton onClick={state.reload} />
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            添加模型
          </Button>
        </Space>
      }
    >
      <Card>
        <ResourceState state={state} empty="尚未配置平台模型。">
          {(items) => (
            <Table
              rowKey="id"
              dataSource={items}
              pagination={false}
              columns={columns(
                openEdit,
                (record) => void toggle(record),
                (record) => void remove(record)
              )}
            />
          )}
        </ResourceState>
      </Card>
      <Modal
        title={editing ? '编辑模型' : '添加模型'}
        width={640}
        open={open}
        confirmLoading={saving}
        onCancel={() => setOpen(false)}
        onOk={() => void save()}
        okText="保存"
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="name" label="显示名称" rules={[{ required: true, message: '请输入显示名称' }]}>
                <Input placeholder="默认模型" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="provider" label="供应商" rules={[{ required: true }]}>
                <Select options={providerOptions} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="model" label="模型 ID" rules={[{ required: true, message: '请输入模型 ID' }]}>
            <Input placeholder="gpt-5.1" />
          </Form.Item>
          <Form.Item
            name="contextWindow"
            label="上下文长度"
            rules={[{ required: true, message: '请输入上下文长度' }]}
            extra="模型单次请求可使用的最大 Token 数，将同步到 Worker 的上下文治理策略。"
          >
            <InputNumber<number>
              min={4_096}
              max={2_000_000}
              step={16_000}
              precision={0}
              style={{ width: '100%' }}
              formatter={(value) => (value === undefined ? '' : Number(value).toLocaleString())}
              parser={(value) => Number(String(value ?? '').replaceAll(',', ''))}
              placeholder="256,000"
            />
          </Form.Item>
          <Form.Item
            name="apiKey"
            label={editing ? '替换 API Key（可选）' : 'API Key'}
            rules={editing ? [] : [{ required: true, min: 8, message: '请输入有效的 API Key' }]}
            extra={editing ? '留空将继续使用现有凭证。' : '密钥只写入加密凭证，不会在页面回显。'}
          >
            <Input.Password placeholder={editing ? '不修改请留空' : '输入 API Key'} />
          </Form.Item>
          <Form.Item name="baseUrl" label="兼容网关地址（可选）">
            <Input placeholder="https://api.openai.com/v1" />
          </Form.Item>
        </Form>
      </Modal>
    </Page>
  );
}

const providerOptions = ['openai', 'anthropic', 'openrouter', 'deepseek', 'xai'].map((value) => ({
  value,
  label: value === 'xai' ? 'xAI' : value.charAt(0).toUpperCase() + value.slice(1)
}));

function columns(
  edit: (record: ModelConfig) => void,
  toggle: (record: ModelConfig) => void,
  remove: (record: ModelConfig) => void
) {
  return [
    {
      title: '配置名称',
      dataIndex: 'name',
      render: (name: string, record: ModelConfig) => (
        <Space>
          <Avatar shape="square" icon={<BuildOutlined />} />
          <div className="person-cell">
            <strong>{name}</strong>
            <span>{record.provider}</span>
          </div>
        </Space>
      )
    },
    { title: '模型 ID', dataIndex: 'model' },
    {
      title: '上下文长度',
      dataIndex: 'contextWindow',
      render: (value: number) => `${value.toLocaleString()} Token`
    },
    {
      title: '凭证',
      dataIndex: 'credentialHandleId',
      render: (value: string | null) =>
        value ? <Tag color="success">已配置</Tag> : <Tag color="warning">未配置</Tag>
    },
    {
      title: '状态',
      dataIndex: 'status',
      render: (value: string, record: ModelConfig) => (
        <Space>
          <Switch checked={value === 'active'} onChange={() => toggle(record)} />
          <Typography.Text type="secondary">{value === 'active' ? '已启用' : '已禁用'}</Typography.Text>
        </Space>
      )
    },
    { title: '更新时间', dataIndex: 'updatedAt', render: formatDate },
    {
      title: '操作',
      key: 'actions',
      fixed: 'right' as const,
      render: (_: unknown, record: ModelConfig) => (
        <Space>
          <Button type="link" icon={<EditOutlined />} onClick={() => edit(record)}>
            编辑
          </Button>
          <Popconfirm
            title="删除模型配置？"
            description="已有对话会自动恢复为平台默认模型。该操作不可撤销。"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => remove(record)}
          >
            <Button type="link" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      )
    }
  ];
}
