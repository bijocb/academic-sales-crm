'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Card, PageHeader, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { Brand, Paged, Team, User } from '@/lib/types';

export default function DashboardPage() {
  const { me, can } = useSession();
  const router = useRouter();
  useEffect(() => {
    if (me.user.isPlatformAdmin) router.replace('/platform');
  }, [me, router]);

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
      />
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
      <p className="mt-6 text-sm text-slate-500">
        Leads, allocation, tasks and SLA tracking arrive in the next phases. Counts reflect only
        what you are permitted to see.
      </p>
    </>
  );
}
