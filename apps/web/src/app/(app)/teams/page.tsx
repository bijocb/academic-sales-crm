'use client';
import { useState } from 'react';
import {
  Badge,
  Button,
  Card,
  ErrorText,
  Field,
  Input,
  PageHeader,
  Select,
  Table,
  Td,
  statusTone,
  useAction,
  useLoad,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { Branch, Brand, Paged, Team, User } from '@/lib/types';

export default function TeamsPage() {
  const { can } = useSession();
  const teams = useLoad(() => api<Team[]>('/teams'));
  const brands = useLoad(() => api<Brand[]>('/brands'));
  const [showCreate, setShowCreate] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const brandName = (id: string) => brands.data?.find((b) => b.id === id)?.name ?? '—';

  return (
    <>
      <PageHeader
        title="Teams"
        description="Sales teams belong to a brand and optionally a branch."
        actions={
          can('team.manage') && (
            <Button onClick={() => setShowCreate((s) => !s)}>
              {showCreate ? 'Close' : 'New team'}
            </Button>
          )
        }
      />
      {showCreate && brands.data && (
        <div className="mb-6">
          <CreateTeam
            brands={brands.data}
            onDone={() => {
              setShowCreate(false);
              void teams.reload();
            }}
          />
        </div>
      )}
      <ErrorText error={teams.error} />
      <Card>
        <Table
          head={['Team', 'Brand', 'Leader', 'Members', 'Status', '']}
          empty={teams.data?.length === 0}
        >
          {teams.data?.map((t) => (
            <tr key={t.id}>
              <Td className="font-medium">{t.name}</Td>
              <Td>{brandName(t.brandId)}</Td>
              <Td>{t.leader?.name ?? '—'}</Td>
              <Td>{t._count?.members ?? 0}</Td>
              <Td>
                <Badge tone={statusTone(t.status)}>{t.status}</Badge>
              </Td>
              <Td>
                <Button
                  variant="secondary"
                  onClick={() => setSelected(selected === t.id ? null : t.id)}
                >
                  {selected === t.id ? 'Hide' : 'Members'}
                </Button>
              </Td>
            </tr>
          ))}
        </Table>
      </Card>
      {selected && (
        <div className="mt-6">
          <TeamMembers
            teamId={selected}
            canManage={can('team.manage')}
            onChanged={() => void teams.reload()}
          />
        </div>
      )}
    </>
  );
}

function CreateTeam({ brands, onDone }: { brands: Brand[]; onDone: () => void }) {
  const [brandId, setBrandId] = useState(brands[0]?.id ?? '');
  const [branchId, setBranchId] = useState('');
  const [name, setName] = useState('');
  const branches = useLoad(
    () => (brandId ? api<Branch[]>(`/branches?brandId=${brandId}`) : Promise.resolve([])),
    [brandId],
  );
  const { busy, error, run } = useAction();
  return (
    <Card title="New team">
      <form
        className="grid gap-4 sm:grid-cols-4"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api('/teams', {
              method: 'POST',
              body: { brandId, branchId: branchId || undefined, name },
            });
            onDone();
          });
        }}
      >
        <Field label="Brand">
          <Select
            value={brandId}
            onChange={(e) => {
              setBrandId(e.target.value);
              setBranchId('');
            }}
          >
            {brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Branch (optional)">
          <Select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
            <option value="">—</option>
            {branches.data?.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Team name">
          <Input required value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="flex items-end">
          <Button type="submit" disabled={busy || !brandId}>
            Create team
          </Button>
        </div>
        <div className="sm:col-span-4">
          <ErrorText error={error} />
        </div>
      </form>
    </Card>
  );
}

function TeamMembers({
  teamId,
  canManage,
  onChanged,
}: {
  teamId: string;
  canManage: boolean;
  onChanged: () => void;
}) {
  const team = useLoad(() => api<Team>(`/teams/${teamId}`), [teamId]);
  const users = useLoad(
    () =>
      canManage ? api<Paged<User>>('/users?pageSize=200&status=ACTIVE') : Promise.resolve(null),
    [canManage],
  );
  const [userId, setUserId] = useState('');
  const { busy, error, run } = useAction();
  const refresh = async () => {
    await team.reload();
    onChanged();
  };
  const memberIds = new Set(team.data?.members?.map((m) => m.user.id));

  return (
    <Card title={`Members · ${team.data?.name ?? ''}`}>
      <Table head={['Name', 'Email', 'Status', '']} empty={team.data?.members?.length === 0}>
        {team.data?.members?.map((m) => (
          <tr key={m.id}>
            <Td>{m.user.name}</Td>
            <Td>{m.user.email}</Td>
            <Td>
              <Badge tone={statusTone(m.user.status)}>{m.user.status}</Badge>
            </Td>
            <Td>
              {canManage && (
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await api(`/teams/${teamId}/members/${m.user.id}`, { method: 'DELETE' });
                      await refresh();
                    })
                  }
                >
                  Remove
                </Button>
              )}
            </Td>
          </tr>
        ))}
      </Table>
      {canManage && (
        <form
          className="mt-4 flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api(`/teams/${teamId}/members`, { method: 'POST', body: { userId } });
              setUserId('');
              await refresh();
            });
          }}
        >
          <div className="min-w-64">
            <Field label="Add member">
              <Select required value={userId} onChange={(e) => setUserId(e.target.value)}>
                <option value="">Select a user…</option>
                {users.data?.items
                  .filter((u) => !memberIds.has(u.id))
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name} ({u.email})
                    </option>
                  ))}
              </Select>
            </Field>
          </div>
          <Button type="submit" disabled={busy || !userId}>
            Add
          </Button>
        </form>
      )}
      <div className="mt-3">
        <ErrorText error={error} />
      </div>
    </Card>
  );
}
