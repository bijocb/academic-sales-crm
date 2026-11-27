'use client';
import Link from 'next/link';
import { useState } from 'react';
import {
  Badge,
  Button,
  Card,
  ErrorText,
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
import { fmtMinutes, SLA_LABEL, slaTone } from '@/lib/task-format';
import type { Brand, SlaOverview, SlaWatchRow } from '@/lib/types';

interface JobRow {
  id: string;
  type: string;
  key: string;
  status: string;
  runAt: string;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
}

function Watch({ rows }: { rows: SlaWatchRow[] }) {
  return (
    <Table
      head={['Lead', 'Owner', 'State', 'Due', 'Working', 'Calendar']}
      empty={rows.length === 0}
    >
      {rows.map((r) => (
        <tr key={r.id}>
          <Td>
            <Link
              href={`/leads/${r.leadId}`}
              className="font-medium text-brand-700 hover:underline"
            >
              {r.leadName} ({r.leadNumber})
            </Link>
          </Td>
          <Td>{r.ownerName ?? '—'}</Td>
          <Td>
            <Badge tone={slaTone(r.state)}>{SLA_LABEL[r.state] ?? r.state}</Badge>
          </Td>
          <Td className="whitespace-nowrap">{r.dueAt ? fmt(r.dueAt) : '—'}</Td>
          <Td className="tabular-nums">{fmtMinutes(r.elapsed.working)}</Td>
          <Td className="tabular-nums">{fmtMinutes(r.elapsed.calendar)}</Td>
        </tr>
      ))}
    </Table>
  );
}

function Jobs() {
  const jobs = useLoad(() =>
    api<{ items: JobRow[]; counts: Record<string, number> }>('/ops/jobs?status=DEAD'),
  );
  const { busy, error, run } = useAction();
  return (
    <Card
      title={`Failed background jobs (${jobs.data?.items.length ?? 0})`}
      actions={
        jobs.data && (
          <span className="text-xs text-slate-500">
            waiting {jobs.data.counts.PENDING ?? 0} · running {jobs.data.counts.RUNNING ?? 0} · done{' '}
            {jobs.data.counts.DONE ?? 0}
          </span>
        )
      }
    >
      <ErrorText error={error ?? jobs.error} />
      <Table head={['Job', 'Attempts', 'Last error', '']} empty={jobs.data?.items.length === 0}>
        {jobs.data?.items.map((j) => (
          <tr key={j.id}>
            <Td className="font-mono text-xs">{j.type}</Td>
            <Td>
              {j.attempts}/{j.maxAttempts}
            </Td>
            <Td className="text-xs text-red-700">{j.lastError}</Td>
            <Td>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api(`/ops/jobs/${j.id}/retry`, { method: 'POST' });
                    await jobs.reload();
                  })
                }
              >
                Retry
              </Button>
            </Td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}

export default function SlaPage() {
  const { can } = useSession();
  const brands = useLoad(() => api<Brand[]>('/brands'));
  const [brandId, setBrandId] = useState('');
  const data = useLoad(
    () => api<SlaOverview>(`/sla/overview${brandId ? `?brandId=${brandId}` : ''}`),
    [brandId],
  );
  const d = data.data;
  const pct =
    d && d.last30Days.resolved
      ? Math.round((100 * d.last30Days.withinTarget) / d.last30Days.resolved)
      : null;
  const stat = (label: string, value: string | number) => (
    <div className="rounded-md bg-white p-3 ring-1 ring-slate-200">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );

  return (
    <>
      <PageHeader
        title="SLA monitor"
        description="First-response clocks: leads at risk, breached and escalated to the priority queue."
        actions={
          <Select
            aria-label="Brand"
            className="w-56"
            value={brandId}
            onChange={(e) => setBrandId(e.target.value)}
          >
            <option value="">All my brands</option>
            {brands.data?.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        }
      />
      <ErrorText error={data.error} />
      {d && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {stat('On track', d.active.PENDING ?? 0)}
            {stat('At risk', d.active.AT_RISK ?? 0)}
            {stat('Breached', d.active.BREACHED ?? 0)}
            {stat('Paused', d.active.PAUSED ?? 0)}
            {stat('Within target (30 days)', pct === null ? '—' : `${pct}%`)}
            {stat('Avg first response', fmtMinutes(d.last30Days.avgWorkingMinutes))}
          </div>
          <Card title={`Priority queue (${d.priorityQueue.length})`}>
            <Watch rows={d.priorityQueue} />
          </Card>
          <Card title={`At risk and breached (${d.watchList.length})`}>
            <Watch rows={d.watchList} />
          </Card>
          {(can('settings.manage') || can('allocation.manage')) && <Jobs />}
        </div>
      )}
    </>
  );
}
