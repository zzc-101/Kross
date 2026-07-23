import type { CloudWorkspace, WorkspaceProgress } from '@kross/protocol';
import { Bot, CircleCheck, FolderGit2, Plus, Settings } from 'lucide-react';
import { useState } from 'react';

import type { SetupStatus } from '../../setupApi';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle
} from '../ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Progress } from '../ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../ui/select';
import { Textarea } from '../ui/textarea';

export type WorkspaceCredential =
  | { type: 'https-token'; token: string }
  | { type: 'ssh-key'; privateKey: string };

export function EmptyState(props: {
  hasWorkspace: boolean;
  setupStatus?: SetupStatus;
  onCreate: () => void;
  onAddWorkspace: () => void;
  onOpenSetup: () => void;
}) {
  const providerReady = Boolean(
    props.setupStatus?.provider.hasApiKey &&
    props.setupStatus.provider.model
  );
  return (
    <Card className="empty">
      <CardContent className="empty-content">
        <div className="empty-mark">K</div>
        <span className="eyebrow">Kross Cloud Agent</span>
        <h1>{props.hasWorkspace ? '开始一个新会话' : '准备你的第一个工作区'}</h1>
        <p>
          {props.hasWorkspace
            ? '会话、审批和运行记录都会保存在隔离的工作区中。'
            : '先完成模型配置，再连接 Git 仓库，Kross 会创建独立执行环境。'}
        </p>
        <div className="onboarding-steps">
          <Button
            variant="ghost"
            className={providerReady ? 'complete' : ''}
            onClick={props.onOpenSetup}
          >
            <span>{providerReady ? <CircleCheck /> : <Settings />}</span>
            <div><strong>配置模型</strong><small>{providerReady ? `${props.setupStatus?.provider.provider} 已就绪` : '设置 Provider 和 API Key'}</small></div>
          </Button>
          <Button
            variant="ghost"
            className={props.hasWorkspace ? 'complete' : ''}
            onClick={props.onAddWorkspace}
          >
            <span>{props.hasWorkspace ? <CircleCheck /> : <FolderGit2 />}</span>
            <div><strong>连接仓库</strong><small>{props.hasWorkspace ? '工作区已经就绪' : '公开或私有 Git 仓库'}</small></div>
          </Button>
          <Button variant="ghost" disabled={!props.hasWorkspace} onClick={props.onCreate}>
            <span><Bot /></span>
            <div><strong>创建任务</strong><small>让 Agent 分析、修改并验证代码</small></div>
          </Button>
        </div>
        {props.hasWorkspace && (
          <Button onClick={props.onCreate}><Plus /> 新建会话</Button>
        )}
      </CardContent>
    </Card>
  );
}

export function WorkspaceForm(props: {
  onClose: () => void;
  onCreate: (
    name: string,
    url: string,
    defaultBranch: string,
    credential?: WorkspaceCredential
  ) => void;
}) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('');
  const [credentialType, setCredentialType] = useState<'none' | 'https-token' | 'ssh-key'>('none');
  const [secret, setSecret] = useState('');
  const credential: WorkspaceCredential | undefined =
    credentialType === 'https-token'
      ? { type: 'https-token', token: secret }
      : credentialType === 'ssh-key'
        ? { type: 'ssh-key', privateKey: secret }
        : undefined;
  const validationError = validateWorkspaceInput(
    url,
    credentialType,
    secret
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent className="workspace-dialog">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!validationError) {
              props.onCreate(
                name.trim(),
                url.trim(),
                defaultBranch.trim(),
                credential
              );
            }
          }}
        >
          <DialogHeader>
            <span className="eyebrow">工作区</span>
            <DialogTitle>添加工作区</DialogTitle>
            <DialogDescription>
              仓库会克隆到独立数据卷，创建过程可随时查看阶段进度。
            </DialogDescription>
          </DialogHeader>

          <Label className="dialog-field">
            名称
            <Input
              autoFocus
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Label>
          <Label className="dialog-field">
            Git URL
            <Input
              required
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://github.com/org/repo.git"
            />
          </Label>
          <Label className="dialog-field">
            默认分支（可选）
            <Input
              value={defaultBranch}
              onChange={(event) => setDefaultBranch(event.target.value)}
              placeholder="自动检测"
              pattern="[A-Za-z0-9][A-Za-z0-9._/-]*"
            />
          </Label>
          <Label className="dialog-field">
            仓库凭证
            <Select
              value={credentialType}
              onValueChange={(value) => {
                setCredentialType(value as typeof credentialType);
                setSecret('');
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">公开仓库 / 无凭证</SelectItem>
                <SelectItem value="https-token">HTTPS Token</SelectItem>
                <SelectItem value="ssh-key">SSH 私钥</SelectItem>
              </SelectContent>
            </Select>
          </Label>

          {credentialType === 'https-token' && (
            <Label className="dialog-field">
              Token
              <Input
                required
                type="password"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                autoComplete="new-password"
              />
            </Label>
          )}
          {credentialType === 'ssh-key' && (
            <Label className="dialog-field">
              私钥
              <Textarea
                required
                rows={6}
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                autoComplete="off"
              />
            </Label>
          )}

          {url && validationError && <p className="form-error">{validationError}</p>}
          <p className="credential-note">
            凭证仅发送给对应工作区的初始化容器，不写入网关日志。
          </p>
          <DialogFooter className="form-actions">
            <Button type="button" variant="outline" onClick={props.onClose}>
              取消
            </Button>
            <Button disabled={Boolean(validationError)}>创建工作区</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function WorkspaceActions(props: {
  workspace: CloudWorkspace;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const workspace = props.workspace;
  return (
    <Card className="workspace-actions">
      <CardHeader>
        <div className="workspace-status">
          <CardTitle>{workspace.name}</CardTitle>
          <Badge variant={workspace.status === 'ready' ? 'secondary' : 'outline'}>
            {workspaceStatusLabel(workspace.status)}
          </Badge>
        </div>
        <CardDescription>{workspace.gitUrl}</CardDescription>
      </CardHeader>
      <CardFooter>
        <Button variant="outline" size="sm" onClick={props.onToggle}>
          {workspace.status === 'stopped' ? '启动' : '停止'}
        </Button>
        <Button variant="destructive" size="sm" onClick={props.onDelete}>
          删除
        </Button>
      </CardFooter>
    </Card>
  );
}

export function WorkspaceProgressPanel(props: {
  progress: WorkspaceProgress;
  onClose: () => void;
  onRetry: () => void;
}) {
  const stages: Array<{
    id: WorkspaceProgress['stage'];
    label: string;
  }> = [
    { id: 'validating', label: '校验仓库' },
    { id: 'provisioning', label: '准备环境' },
    { id: 'cloning', label: '克隆代码' },
    { id: 'starting', label: '启动 Worker' },
    { id: 'ready', label: '工作区就绪' }
  ];
  const currentIndex =
    props.progress.stage === 'failed'
      ? -1
      : stages.findIndex((stage) => stage.id === props.progress.stage);
  const terminal =
    props.progress.stage === 'ready' || props.progress.stage === 'failed';
  const progressValue =
    props.progress.stage === 'failed'
      ? 0
      : Math.max(0, ((currentIndex + 1) / stages.length) * 100);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && terminal) props.onClose();
      }}
    >
      <DialogContent className={`provision-panel ${terminal ? 'terminal' : ''}`}>
        <DialogHeader>
          <span className="eyebrow">Workspace Provisioning</span>
          <DialogTitle>{props.progress.name}</DialogTitle>
          <DialogDescription role="status" aria-live="polite">
            {props.progress.message}
          </DialogDescription>
        </DialogHeader>
        <Progress
          value={progressValue}
          aria-label="工作区创建进度"
          className={props.progress.stage === 'failed' ? 'failed' : undefined}
        />
        <div className="provision-steps">
          {stages.map((stage, index) => (
            <div
              key={stage.id}
              className={
                currentIndex > index || props.progress.stage === 'ready'
                  ? 'complete'
                  : currentIndex === index
                    ? 'active'
                    : ''
              }
            >
              <span>
                {currentIndex > index || props.progress.stage === 'ready'
                  ? '✓'
                  : index + 1}
              </span>
              <strong>{stage.label}</strong>
            </div>
          ))}
        </div>
        {props.progress.stage === 'failed' && (
          <p className="form-error">
            创建失败。请检查仓库地址、分支和凭据后重试。
          </p>
        )}
        <DialogFooter className="form-actions">
          {props.progress.stage === 'failed' && (
            <Button variant="outline" onClick={props.onRetry}>修改并重试</Button>
          )}
          {terminal && (
            <Button onClick={props.onClose}>
              {props.progress.stage === 'ready' ? '进入工作区' : '关闭'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function workspaceStatusLabel(status: CloudWorkspace['status']): string {
  return {
    ready: '运行中',
    stopped: '已停止',
    creating: '创建中',
    error: '异常'
  }[status] ?? status;
}

function validateWorkspaceInput(
  value: string,
  credentialType: 'none' | 'https-token' | 'ssh-key',
  secret: string
): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const scpStyle = /^[\w.-]+@[\w.-]+:.+/.test(trimmed);
  if (scpStyle) {
    if (credentialType === 'https-token') {
      return 'HTTPS Token 不能用于 SSH 仓库地址';
    }
  } else {
    try {
      const url = new URL(trimmed);
      if (!['https:', 'ssh:', 'git:', 'git+ssh:'].includes(url.protocol)) {
        return '仅支持 HTTPS 或 SSH Git 地址';
      }
      if (url.username || url.password) {
        return 'Git URL 不能内嵌凭据，请使用下方凭据字段';
      }
      if (credentialType === 'https-token' && url.protocol !== 'https:') {
        return 'HTTPS Token 只能用于 https:// 地址';
      }
      if (
        credentialType === 'ssh-key' &&
        !['ssh:', 'git+ssh:'].includes(url.protocol)
      ) {
        return 'SSH 私钥需要 ssh://、git+ssh:// 或 scp 风格地址';
      }
    } catch {
      return '请输入完整的 HTTPS、SSH 或 scp 风格 Git 地址';
    }
  }
  if (credentialType !== 'none' && !secret.trim()) {
    return credentialType === 'https-token'
      ? '请输入 HTTPS Token'
      : '请输入 SSH 私钥';
  }
  if (
    credentialType === 'ssh-key' &&
    secret &&
    !secret.includes('PRIVATE KEY')
  ) {
    return 'SSH 私钥格式不正确';
  }
  return undefined;
}
