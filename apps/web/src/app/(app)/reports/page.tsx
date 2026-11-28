'use client';
import Link from 'next/link';
import { useState } from 'react';
import {
  Button,
  Card,
  ErrorText,
  Field,
  Input,
  PageHeader,
  Select,
  Table,
  Td,
  useLoad,
} from '@/components/ui';
import { Disclosure, Funnel, KpiTiles } from '@/components/report-tiles';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { fmtDateTime } from '@/lib/lead-format';
import { BreakdownRow, DrillRow, query, Summary, thisMonth } from '@/lib/reports';
import { useSession } from '@/lib/session';
import type { Brand, Paged, Team, User } from '@/lib/types';

const BY = [
  ['executive', 'Executive'],
  ['course', 'Course'],
  ['source', 'Source'],
  ['campaign', 'Campaign'],
  ['brand', 'Brand'],
] as const;

const money = (xs: Array<{ currency: string; netMinor?: number; minor?: number | null }>) =>
  xs.length
    ? xs.map((x) => formatMoney(x.netMinor ?? x.minor ?? null, x.currency)).join(' · ')
    : '—';

export default function ReportsPage() {
  const { can } = useSession();
  const [f, setF] = useState({
    ...thisMonth(),
    brandId: '',
    teamId: '',
    userId: '',
    campaignId: '',
  });
  const [by, setBy] = useState<(typeof BY)[number][0]>('executive');
  const [drill, setDrill] = useState<{ metric: string; label: string } | null>(null);
  const q = query(f);

  const brands = useLoad(() => (can('brand.read') ? api<Brand[]>('/brands') : Promise.resolve([])));
  const teams = useLoad(() => (can('team.read') ? api<Team[]>('/teams') : Promise.resolve([])));
  const users = useLoad(() =>
    can('user.read')
      ? api<Paged<User>>('/users?pageSize=200').then((p) => p.items)
      : Promise.resolve([] as User[]),
  );
  const campaigns = useLoad(
    () =>
      f.brandId && can('campaign.manage')
        ? api<Array<{ id: string; name: string }>>(`/campaigns?brandId=${f.brandId}`)
        : Promise.resolve([]),
    [f.brandId],
  );
  const summary = useLoad(() => api<Summary>(`/reports/summary?${q}`), [q]);
  const breakdown = useLoad(
    () => api<{ rows: BreakdownRow[] }>(`/reports/breakdown?${q}&by=${by}`),
    [q, by],
  );
  const rows = useLoad(
    () =>
      drill
        ? api<{ rows: DrillRow[] }>(`/reports/drilldown?${q}&metric=${drill.metric}`)
        : Promise.resolve(null),
    [q, drill?.metric],
  );
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF((x) => ({ ...x, [k]: e.target.value, ...(k === 'brandId' ? { campaignId: '' } : {}) }));
  const exportHref = (report: string, extra = '') =>
    `/api/v1/reports/export?${q}&report=${report}${extra}`;
  const showSpend = by === 'campaign' || by === 'source';

  return (
    <>
      <PageHeader
        title="Reports"
        description="Every number is computed from the history records and opens the records behind it."
        actions={
          can('report.export') ? (
            <a
              className="rounded-md bg-white px-3 py-2 text-sm font-medium text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50"
              href={exportHref('summary')}
            >
              Export summary (CSV)
            </a>
          ) : undefined
        }
      />
      <div className="space-y-6">
        <Card title="Filters">
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Field label="From">
              <Input type="date" value={f.from} onChange={set('from')} />
            </Field>
            <Field label="To">
              <Input type="date" value={f.to} onChange={set('to')} />
            </Field>
            <Field label="Brand">
              <Select value={f.brandId} onChange={set('brandId')}>
                <option value="">All my brands</option>
                {brands.data?.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Team">
              <Select value={f.teamId} onChange={set('teamId')}>
                <option value="">All teams</option>
                {teams.data
                  ?.filter((t) => !f.brandId || t.brandId === f.brandId)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label="Executive">
              <Select value={f.userId} onChange={set('userId')}>
                <option value="">Everyone</option>
                {users.data?.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Campaign">
              <Select value={f.campaignId} onChange={set('campaignId')} disabled={!f.brandId}>
                <option value="">{f.brandId ? 'All campaigns' : 'Choose a brand'}</option>
                {campaigns.data?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </Card>

        <ErrorText error={summary.error} />
        {summary.data && (
          <>
            <Disclosure s={summary.data} />
            <KpiTiles
              m={summary.data.metrics}
              onDrill={(metric, label) => setDrill({ metric, label })}
            />
          </>
        )}

        {drill && (
          <Card
            title={`${drill.label} — records`}
            actions={
              <div className="flex gap-2">
                {can('report.export') && (
                  <a
                    className="text-sm text-brand-700 hover:underline"
                    href={exportHref('drilldown', `&metric=${drill.metric}`)}
                  >
                    Export CSV
                  </a>
                )}
                <Button variant="secondary" onClick={() => setDrill(null)}>
                  Close
                </Button>
              </div>
            }
          >
            <ErrorText error={rows.error} />
            <Table
              head={['Lead', 'Name', 'When', 'Executive', 'Amount']}
              empty={!rows.data?.rows.length}
            >
              {rows.data?.rows.map((r) => (
                <tr key={r.id}>
                  <Td>
                    <Link className="text-brand-700 hover:underline" href={`/leads/${r.leadId}`}>
                      {r.leadNumber ?? '—'}
                    </Link>
                  </Td>
                  <Td>{r.name ?? '—'}</Td>
                  <Td>{r.at ? fmtDateTime(r.at) : '—'}</Td>
                  <Td>{r.user ?? '—'}</Td>
                  <Td>{r.currency ? formatMoney(r.amountMinor, r.currency) : '—'}</Td>
                </tr>
              ))}
            </Table>
          </Card>
        )}

        <div className="grid gap-6 lg:grid-cols-[1fr_2fr]">
          <Card title="Funnel (distinct leads entering each stage)">
            {summary.data && <Funnel funnel={summary.data.funnel} />}
          </Card>
          <Card
            title="Breakdown"
            actions={
              <div className="flex items-center gap-2">
                <Select
                  aria-label="Break down by"
                  className="w-36"
                  value={by}
                  onChange={(e) => setBy(e.target.value as typeof by)}
                >
                  {BY.map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </Select>
                {can('report.export') && (
                  <a
                    className="text-sm text-brand-700 hover:underline"
                    href={exportHref('breakdown', `&by=${by}`)}
                  >
                    Export CSV
                  </a>
                )}
              </div>
            }
          >
            <ErrorText error={breakdown.error} />
            <Table
              head={[
                BY.find((b) => b[0] === by)![1],
                'Leads',
                'Assigned',
                'Contacted',
                'Admissions',
                'First-contact',
                'Lost',
                'Overdue',
                'Open (avg age)',
                'Net revenue',
                ...(showSpend ? ['Spend', 'CPL', 'CPA'] : []),
              ]}
              empty={!breakdown.data?.rows.length}
            >
              {breakdown.data?.rows.map((r) => (
                <tr key={r.key}>
                  <Td>{r.label}</Td>
                  <Td className="tabular-nums">{r.leadsCreated}</Td>
                  <Td className="tabular-nums">{r.assigned}</Td>
                  <Td className="tabular-nums">{r.contacted}</Td>
                  <Td className="tabular-nums">
                    {r.admissions.confirmed}
                    {r.admissions.cancelled ? ` (−${r.admissions.cancelled})` : ''}
                  </Td>
                  <Td className="tabular-nums">{r.admissions.firstContact}</Td>
                  <Td className="tabular-nums">{r.lost}</Td>
                  <Td className="tabular-nums">{r.overdueTasks}</Td>
                  <Td className="tabular-nums">
                    {r.openLeads}
                    {r.avgOpenLeadAgeDays != null ? ` (${r.avgOpenLeadAgeDays} d)` : ''}
                  </Td>
                  <Td>{money(r.revenue)}</Td>
                  {showSpend && (
                    <>
                      <Td>
                        {r.spend
                          ? r.spend.map((s) => formatMoney(s.amountMinor, s.currency)).join(' · ')
                          : '—'}
                      </Td>
                      <Td>{r.cpl ? money(r.cpl) : '—'}</Td>
                      <Td>{r.cpa ? money(r.cpa) : '—'}</Td>
                    </>
                  )}
                </tr>
              ))}
            </Table>
            {showSpend && (
              <p className="mt-3 text-xs text-slate-500">
                Ad spend is entered per campaign and month on{' '}
                <Link className="text-brand-700 hover:underline" href="/targets">
                  Targets &amp; spend
                </Link>{' '}
                and counted for every month the period touches.
              </p>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
