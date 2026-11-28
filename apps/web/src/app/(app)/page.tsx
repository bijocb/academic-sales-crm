'use client';
import Link from 'next/link';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Card, ErrorText, PageHeader, Table, Td, useLoad } from '@/components/ui';
import { Disclosure, KpiTiles, TargetProgress } from '@/components/report-tiles';
import { api } from '@/lib/api';
import { Summary, TARGET_LABEL, TargetRow, thisMonth } from '@/lib/reports';
import { useSession } from '@/lib/session';
import type { Brand, Paged, Team, User } from '@/lib/types';

/** Home: my numbers and targets for this month (own scope, FR-017 "My dashboard"). */
export default function DashboardPage() {
  const { me, can } = useSession();
  const router = useRouter();
  useEffect(() => {
    if (me.user.isPlatformAdmin) router.replace('/platform');
  }, [me, router]);
  const month = thisMonth();
  const sales = !me.user.isPlatformAdmin && (can('lead.read') || can('lead.read_own'));

  const mine = useLoad(
    () =>
      sales
        ? api<Summary>(`/reports/summary?from=${month.from}&to=${month.to}&mine=true`)
        : Promise.resolve(null),
    [me.user.id],
  );
  const targets = useLoad(
    () =>
      sales
        ? api<TargetRow[]>(`/targets?periodStart=${month.from}&periodEnd=${month.to}`).then((ts) =>
            ts.filter((t) => t.userId === me.user.id),
          )
        : Promise.resolve([]),
    [me.user.id],
  );
  const { data } = useLoad(async () => {
    if (me.user.isPlatformAdmin) return null;
    const [brands, teams, users] = await Promise.all([
      can('brand.read') ? api<Brand[]>('/brands') : Promise.resolve([]),
      can('team.read') ? api<Team[]>('/teams') : Promise.resolve([]),
      can('user.read')
        ? api<Paged<User>>('/users?pageSize=1')
        : Promise.resolve({ total: 0 } as Paged<User>),
    ]);
    return { brands: brands.length, teams: teams.length, users: users.total };
  }, [me.user.id]);

  if (me.user.isPlatformAdmin) return null;
  return (
    <>
      <PageHeader
        title={`Welcome, ${me.user.name}`}
        description={`${me.organization?.name} · ${me.organization?.timezone} · ${me.organization?.currency}`}
        actions={
          can('report.read') ? (
            <Link className="text-sm font-medium text-brand-700 hover:underline" href="/reports">
              Open reports →
            </Link>
          ) : undefined
        }
      />
      <div className="space-y-6">
        {sales && (
          <section aria-label="My numbers this month" className="space-y-3">
            <h2 className="text-sm font-semibold text-slate-800">My numbers this month</h2>
            <ErrorText error={mine.error} />
            {mine.data && (
              <>
                <KpiTiles m={mine.data.metrics} />
                <Disclosure s={mine.data} />
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
        <div className="grid gap-4 sm:grid-cols-3">
          {[
            ['Brands', data?.brands],
            ['Teams', data?.teams],
            ['Users', data?.users],
          ].map(([label, value]) => (
            <Card key={label as string}>
              <p className="text-sm text-slate-500">{label}</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">{value ?? '—'}</p>
            </Card>
          ))}
        </div>
      </div>
    </>
  );
}
