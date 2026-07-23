import { useEffect, useState, type FormEvent } from 'react';

import { validateGitRef } from './actionDialog';

export type DialogAction =
  | { kind: 'rename-session'; sessionId: string; title: string }
  | { kind: 'model'; model: string }
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

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [props.onClose]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    props.onSubmit(action);
  };

  const gitError =
    action.kind === 'git-push'
      ? validateGitRef(action.branch)
      : action.kind === 'git-pr'
        ? validateGitRef(action.head) ?? validateGitRef(action.base)
        : undefined;

  return (
    <div className="modal-backdrop">
      <form
        className="action-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="action-dialog-title"
        onSubmit={submit}
      >
        <span className="eyebrow">Kross Cloud</span>
        <h2 id="action-dialog-title">{dialogTitle(action)}</h2>
        {action.kind === 'rename-session' && (
          <label>
            会话名称
            <input
              autoFocus
              required
              maxLength={200}
              value={action.title}
              onChange={(event) =>
                setAction({ ...action, title: event.target.value })
              }
            />
          </label>
        )}
        {action.kind === 'model' && (
          <label>
            模型 ID
            <input
              autoFocus
              required
              value={action.model}
              onChange={(event) =>
                setAction({ ...action, model: event.target.value })
              }
            />
          </label>
        )}
        {action.kind === 'git-push' && (
          <div className="action-grid">
            <label>
              Remote
              <input
                required
                value={action.remote}
                onChange={(event) =>
                  setAction({ ...action, remote: event.target.value })
                }
              />
            </label>
            <label>
              分支
              <input
                autoFocus
                required
                value={action.branch}
                onChange={(event) =>
                  setAction({ ...action, branch: event.target.value })
                }
              />
            </label>
          </div>
        )}
        {action.kind === 'git-pr' && (
          <>
            <div className="action-grid">
              <label>
                源分支
                <input
                  autoFocus
                  required
                  value={action.head}
                  onChange={(event) =>
                    setAction({ ...action, head: event.target.value })
                  }
                />
              </label>
              <label>
                目标分支
                <input
                  required
                  value={action.base}
                  onChange={(event) =>
                    setAction({ ...action, base: event.target.value })
                  }
                />
              </label>
            </div>
            <label>
              PR 标题
              <input
                required
                value={action.title}
                onChange={(event) =>
                  setAction({ ...action, title: event.target.value })
                }
              />
            </label>
            <label>
              PR 描述（可选）
              <textarea
                rows={5}
                value={action.body}
                onChange={(event) =>
                  setAction({ ...action, body: event.target.value })
                }
              />
            </label>
          </>
        )}
        {action.kind === 'delete-workspace' && (
          <>
            <p>
              即将删除工作区“{action.name}”的 Worker 和登记信息。
            </p>
            <label className="check-row danger-choice">
              <input
                type="checkbox"
                checked={action.removeVolume}
                onChange={(event) =>
                  setAction({ ...action, removeVolume: event.target.checked })
                }
              />
              <span>
                同时永久删除工作区数据卷
                <small>仓库、会话和审批记录将无法恢复。</small>
              </span>
            </label>
            {!action.removeVolume && (
              <p className="form-success">
                数据卷会保留，后续仍可人工恢复。
              </p>
            )}
          </>
        )}
        {gitError && <p className="form-error" role="alert">{gitError}</p>}
        <div className="form-actions">
          <button type="button" onClick={props.onClose}>取消</button>
          <button
            className={
              action.kind === 'delete-workspace' ? 'danger' : 'primary'
            }
            disabled={Boolean(gitError)}
          >
            {action.kind === 'delete-workspace' ? '确认删除' : '确认'}
          </button>
        </div>
      </form>
    </div>
  );
}

function dialogTitle(action: DialogAction): string {
  return {
    'rename-session': '重命名会话',
    model: '切换模型',
    'git-push': '推送分支',
    'git-pr': '创建 Pull Request',
    'delete-workspace': '删除工作区'
  }[action.kind];
}
