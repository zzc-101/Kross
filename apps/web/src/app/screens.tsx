import { FormEvent, useState } from 'react';

export function IdentityScreen({
  defaultUserId,
  onSubmit
}: {
  defaultUserId: string;
  onSubmit(userId: string): void;
}) {
  return (
    <main className="gate">
      <form
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const id = String(new FormData(event.currentTarget).get('userId') ?? '').trim();
          if (id) onSubmit(id);
        }}
      >
        <div className="mark">K</div>
        <h1>进入工作区</h1>
        <p>开发环境身份由控制面显式启用。工作台与管理端使用同一个用户 ID。</p>
        <label>
          <span>开发用户 ID</span>
          <input name="userId" required pattern="[A-Za-z0-9][A-Za-z0-9_-]*" defaultValue={defaultUserId} autoFocus />
        </label>
        <button className="primary" type="submit">继续</button>
      </form>
    </main>
  );
}

export function OrganizationSetup({
  error,
  onCreate
}: {
  error?: string;
  onCreate(name: string, slug: string): Promise<boolean>;
}) {
  const [pending, setPending] = useState(false);
  return (
    <main className="gate">
      <form
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const name = String(data.get('name') ?? '').trim();
          const slug = String(data.get('slug') ?? '').trim();
          if (!name || !slug) return;
          setPending(true);
          void onCreate(name, slug).finally(() => setPending(false));
        }}
      >
        <div className="mark">K</div>
        <h1>创建组织</h1>
        <p>还没有组织。创建一个之后，系统会给你分配长期 Agent 工作区。</p>
        {error && <p className="gate-error">{error}</p>}
        <label>
          <span>组织名称</span>
          <input name="name" required autoFocus />
        </label>
        <label>
          <span>Slug</span>
          <input name="slug" required pattern="[a-z0-9][a-z0-9-]*" placeholder="acme" />
        </label>
        <button className="primary" type="submit" disabled={pending}>{pending ? '创建中…' : '创建组织'}</button>
      </form>
    </main>
  );
}
