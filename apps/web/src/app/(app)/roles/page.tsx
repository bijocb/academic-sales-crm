'use client';
import { Badge, Card, ErrorText, PageHeader, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import type { Role } from '@/lib/types';

interface PermissionInfo {
  key: string;
  phase: number;
  description: string;
}

export default function RolesPage() {
  const roles = useLoad(() => api<Role[]>('/roles'));
  const catalog = useLoad(() => api<PermissionInfo[]>('/permissions'));
  const describe = (k: string) => catalog.data?.find((p) => p.key === k);

  return (
    <>
      <PageHeader
        title="Roles"
        description="System roles follow the SRS role model. Permissions marked “later” become active in their phase."
      />
      <ErrorText error={roles.error} />
      <div className="grid gap-4 lg:grid-cols-2">
        {roles.data?.map((r) => (
          <Card
            key={r.id}
            title={r.name}
            actions={r.isSystem ? <Badge tone="blue">System</Badge> : <Badge>Custom</Badge>}
          >
            {r.description && <p className="mb-3 text-sm text-slate-600">{r.description}</p>}
            <ul className="flex flex-wrap gap-1.5">
              {r.permissions.map((p) => {
                const info = describe(p);
                return (
                  <li key={p} title={info?.description}>
                    <Badge tone={info && info.phase <= 2 ? 'green' : 'slate'}>
                      {p}
                      {info && info.phase > 2 ? ' · later' : ''}
                    </Badge>
                  </li>
                );
              })}
            </ul>
          </Card>
        ))}
      </div>
    </>
  );
}
