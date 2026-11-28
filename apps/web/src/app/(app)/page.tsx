'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, ErrorText, PageHeader, Table, Td, useLoad } from '@/components/ui';
import { TargetProgress } from '@/components/report-tiles';
import {
  PerfTiles,
  PeriodKey,
  PeriodPicker,
  periodRange,
  PersonalFunnel,
  TeamAverage,
  TrendCharts,
  TrendPoint,
} from '@/components/performance';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { BreakdownRow, Metrics, TARGET_LABEL, TargetRow } from '@/lib/reports';
import { useSession } from '@/lib/session';

interface MyReport {
  from: string;
  to: string;
  timezone: string;
  previousPeriod: { from: string; to: string };
  current: Metrics;
  previous: Metrics;
  trend: TrendPoint[];
  funnel: Array<{ step: string; leads: number }>;
  teamAverage: TeamAverage | null;
}

/** Home: the signed-in user's performance report (D-008), their targets, and — for managers — their team. */
export default function DashboardPage() {
  const { me, can } = useSession();
  const router = useRouter();
  useEffect(() => {
    if (me.user.isPlatformAdmin) router.replace('/platform');
  }, [me, router]);
  const [period, setPeriod] = useState<PeriodKey>('month');
  const [custom, setCustom] = useState(periodRange('month', { from: '', to: '' }));
  const range = periodRange(period, custom);
  const q = `from=${range.from}&to=${range.to}`;
  const sales = !me.user.isPlatformAdmin && (can('lead.read') || can('lead.read_own'));
  const manager = !me.user.isPlatformAdmin && can('report.read');

  const report = useLoad(
    () =>
      sales && range.from && range.to && range.to >= range.from
        ? api<MyReport>(`/reports/me?${q}`)
        : Promise.resolve(null),
    [me.user.id, q],
  );
  const team = useLoad(
    () =>
      manager
        ? api<{ rows: BreakdownRow[] }>(`/reports/breakdown?${q}&by=executive`)
        : Promise.resolve(null),
    [me.user.id, q],
  );
  const targets = useLoad(
    () =>
      sales
        ? api<TargetRow[]>(`/targets?periodStart=${range.from}&periodEnd=${range.to}`).then((ts) =>
            ts.filter((t) => t.userId === me.user.id),
          )
        : Promise.resolve([]),
    [me.user.id, q],
  );

  if (me.user.isPlatformAdmin) return null;
  const r = report.data;
  const ta = r?.teamAverage;
  return (
    <>
      <PageHeader
        title={`Welcome, ${me.user.name}`}
        description={`${me.organization?.name} · ${me.organization?.timezone} · ${me.organization?.currency}`}
        actions={
          <div className="flex items-center gap-3">
            <PeriodPicker
              value={period}
              onChange={setPeriod}
              custom={custom}
              onCustom={setCustom}
            />
            {manager && (
              <Link className="text-sm font-medium text-brand-700 hover:underline" href="/reports">
                Open reports →
              </Link>
            )}
          </div>
        }
      />
      <div className="space-y-6">
        {sales && (
          <section aria-label="My performance" className="space-y-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold text-slate-800">My performance</h2>
              {r && (
                <p className="text-xs text-slate-500">
                  {r.from} to {r.to} ({r.timezone}) · compared with {r.previousPeriod.from} to{' '}
                  {r.previousPeriod.to}
                  {ta && !ta.hidden ? ` · team average across ${ta.members} people` : ''}
                  {ta?.hidden ? ' · team average not shown for teams under 3 people' : ''}
                </p>
              )}
            </div>
            <ErrorText error={report.error} />
            {r && (
              <>
                <PerfTiles m={r.current} prev={r.previous} team={ta ?? null} />
                <Card title="Daily trend">
                  <TrendCharts data={r.trend} />
                </Card>
                <div className="grid gap-6 lg:grid-cols-2">
                  <Card title="My funnel (each step counted in this period)">
                    <PersonalFunnel steps={r.funnel} />
                  </Card>
                  <Card title="Response and workload">
                    <dl className="grid grid-cols-2 gap-3 text-sm">
                      <dt className="text-slate-500">First responses on time</dt>
                      <dd className="tabular-nums">
                        {r.current.firstResponse.withinTarget} of {r.current.firstResponse.started}
                        {r.current.firstResponse.breached
                          ? ` (${r.current.firstResponse.breached} breached)`
                          : ''}
                      </dd>
                      <dt className="text-slate-500">Average first response</dt>
                      <dd className="tabular-nums">
                        {r.current.firstResponse.avgWorkingMinutes ?? '—'} working min
                        {ta && !ta.hidden && ta.avgWorkingMinutes != null
                          ? ` (team ${ta.avgWorkingMinutes})`
                          : ''}
                      </dd>
                      <dt className="text-slate-500">Open leads (now)</dt>
                      <dd className="tabular-nums">{r.current.openLeads}</dd>
                      <dt className="text-slate-500">Open tasks (now)</dt>
                      <dd className="tabular-nums">
                        {r.current.openTasks} ({r.current.overdueTasks} overdue)
                      </dd>
                      <dt className="text-slate-500">Recovered leads</dt>
                      <dd className="tabular-nums">{r.current.recovered}</dd>
                      <dt className="text-slate-500">Quotations accepted</dt>
                      <dd className="tabular-nums">{r.current.quotationsAccepted}</dd>
                    </dl>
                  </Card>
                </div>
              </>
            )}
          </section>
        )}
        {sales && (targets.data?.length ?? 0) > 0 && (
          <Card title="My targets">
            <Table head={['Metric', 'Period', 'Progress']}>
              {targets.data!.map((t) => (
                <tr key={t.id}>
                  <Td>{TARGET_LABEL[t.metric]}</Td>
                  <Td className="whitespace-nowrap">
                    {t.periodStart.slice(0, 10)} – {t.periodEnd.slice(0, 10)}
                  </Td>
                  <Td>
                    <TargetProgress t={t} />
                  </Td>
                </tr>
              ))}
            </Table>
          </Card>
        )}
        {manager && (
          <Card title="My team's performance">
            <ErrorText error={team.error} />
            <Table
              head={[
                'Executive',
                'Assigned',
                'Contacted',
                'First response on time',
                'Admissions',
                'First-contact',
                'Lost',
                'Overdue',
                'Net revenue',
              ]}
              empty={!team.data?.rows.length}
            >
              {team.data?.rows.map((x) => (
                <tr key={x.key}>
                  <Td>{x.label}</Td>
                  <Td className="tabular-nums">{x.assigned}</Td>
                  <Td className="tabular-nums">{x.contacted}</Td>
                  <Td className="tabular-nums">
                    {x.firstResponse.started
                      ? `${x.firstResponse.withinTarget} / ${x.firstResponse.started}`
                      : '—'}
                  </Td>
                  <Td className="tabular-nums">
                    {x.admissions.confirmed}
                    {x.admissions.cancelled ? ` (−${x.admissions.cancelled})` : ''}
                  </Td>
                  <Td className="tabular-nums">{x.admissions.firstContact}</Td>
                  <Td className="tabular-nums">{x.lost}</Td>
                  <Td className="tabular-nums">{x.overdueTasks}</Td>
                  <Td>
                    {x.revenue.length
                      ? x.revenue.map((v) => formatMoney(v.netMinor, v.currency)).join(' · ')
                      : '—'}
                  </Td>
                </tr>
              ))}
            </Table>
          </Card>
        )}
        {!sales && !manager && (
          <p className="text-sm text-slate-500">
            Your role has no sales numbers. Use the menu for your work.
          </p>
        )}
      </div>
    </>
  );
}
