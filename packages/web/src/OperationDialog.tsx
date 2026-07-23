import { useState, type FormEvent } from 'react';

import { validateGitRef } from './actionDialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from './components/ui/alert-dialog';
import { Button, buttonVariants } from './components/ui/button';
import { Checkbox } from './components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from './components/ui/dialog';
import { Input } from './components/ui/input';
import { Label } from './components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from './components/ui/select';
import { Textarea } from './components/ui/textarea';

export type DialogAction =
  | { kind: 'rename-session'; sessionId: string; title: string }
  | { kind: 'delete-session'; sessionId: string; title: string }
  | { kind: 'model'; model: string; options: string[] }
  | { kind: 'git-push'; branch: string; remote: string }
  | {
      kind: 'git-pr';
      head: string;
      base: string;
      title: string;
      body: string;
    }
  | {
      kind: 'delete-workspace';
      workspaceId: string;
      name: string;
      removeVolume: boolean;
    };

export function ActionDialog(props: {
  action: DialogAction;
  onSubmit: (action: DialogAction) => void;
  onClose: () => void;
}) {
  const [action, setAction] = useState(props.action);

  if (action.kind === 'delete-session' || action.kind === 'delete-workspace') {
    return (
      <AlertDialog
        open
        onOpenChange={(open) => {
          if (!open) props.onClose();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <span className="eyebrow">Kross Cloud</span>
            <AlertDialogTitle>{dialogTitle(action)}</AlertDialogTitle>
            <AlertDialogDescription>
              {action.kind === 'delete-session'
                ? `即将永久删除会话“${action.title}”及其执行记录，此操作无法撤销。`
                : `即将删除工作区“${action.name}”的 Worker 和登记信息。`}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {action.kind === 'delete-workspace' && (
            <>
              <Label className="destructive-option">
                <Checkbox
                  checked={action.removeVolume}
                  onCheckedChange={(checked) =>
                    setAction({ ...action, removeVolume: checked === true })
                  }
                />
                <span>
                  同时永久删除工作区数据卷
                  <small>仓库、会话和审批记录将无法恢复。</small>
                </span>
              </Label>
              {!action.removeVolume && (
                <p className="form-success">
                  数据卷会保留，后续仍可人工恢复。
                </p>
              )}
            </>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: 'destructive' })}
              onClick={() => props.onSubmit(action)}
            >
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }

  const gitError =
    action.kind === 'git-push'
      ? validateGitRef(action.branch)
      : action.kind === 'git-pr'
        ? validateGitRef(action.head) ?? validateGitRef(action.base)
        : undefined;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    props.onSubmit(action);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent className="action-dialog">
        <form onSubmit={submit}>
          <DialogHeader>
            <span className="eyebrow">Kross Cloud</span>
            <DialogTitle>{dialogTitle(action)}</DialogTitle>
            <DialogDescription>{dialogDescription(action)}</DialogDescription>
          </DialogHeader>

          {action.kind === 'rename-session' && (
            <Label className="dialog-field">
              会话名称
              <Input
                autoFocus
                required
                maxLength={200}
                value={action.title}
                onChange={(event) =>
                  setAction({ ...action, title: event.target.value })
                }
              />
            </Label>
          )}

          {action.kind === 'model' && (
            <Label className="dialog-field">
              模型 ID
              <Select
                required
                value={action.model}
                onValueChange={(model) => setAction({ ...action, model })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="选择模型" />
                </SelectTrigger>
                <SelectContent>
                  {!action.options.includes(action.model) && action.model && (
                    <SelectItem value={action.model}>{action.model}</SelectItem>
                  )}
                  {action.options.map((model) => (
                    <SelectItem key={model} value={model}>{model}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Label>
          )}

          {action.kind === 'git-push' && (
            <div className="action-grid">
              <Label className="dialog-field">
                Remote
                <Input
                  required
                  value={action.remote}
                  onChange={(event) =>
                    setAction({ ...action, remote: event.target.value })
                  }
                />
              </Label>
              <Label className="dialog-field">
                分支
                <Input
                  autoFocus
                  required
                  value={action.branch}
                  onChange={(event) =>
                    setAction({ ...action, branch: event.target.value })
                  }
                />
              </Label>
            </div>
          )}

          {action.kind === 'git-pr' && (
            <>
              <div className="action-grid">
                <Label className="dialog-field">
                  源分支
                  <Input
                    autoFocus
                    required
                    value={action.head}
                    onChange={(event) =>
                      setAction({ ...action, head: event.target.value })
                    }
                  />
                </Label>
                <Label className="dialog-field">
                  目标分支
                  <Input
                    required
                    value={action.base}
                    onChange={(event) =>
                      setAction({ ...action, base: event.target.value })
                    }
                  />
                </Label>
              </div>
              <Label className="dialog-field">
                PR 标题
                <Input
                  required
                  value={action.title}
                  onChange={(event) =>
                    setAction({ ...action, title: event.target.value })
                  }
                />
              </Label>
              <Label className="dialog-field">
                PR 描述（可选）
                <Textarea
                  rows={5}
                  value={action.body}
                  onChange={(event) =>
                    setAction({ ...action, body: event.target.value })
                  }
                />
              </Label>
            </>
          )}

          {gitError && <p className="form-error" role="alert">{gitError}</p>}
          <DialogFooter className="form-actions">
            <Button type="button" variant="outline" onClick={props.onClose}>
              取消
            </Button>
            <Button disabled={Boolean(gitError)}>确认</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function dialogTitle(action: DialogAction): string {
  return {
    'rename-session': '重命名会话',
    'delete-session': '删除会话',
    model: '切换模型',
    'git-push': '推送分支',
    'git-pr': '创建 Pull Request',
    'delete-workspace': '删除工作区'
  }[action.kind];
}

function dialogDescription(action: Exclude<
  DialogAction,
  { kind: 'delete-session' } | { kind: 'delete-workspace' }
>): string {
  return {
    'rename-session': '为当前会话设置一个更容易识别的名称。',
    model: '选择后将应用到当前会话。',
    'git-push': '将当前工作区分支推送到远程仓库。',
    'git-pr': '从当前工作区创建新的 Pull Request。'
  }[action.kind];
}
