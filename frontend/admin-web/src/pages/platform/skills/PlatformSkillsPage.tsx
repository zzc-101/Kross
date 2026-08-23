import { useState } from 'react';
import {
  BulbOutlined,
  CloudUploadOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  HistoryOutlined,
  PlusOutlined,
  RocketOutlined
} from '@ant-design/icons';
import {
  App,
  Avatar,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  Upload
} from 'antd';
import type { UploadFile } from 'antd';
import { AdminApiClient } from '../../../apiClient';
import type { PlatformSkill, SkillVersion } from '../../../contracts';
import { Page } from '../../../components/Page';
import { RefreshButton } from '../../../components/RefreshButton';
import { ResourceState } from '../../../components/ResourceState';
import { useResource } from '../../../hooks/useResource';
import { formatDate } from '../../../utils/format';

type SkillForm = Pick<PlatformSkill,
  'id' | 'name' | 'description' | 'category' | 'icon' | 'launchMode' | 'starterPrompt'> & {
    changelog?: string;
  };

export function PlatformSkillsPage({ api }: { api: AdminApiClient }) {
  const state = useResource(() => api.platformSkills(), [api]);
  const [editing, setEditing] = useState<PlatformSkill>();
  const [metadataOpen, setMetadataOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [packageFile, setPackageFile] = useState<File>();
  const [form] = Form.useForm<SkillForm>();
  const [versionSkill, setVersionSkill] = useState<PlatformSkill>();
  const [versions, setVersions] = useState<SkillVersion[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versionFile, setVersionFile] = useState<File>();
  const [changelog, setChangelog] = useState('');
  const [versionSaving, setVersionSaving] = useState(false);
  const { message } = App.useApp();

  const openCreate = () => {
    setEditing(undefined);
    setPackageFile(undefined);
    form.setFieldsValue({
      id: '', name: '', description: '', category: '办公效率', icon: 'sparkles',
      launchMode: 'instant', starterPrompt: '', changelog: '首次发布'
    });
    setMetadataOpen(true);
  };

  const openEdit = (skill: PlatformSkill) => {
    setEditing(skill);
    setPackageFile(undefined);
    form.setFieldsValue(skill);
    setMetadataOpen(true);
  };

  const save = async () => {
    const values = await form.validateFields();
    if (!editing && !packageFile) {
      message.error('请选择包含 SKILL.md 的 ZIP 包');
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        const { id: _id, changelog: _changelog, ...metadata } = values;
        await api.updatePlatformSkill(editing.id, metadata);
        message.success('Skill 基本信息已更新');
      } else {
        await api.createPlatformSkill(values, packageFile!);
        message.success('Skill 和 v1 草稿已创建，请在版本管理中发布');
      }
      setMetadataOpen(false);
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

  const remove = async (skill: PlatformSkill) => {
    await api.deletePlatformSkill(skill.id);
    message.success(`${skill.name} 已删除`);
    await state.reload();
  };

  const loadVersions = async (skill: PlatformSkill) => {
    setVersionSkill(skill);
    setVersionFile(undefined);
    setChangelog('');
    setVersionsLoading(true);
    try {
      setVersions(await api.skillVersions(skill.id));
    } finally {
      setVersionsLoading(false);
    }
  };

  const uploadVersion = async () => {
    if (!versionSkill || !versionFile) {
      message.error('请选择新的 Skill ZIP 包');
      return;
    }
    setVersionSaving(true);
    try {
      await api.createSkillVersion(versionSkill.id, versionFile, changelog);
      message.success('新版本已上传为草稿');
      setVersionFile(undefined);
      setChangelog('');
      setVersions(await api.skillVersions(versionSkill.id));
      await state.reload();
    } finally {
      setVersionSaving(false);
    }
  };

  const publish = async (version: SkillVersion) => {
    if (!versionSkill) return;
    await api.publishSkillVersion(versionSkill.id, version.version);
    message.success(version.active ? '当前版本未变化' : `v${version.version} 已成为组织使用版本`);
    const refreshed = await api.platformSkills();
    const skill = refreshed.find((item) => item.id === versionSkill.id);
    if (skill) setVersionSkill(skill);
    setVersions(await api.skillVersions(versionSkill.id));
    await state.reload();
  };

  const download = async (version: SkillVersion) => {
    if (!versionSkill) return;
    const result = await api.skillPackageDownload(versionSkill.id, version.version);
    window.open(result.url, '_blank', 'noopener,noreferrer');
  };

  const createFiles: UploadFile[] = packageFile
    ? [{ uid: 'skill-package', name: packageFile.name, status: 'done', originFileObj: packageFile as UploadFile['originFileObj'] }]
    : [];
  const versionFiles: UploadFile[] = versionFile
    ? [{ uid: 'skill-version', name: versionFile.name, status: 'done', originFileObj: versionFile as UploadFile['originFileObj'] }]
    : [];

  return (
    <Page
      title="技能库"
      subtitle="上传完整 Agent Skill ZIP，使用不可变版本发布；组织安装关系始终跟随当前发布版本。"
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
                {
                  title: '版本',
                  render: (_: unknown, record: PlatformSkill) => (
                    <Space><Tag color={record.revision ? 'blue' : 'default'}>{record.revision ? `v${record.revision}` : '未发布'}</Tag><Typography.Text type="secondary">共 {record.versionCount} 个</Typography.Text></Space>
                  )
                },
                { title: '安装组织', dataIndex: 'installCount', render: (value: number) => `${value} 个` },
                {
                  title: '状态', dataIndex: 'status',
                  render: (value: PlatformSkill['status'], record: PlatformSkill) => value === 'draft' ? (
                    <Tag>待发布</Tag>
                  ) : (
                    <Space><Switch checked={value === 'active'} onChange={() => void toggle(record)} /><Typography.Text type="secondary">{value === 'active' ? '可安装' : '全局禁用'}</Typography.Text></Space>
                  )
                },
                { title: '更新时间', dataIndex: 'updatedAt', render: formatDate },
                {
                  title: '操作',
                  render: (_: unknown, record: PlatformSkill) => (
                    <Space size={0}>
                      <Button type="link" icon={<HistoryOutlined />} onClick={() => void loadVersions(record)}>版本</Button>
                      <Button type="link" icon={<EditOutlined />} onClick={() => openEdit(record)}>编辑</Button>
                      <Popconfirm title={`删除 ${record.name}？`} description="仅未安装到任何组织的 Skill 可以删除。" okText="删除" cancelText="取消" onConfirm={() => remove(record)}>
                        <Button type="link" danger icon={<DeleteOutlined />}>删除</Button>
                      </Popconfirm>
                    </Space>
                  )
                }
              ]}
            />
          )}
        </ResourceState>
      </Card>

      <Modal
        title={editing ? `编辑 ${editing.name}` : '创建 Skill'}
        width={720}
        open={metadataOpen}
        confirmLoading={saving}
        okText={editing ? '保存信息' : '创建草稿'}
        onCancel={() => setMetadataOpen(false)}
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
          {!editing && <>
            <Form.Item label="Skill ZIP 包" required extra="必须包含根目录 SKILL.md；可以同时包含 scripts、references 和 assets，最大 10 MB。">
              <Upload.Dragger
                accept=".zip,application/zip"
                maxCount={1}
                fileList={createFiles}
                beforeUpload={(file) => { setPackageFile(file); return false; }}
                onRemove={() => { setPackageFile(undefined); return true; }}
              >
                <p className="ant-upload-drag-icon"><CloudUploadOutlined /></p>
                <p>点击或拖拽 Skill ZIP 到这里</p>
              </Upload.Dragger>
            </Form.Item>
            <Form.Item name="changelog" label="v1 版本说明"><Input maxLength={2000} /></Form.Item>
          </>}
        </Form>
      </Modal>

      <Modal
        title={versionSkill ? `${versionSkill.name} · 版本管理` : '版本管理'}
        width={860}
        open={Boolean(versionSkill)}
        footer={null}
        onCancel={() => setVersionSkill(undefined)}
        destroyOnHidden
      >
        <Card size="small" title="上传新版本" className="skill-version-upload">
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Upload
              accept=".zip,application/zip"
              maxCount={1}
              fileList={versionFiles}
              beforeUpload={(file) => { setVersionFile(file); return false; }}
              onRemove={() => { setVersionFile(undefined); return true; }}
            >
              <Button icon={<CloudUploadOutlined />}>选择 Skill ZIP</Button>
            </Upload>
            <Input.TextArea value={changelog} onChange={(event) => setChangelog(event.target.value)} rows={2} maxLength={2000} showCount placeholder="说明本次更新内容…" />
            <Button type="primary" loading={versionSaving} onClick={() => void uploadVersion()}>上传为新版本</Button>
          </Space>
        </Card>
        <Table
          rowKey="version"
          loading={versionsLoading}
          dataSource={versions}
          pagination={false}
          columns={[
            { title: '版本', dataIndex: 'version', render: (value: number, record: SkillVersion) => <Space><strong>v{value}</strong>{record.active && <Tag color="green">当前发布</Tag>}</Space> },
            { title: '版本说明', dataIndex: 'changelog', render: (value: string) => value || '—' },
            { title: '包大小', dataIndex: 'packageSizeBytes', render: formatBytes },
            { title: '包含内容', dataIndex: 'manifest', render: capabilities },
            { title: '创建时间', dataIndex: 'createdAt', render: formatDate },
            {
              title: '操作',
              render: (_: unknown, record: SkillVersion) => (
                <Space size={0}>
                  <Button type="link" icon={<DownloadOutlined />} onClick={() => void download(record)}>下载</Button>
                  {!record.active && <Popconfirm title={record.publishedAt ? `回滚到 v${record.version}？` : `发布 v${record.version}？`} okText="确认" cancelText="取消" onConfirm={() => publish(record)}>
                    <Button type="link" icon={<RocketOutlined />}>{record.publishedAt ? '回滚' : '发布'}</Button>
                  </Popconfirm>}
                </Space>
              )
            }
          ]}
        />
      </Modal>
    </Page>
  );
}

function launchModeLabel(value: PlatformSkill['launchMode']) {
  return value === 'file' ? '选择文件' : value === 'form' ? '填写参数' : '直接开始';
}

function formatBytes(value: number) {
  if (!value) return '待生成';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function capabilities(manifest: Record<string, unknown>) {
  const values = [
    manifest.hasScripts && '脚本',
    manifest.hasReferences && '资料',
    manifest.hasAssets && '资源'
  ].filter(Boolean) as string[];
  return values.length ? <Space size={4}>{values.map((value) => <Tag key={value}>{value}</Tag>)}</Space> : '仅 SKILL.md';
}
