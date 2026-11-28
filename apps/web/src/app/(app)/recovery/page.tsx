'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { LossReason } from '@/components/recovery-panel';
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
  useAction,
  useLoad,
} from '@/components/ui';
import { api } from '@/lib/api';
import { fmtDateTime as fmt } from '@/lib/lead-format';
import { useSession } from '@/lib/session';
import type { Brand } from '@/lib/types';

interface Row {
  id: string;
  leadId: string;
  leadNumber?: string;
  name?: string;
  status: string;
  lossReason: string | null;
  ownerName: string | null;
  attempts: number;
  maxAttempts: number;
  startsAt: string;
  nextAttemptAt: string | null;
  due: boolean;
  awaitingManager: boolean;
}
interface Policy {
  enabled: boolean;
  cooldownDays: number;
  maxAttempts: number;
  attemptIntervalDays: number;
  ownerMode: 'DIFFERENT_EXECUTIVE' | 'SAME_OWNER' | 'QUEUE';
  autoCloseAfterMax: boolean;
}

export default function RecoveryPage() {
  const { can } = useSession();
  const manager = can('recovery.manage');
  const brands = useLoad(() => api<Brand[]>('/brands'));
  const [view, setView] = useState(manager ? 'all' : 'mine');
  const [status, setStatus] = useState('ACTIVE');
  const rows = useLoad(() => api<Row[]>(`/recovery?view=${view}&status=${status}`), [view, status]);
  const [brandId, setBrandId] = useState('');
  const bid = brandId || brands.data?.[0]?.id || '';

  return (
    <>
      <PageHeader
        title="Lost lead recovery"
        description="Lost leads come back here after their cooldown for a fresh attempt."
      />
      <div className="space-y-6">
        <Card
          actions={
            <div className="flex gap-2">
              {manager && (
                <Select
                  aria-label="Whose"
                  className="w-40"
                  value={view}
                  onChange={(e) => setView(e.target.value)}
                >
                  <option value="mine">Mine</option>
                  <option value="all">All in my brands</option>
                </Select>
              )}
              <Select
                aria-label="Status"
                className="w-44"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                <option value="ACTIVE">Being worked</option>
                <option value="SCHEDULED">In cooldown</option>
                <option value="RECOVERED">Recovered</option>
                <option value="CLOSED">Closed</option>
                <option value="CANCELLED">Cancelled</option>
              </Select>
            </div>
          }
        >
          <ErrorText error={rows.error} />
          <Table
            head={['Lead', 'Loss reason', 'Owner', 'Attempts', 'Next', '']}
            empty={rows.data?.length === 0}
          >
            {rows.data?.map((r) => (
              <tr key={r.id}>
                <Td>
                  <Link
                    href={`/leads/${r.leadId}`}
                    className="font-medium text-brand-700 hover:underline"
                  >
                    {r.name} ({r.leadNumber})
                  </Link>
                </Td>
                <Td>{r.lossReason}</Td>
                <Td>{r.ownerName ?? <span className="text-amber-700">needs an owner</span>}</Td>
                <Td className="tabular-nums">
                  {r.attempts}/{r.maxAttempts}
                </Td>
                <Td className="whitespace-nowrap">
                  {r.status === 'SCHEDULED'
                    ? fmt(r.startsAt)
                    : r.nextAttemptAt
                      ? fmt(r.nextAttemptAt)
                      : '—'}
                </Td>
                <Td>
                  {r.due && <Badge tone="red">due</Badge>}
                  {r.awaitingManager && <Badge tone="amber">manager to decide</Badge>}
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
        {can('settings.manage') && bid && (
          <>
            <div className="w-64">
              <Field label="Settings for brand">
                <Select value={bid} onChange={(e) => setBrandId(e.target.value)}>
                  {brands.data?.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <PolicyCard brandId={bid} />
            <ReasonsCard brandId={bid} />
          </>
        )}
      </div>
    </>
  );
}

function PolicyCard({ brandId }: { brandId: string }) {
  const policy = useLoad(() => api<Policy>(`/recovery/policy?brandId=${brandId}`), [brandId]);
  const [f, setF] = useState<Policy | null>(null);
  const { busy, error, run } = useAction();
  useEffect(() => {
    if (policy.data) setF(policy.data);
  }, [policy.data]);
  if (!f) return <ErrorText error={policy.error} />;
  const num = (k: keyof Policy, label: string) => (
    <div className="w-40">
      <Field label={label}>
        <Input
          type="number"
          min={0}
          value={String(f[k])}
          onChange={(e) => setF({ ...f, [k]: Number(e.target.value) })}
        />
      </Field>
    </div>
  );
  return (
    <Card title="Recovery rules">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const {
              enabled,
              cooldownDays,
              maxAttempts,
              attemptIntervalDays,
              ownerMode,
              autoCloseAfterMax,
            } = f;
            await api(`/recovery/policy?brandId=${brandId}`, {
              method: 'PUT',
              body: {
                enabled,
                cooldownDays,
                maxAttempts,
                attemptIntervalDays,
                ownerMode,
                autoCloseAfterMax,
              },
            });
            await policy.reload();
          });
        }}
      >
        <div className="flex flex-wrap items-end gap-3">
          {num('cooldownDays', 'Cooldown (days)')}
          {num('maxAttempts', 'Max attempts')}
          {num('attemptIntervalDays', 'Days between attempts')}
          <div className="w-64">
            <Field label="Who works the recovery">
              <Select
                value={f.ownerMode}
                onChange={(e) => setF({ ...f, ownerMode: e.target.value as Policy['ownerMode'] })}
              >
                <option value="DIFFERENT_EXECUTIVE">A different executive</option>
                <option value="SAME_OWNER">The same owner</option>
                <option value="QUEUE">A manager assigns</option>
              </Select>
            </Field>
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={f.enabled}
            onChange={(e) => setF({ ...f, enabled: e.target.checked })}
          />
          Recovery enabled
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={f.autoCloseAfterMax}
            onChange={(e) => setF({ ...f, autoCloseAfterMax: e.target.checked })}
          />
          Close automatically after the last attempt (otherwise a manager decides)
        </label>
        <ErrorText error={error} />
        <Button type="submit" disabled={busy}>
          Save rules
        </Button>
      </form>
    </Card>
  );
}

function ReasonsCard({ brandId }: { brandId: string }) {
  const reasons = useLoad(() => api<LossReason[]>(`/loss-reasons?brandId=${brandId}`), [brandId]);
  const [f, setF] = useState({ code: '', label: '', recoverable: true });
  const { busy, error, run } = useAction();
  const patch = (r: LossReason, body: Partial<LossReason>) =>
    run(async () => {
      await api(`/loss-reasons/${r.id}`, { method: 'PATCH', body });
      await reasons.reload();
    });
  return (
    <Card title="Loss reasons">
      <Table head={['Reason', 'Code', 'Recoverable', 'Active']} empty={reasons.data?.length === 0}>
        {reasons.data?.map((r) => (
          <tr key={r.id} className={r.active ? '' : 'text-slate-500'}>
            <Td>{r.label}</Td>
            <Td className="font-mono text-xs">{r.code}</Td>
            <Td>
              <input
                type="checkbox"
                aria-label={`${r.label} recoverable`}
                checked={r.recoverable}
                disabled={busy}
                onChange={(e) => void patch(r, { recoverable: e.target.checked })}
              />
            </Td>
            <Td>
              <input
                type="checkbox"
                aria-label={`${r.label} active`}
                checked={r.active}
                disabled={busy}
                onChange={(e) => void patch(r, { active: e.target.checked })}
              />
            </Td>
          </tr>
        ))}
      </Table>
      <form
        className="mt-4 flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api('/loss-reasons', { method: 'POST', body: { brandId, ...f } });
            setF({ code: '', label: '', recoverable: true });
            await reasons.reload();
          });
        }}
      >
        <div className="w-64">
          <Field label="New reason">
            <Input
              required
              minLength={2}
              value={f.label}
              onChange={(e) => setF({ ...f, label: e.target.value })}
            />
          </Field>
        </div>
        <div className="w-48">
          <Field label="Code">
            <Input
              required
              value={f.code}
              onChange={(e) =>
                setF({ ...f, code: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') })
              }
            />
          </Field>
        </div>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <input
            type="checkbox"
            checked={f.recoverable}
            onChange={(e) => setF({ ...f, recoverable: e.target.checked })}
          />
          Recoverable
        </label>
        <Button type="submit" disabled={busy}>
          Add reason
        </Button>
      </form>
      <ErrorText error={error ?? reasons.error} />
    </Card>
  );
}
