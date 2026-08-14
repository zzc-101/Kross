import { useEffect, useMemo, useState } from 'react';

import { AgentApiClient } from '../api/client';
import type { Membership } from '../api/types';
import { WorkspacePage } from '../workspace/WorkspacePage';
import { IdentityScreen, OrganizationSetup } from './screens';

const USER_KEY = 'kross.dev-user-id';
const ORG_KEY = 'kross.organization-id';

export function App() {
  const [devUserId, setDevUserId] = useState(
    () => localStorage.getItem(USER_KEY) || import.meta.env.VITE_DEV_USER_ID || 'demo-user'
  );
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [organizationId, setOrganizationId] = useState(() => localStorage.getItem(ORG_KEY) || '');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const api = useMemo(() => new AgentApiClient({ devUserId }), [devUserId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void api.me().then((me) => {
      if (cancelled) return;
      setMemberships(me.memberships);
      setOrganizationId((current) => {
        const next = me.memberships.find((item) => item.organizationId === current)?.organizationId
          ?? me.memberships[0]?.organizationId
          ?? '';
        if (next) {
          api.selectOrganization(next);
          localStorage.setItem(ORG_KEY, next);
        }
        return next;
      });
      setLoading(false);
    }).catch((cause) => {
      if (!cancelled) {
        setError(cause instanceof Error ? cause.message : '无法读取身份');
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  if (!devUserId) {
    return (
      <IdentityScreen
        defaultUserId="demo-user"
        onSubmit={(id) => {
          localStorage.setItem(USER_KEY, id);
          setDevUserId(id);
        }}
      />
    );
  }

  if (loading) {
    return <main className="gate"><div className="mark">K</div><h1>正在进入工作区</h1><p>加载身份与组织…</p></main>;
  }

  if (memberships.length === 0) {
    return (
      <OrganizationSetup
        error={error}
        onCreate={async (name, slug) => {
          const me = await api.bootstrapOrganization({ name, slug });
          setMemberships(me.memberships);
          const first = me.memberships[0]?.organizationId ?? '';
          setOrganizationId(first);
          if (first) {
            api.selectOrganization(first);
            localStorage.setItem(ORG_KEY, first);
          }
          return true;
        }}
      />
    );
  }

  return (
    <WorkspacePage
      api={api}
      memberships={memberships}
      organizationId={organizationId}
      devUserId={devUserId}
      onSelectOrganization={(id) => {
        api.selectOrganization(id);
        localStorage.setItem(ORG_KEY, id);
        setOrganizationId(id);
      }}
      onChangeIdentity={() => {
        localStorage.removeItem(USER_KEY);
        setDevUserId('');
      }}
    />
  );
}
