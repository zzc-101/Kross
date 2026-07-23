import type { TFunction } from 'i18next';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

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
  const { t } = useTranslation();
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
            <span className="eyebrow">{t('operation.brand')}</span>
            <AlertDialogTitle>{dialogTitle(action, t)}</AlertDialogTitle>
            <AlertDialogDescription>
              {action.kind === 'delete-session'
                ? t('operation.deleteSessionWarning', { title: action.title })
                : t('operation.deleteWorkspaceWarning', { name: action.name })}
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
                  {t('operation.removeVolume')}
                  <small>{t('operation.removeVolumeHint')}</small>
                </span>
              </Label>
              {!action.removeVolume && (
                <p className="form-success">
                  {t('operation.keepVolume')}
                </p>
              )}
            </>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: 'destructive' })}
              onClick={() => props.onSubmit(action)}
            >
              {t('operation.confirmDelete')}
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
            <span className="eyebrow">{t('operation.brand')}</span>
            <DialogTitle>{dialogTitle(action, t)}</DialogTitle>
            <DialogDescription>{dialogDescription(action, t)}</DialogDescription>
          </DialogHeader>

          {action.kind === 'rename-session' && (
            <Label className="dialog-field">
              {t('operation.sessionName')}
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
              {t('operation.modelId')}
              <Select
                required
                value={action.model}
                onValueChange={(model) => setAction({ ...action, model })}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t('operation.selectModel')} />
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
                {t('operation.branch')}
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
                  {t('operation.sourceBranch')}
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
                  {t('operation.targetBranch')}
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
                {t('operation.prTitle')}
                <Input
                  required
                  value={action.title}
                  onChange={(event) =>
                    setAction({ ...action, title: event.target.value })
                  }
                />
              </Label>
              <Label className="dialog-field">
                {t('operation.prBody')}
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
              {t('common.cancel')}
            </Button>
            <Button disabled={Boolean(gitError)}>{t('common.confirm')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function dialogTitle(action: DialogAction, t: TFunction): string {
  return {
    'rename-session': t('operation.renameSession'),
    'delete-session': t('operation.deleteSession'),
    model: t('operation.switchModel'),
    'git-push': t('operation.pushBranch'),
    'git-pr': t('operation.createPr'),
    'delete-workspace': t('operation.deleteWorkspace')
  }[action.kind];
}

function dialogDescription(action: Exclude<
  DialogAction,
  { kind: 'delete-session' } | { kind: 'delete-workspace' }
>, t: TFunction): string {
  return {
    'rename-session': t('operation.renameDescription'),
    model: t('operation.modelDescription'),
    'git-push': t('operation.pushDescription'),
    'git-pr': t('operation.prDescription')
  }[action.kind];
}
