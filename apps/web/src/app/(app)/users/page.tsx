'use client';
import { useState } from 'react';
import {
  AssignmentDraft,
  AssignmentPicker,
  emptyAssignment,
  useScopeOptions,
} from '@/components/assignment-picker';
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
import type { Assignment, Paged, User } from '@/lib/types';

export default function UsersPage() {
  const { can } = useSession();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const users = useLoad(
    () =>
      api<Paged<User>>(
        `/users?pageSize=100${q ? `&q=${encodeURIComponent(q)}` : ''}${status ? `&status=${status}` : ''}`,
      ),
    [q, status],
  );
  const scope = useScopeOptions();

  return (
    <>
      <PageHeader
        title="Users"
        description="Invite staff and grant roles by organization, brand, branch or team."
        actions={
          can('user.manage') && (
            <Button onClick={() => setInviting((s) => !s)}>
              {inviting ? 'Close' : 'Invite user'}
            </Button>
          )
        }
      />
      {inviting && scope.data && (
        <div className="mb-6">
          <InviteUser
            options={scope.data}
            onDone={() => {
              setInviting(false);
              void users.reload();
            }}
          />
        </div>
      )}
      <Card
        actions={
          <div className="flex flex-wrap gap-2">
            <Input
              placeholder="Search name or email"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="w-56"
            />
            <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-40">
              <option value="">All statuses</option>
              {['ACTIVE', 'INVITED', 'SUSPENDED', 'DEACTIVATED'].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </Select>
          </div>
        }
      >
        <ErrorText error={users.error} />
        <Table
          head={['Name', 'Email', 'Status', 'Last sign-in', '']}
          empty={users.data?.items.length === 0}
        >
          {users.data?.items.map((u) => (
            <tr key={u.id}>
              <Td className="font-medium">{u.name}</Td>
              <Td>{u.email}</Td>
              <Td>
                <Badge tone={statusTone(u.status)}>{u.status}</Badge>
              </Td>
              <Td>{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : '—'}</Td>
              <Td>
                <Button
                  variant="secondary"
                  onClick={() => setSelected(selected === u.id ? null : u.id)}
                >
                  {selected === u.id ? 'Hide' : 'Manage'}
                </Button>
              </Td>
            </tr>
          ))}
        </Table>
        {users.data && <p className="mt-3 text-xs text-slate-500">{users.data.total} user(s)</p>}
      </Card>
      {selected && scope.data && (
        <div className="mt-6">
          <UserDetail
            userId={selected}
            options={scope.data}
            onChanged={() => void users.reload()}
          />
        </div>
      )}
    </>
  );
}

function InviteUser({
  options,
  onDone,
}: {
  options: NonNullable<ReturnType<typeof useScopeOptions>['data']>;
  onDone: () => void;
}) {
  const { canOrgWide } = useSession();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [assignment, setAssignment] = useState<AssignmentDraft>(emptyAssignment());
  const { busy, error, run } = useAction();
  return (
    <Card title="Invite user">
      <form
        className="grid gap-4 sm:grid-cols-3"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api('/users', {
              method: 'POST',
              body: { name, email, assignment: assignment.roleId ? assignment : undefined },
            });
            onDone();
          });
        }}
      >
        <Field label="Full name">
          <Input required value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Email">
          <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <div className="hidden sm:block" />
        <AssignmentPicker value={assignment} onChange={setAssignment} options={options} />
        <div className="sm:col-span-3">
          <p className="mb-3 text-xs text-slate-500">
            An invitation email with a 7-day link is sent.
            {!canOrgWide('user.manage') && ' You must assign a role within your scope.'}
          </p>
          <ErrorText error={error} />
          <Button type="submit" disabled={busy} className="mt-2">
            Send invitation
          </Button>
        </div>
      </form>
    </Card>
  );
}

function UserDetail({
  userId,
  options,
  onChanged,
}: {
  userId: string;
  options: NonNullable<ReturnType<typeof useScopeOptions>['data']>;
  onChanged: () => void;
}) {
  const { can, me } = useSession();
  const user = useLoad(() => api<User>(`/users/${userId}`), [userId]);
  const assignments = useLoad(
    () => api<Assignment[]>(`/users/${userId}/role-assignments?includeRevoked=true`),
    [userId],
  );
  const [draft, setDraft] = useState<AssignmentDraft>(emptyAssignment());
  const [reason, setReason] = useState('');
  const { busy, error, run } = useAction();
  const scopeLabel = (a: Assignment) => {
    if (a.scopeType === 'ORGANIZATION') return 'Whole organization';
    if (a.scopeType === 'BRAND')
      return `Brand: ${options.brands.find((b) => b.id === a.brandId)?.name ?? '(not visible)'}`;
    if (a.scopeType === 'BRANCH')
      return `Branch: ${options.branches.find((b) => b.id === a.branchId)?.name ?? '(not visible)'}`;
    return `Team: ${options.teams.find((t) => t.id === a.teamId)?.name ?? '(not visible)'}`;
  };
  const refresh = async () => {
    await Promise.all([user.reload(), assignments.reload()]);
    onChanged();
  };
  const setStatus = (status: string) =>
    run(async () => {
      if (reason.trim().length < 3)
        throw new Error('Enter a reason (at least 3 characters) first.');
      await api(`/users/${userId}/status`, { method: 'POST', body: { status, reason } });
      setReason('');
      await refresh();
    });
  const u = user.data;
  if (!u) return <ErrorText error={user.error} />;

  return (
    <Card
      title={`${u.name} · ${u.email}`}
      actions={<Badge tone={statusTone(u.status)}>{u.status}</Badge>}
    >
      <h3 className="mb-2 text-sm font-semibold text-slate-700">Role assignments</h3>
      <Table
        head={['Role', 'Scope', 'Granted', 'State', '']}
        empty={assignments.data?.length === 0}
      >
        {assignments.data?.map((a) => (
          <tr key={a.id} className={a.revokedAt ? 'text-slate-400' : ''}>
            <Td>{a.role.name}</Td>
            <Td>{scopeLabel(a)}</Td>
            <Td>{new Date(a.grantedAt).toLocaleDateString()}</Td>
            <Td>
              {a.revokedAt ? `Revoked ${new Date(a.revokedAt).toLocaleDateString()}` : 'Active'}
            </Td>
            <Td>
              {!a.revokedAt && can('role.assign') && (
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      if (reason.trim().length < 3)
                        throw new Error('Enter a reason (at least 3 characters) below first.');
                      await api(`/role-assignments/${a.id}/revoke`, {
                        method: 'POST',
                        body: { reason },
                      });
                      setReason('');
                      await refresh();
                    })
                  }
                >
                  Revoke
                </Button>
              )}
            </Td>
          </tr>
        ))}
      </Table>

      {can('role.assign') && (
        <form
          className="mt-6 grid gap-4 sm:grid-cols-4"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api(`/users/${userId}/role-assignments`, { method: 'POST', body: draft });
              setDraft(emptyAssignment());
              await refresh();
            });
          }}
        >
          <AssignmentPicker value={draft} onChange={setDraft} options={options} />
          <div className="flex items-end">
            <Button type="submit" disabled={busy || !draft.roleId}>
              Grant role
            </Button>
          </div>
        </form>
      )}

      {can('user.manage') && u.id !== me.user.id && (
        <div className="mt-6 border-t border-slate-200 pt-4">
          <h3 className="mb-2 text-sm font-semibold text-slate-700">Account</h3>
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-72 flex-1">
              <Field label="Reason (required for status changes and revocations)">
                <Input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. Resigned on 30 Nov"
                />
              </Field>
            </div>
            {u.status === 'INVITED' && (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api(`/users/${userId}/resend-invite`, { method: 'POST' });
                  })
                }
              >
                Resend invite
              </Button>
            )}
            {u.status === 'ACTIVE' && (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => void setStatus('SUSPENDED')}
              >
                Suspend
              </Button>
            )}
            {(u.status === 'SUSPENDED' || u.status === 'DEACTIVATED') && (
              <Button variant="secondary" disabled={busy} onClick={() => void setStatus('ACTIVE')}>
                Reactivate
              </Button>
            )}
            {u.status !== 'DEACTIVATED' && (
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => void setStatus('DEACTIVATED')}
              >
                Deactivate
              </Button>
            )}
          </div>
        </div>
      )}
      <div className="mt-4">
        <ErrorText error={error} />
      </div>
    </Card>
  );
}
