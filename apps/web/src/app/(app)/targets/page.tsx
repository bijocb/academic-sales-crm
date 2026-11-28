'use client';
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
  useAction,
  useLoad,
} from '@/components/ui';
import { api } from '@/lib/api';
import { formatMoney, toMinor } from '@/lib/format';
import { TARGET_LABEL, TargetRow, thisMonth } from '@/lib/reports';
import { TargetProgress as Progress } from '@/components/report-tiles';
import { useSession } from '@/lib/session';
import type { Brand, Paged, Team, User } from '@/lib/types';

const MONEY = ['REVENUE', 'COLLECTIONS'];

export default function TargetsPage() {
  const { can } = useSession();
  const month = thisMonth();
  const [period, setPeriod] = useState(month);
  const brands = useLoad(() => (can('brand.read') ? api<Brand[]>('/brands') : Promise.resolve([])));
  const teams = useLoad(() => (can('team.read') ? api<Team[]>('/teams') : Promise.resolve([])));
  const users = useLoad(() =>
    can('user.read')
      ? api<Paged<User>>('/users?pageSize=200').then((p) => p.items)
      : Promise.resolve([] as User[]),
  );
  const list = useLoad(
    () => api<TargetRow[]>(`/targets?periodStart=${period.from}&periodEnd=${period.to}`),
    [period.from, period.to],
  );
  const name = (t: TargetRow) =>
    t.scope === 'USER'
      ? (users.data?.find((u) => u.id === t.userId)?.name ?? 'Person')
      : t.scope === 'TEAM'
        ? (teams.data?.find((x) => x.id === t.teamId)?.name ?? 'Team')
        : t.scope === 'BRAND'
          ? (brands.data?.find((b) => b.id === t.brandId)?.name ?? 'Brand')
          : 'Organization';

  return (
    <>
      <PageHeader
        title="Targets & ad spend"
        description="Progress is computed with the same KPI rules as the reports."
      />
      <div className="space-y-6">
        <Card
          title="Targets"
          actions={
            <div className="flex items-center gap-2">
              <Input
                aria-label="Period from"
                type="date"
                value={period.from}
                onChange={(e) => setPeriod((p) => ({ ...p, from: e.target.value }))}
              />
              <Input
                aria-label="Period to"
                type="date"
                value={period.to}
                onChange={(e) => setPeriod((p) => ({ ...p, to: e.target.value }))}
              />
            </div>
          }
        >
          <ErrorText error={list.error} />
          <Table head={['For', 'Metric', 'Period', 'Progress', '']} empty={!list.data?.length}>
            {list.data?.map((t) => (
              <TargetLine key={t.id} t={t} who={name(t)} onSaved={list.reload} />
            ))}
          </Table>
        </Card>
        {can('target.manage') && (
          <NewTarget
            brands={brands.data ?? []}
            teams={teams.data ?? []}
            users={users.data ?? []}
            defaults={month}
            onSaved={list.reload}
          />
        )}
        {can('campaign.manage') && <AdSpend brands={brands.data ?? []} />}
      </div>
    </>
  );
}

function TargetLine({ t, who, onSaved }: { t: TargetRow; who: string; onSaved: () => void }) {
  const { can } = useSession();
  const [edit, setEdit] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const money = MONEY.includes(t.metric);
  return (
    <tr>
      <Td>{who}</Td>
      <Td>
        {TARGET_LABEL[t.metric]}
        {t.currency ? ` (${t.currency})` : ''}
      </Td>
      <Td className="whitespace-nowrap">
        {t.periodStart.slice(0, 10)} – {t.periodEnd.slice(0, 10)}
      </Td>
      <Td>
        <Progress t={t} />
      </Td>
      <Td>
        {can('target.manage') &&
          (edit === null ? (
            <Button
              variant="secondary"
              onClick={() => setEdit(String(money ? t.value / 100 : t.value))}
            >
              Change
            </Button>
          ) : (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  const value = money ? toMinor(edit) : Number(edit);
                  await api(`/targets/${t.id}`, { method: 'PATCH', body: { value } });
                  setEdit(null);
                  onSaved();
                });
              }}
            >
              <Input
                aria-label="New target value"
                className="w-28"
                value={edit}
                onChange={(e) => setEdit(e.target.value)}
              />
              <Button disabled={busy}>Save</Button>
              <ErrorText error={error} />
            </form>
          ))}
      </Td>
    </tr>
  );
}

function NewTarget({
  brands,
  teams,
  users,
  defaults,
  onSaved,
}: {
  brands: Brand[];
  teams: Team[];
  users: User[];
  defaults: { from: string; to: string };
  onSaved: () => void;
}) {
  const [v, setV] = useState({
    scope: 'USER',
    brandId: '',
    teamId: '',
    userId: '',
    metric: 'ADMISSIONS',
    periodStart: defaults.from,
    periodEnd: defaults.to,
    value: '',
    currency: 'INR',
  });
  const { busy, error, run } = useAction();
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) =>
    setV((x) => ({ ...x, [k]: e.target.value }));
  const money = MONEY.includes(v.metric);
  return (
    <Card title="New target">
      <form
        className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api('/targets', {
              method: 'POST',
              body: {
                scope: v.scope,
                ...(v.brandId ? { brandId: v.brandId } : {}),
                ...(v.scope === 'TEAM' ? { teamId: v.teamId } : {}),
                ...(v.scope === 'USER' ? { userId: v.userId } : {}),
                metric: v.metric,
                periodStart: v.periodStart,
                periodEnd: v.periodEnd,
                value: money ? toMinor(v.value) : Number(v.value),
                ...(money ? { currency: v.currency } : {}),
              },
            });
            setV((x) => ({ ...x, value: '' }));
            onSaved();
          });
        }}
      >
        <Field label="For">
          <Select aria-label="Target for" value={v.scope} onChange={set('scope')}>
            <option value="USER">A person</option>
            <option value="TEAM">A team</option>
            <option value="BRAND">A brand</option>
            <option value="ORGANIZATION">The organization</option>
          </Select>
        </Field>
        {(v.scope === 'BRAND' || v.scope === 'USER') && (
          <Field label="Brand">
            <Select
              aria-label="Target brand"
              value={v.brandId}
              onChange={set('brandId')}
              required={v.scope === 'BRAND'}
            >
              <option value="">{v.scope === 'USER' ? 'All brands' : 'Choose…'}</option>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {v.scope === 'TEAM' && (
          <Field label="Team">
            <Select value={v.teamId} onChange={set('teamId')} required>
              <option value="">Choose…</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {v.scope === 'USER' && (
          <Field label="Person">
            <Select value={v.userId} onChange={set('userId')} required>
              <option value="">Choose…</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Metric">
          <Select aria-label="Target metric" value={v.metric} onChange={set('metric')}>
            {Object.entries(TARGET_LABEL).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
        {money && (
          <Field label="Currency">
            <Select value={v.currency} onChange={set('currency')}>
              <option>INR</option>
              <option>AED</option>
            </Select>
          </Field>
        )}
        <Field label="From">
          <Input type="date" value={v.periodStart} onChange={set('periodStart')} required />
        </Field>
        <Field label="To">
          <Input type="date" value={v.periodEnd} onChange={set('periodEnd')} required />
        </Field>
        <Field label={money ? 'Target amount' : 'Target count'}>
          <Input
            inputMode="decimal"
            value={v.value}
            onChange={set('value')}
            required
            placeholder={money ? '500000.00' : '10'}
          />
        </Field>
        <div className="flex items-end">
          <Button disabled={busy}>Add target</Button>
        </div>
        <div className="sm:col-span-3 lg:col-span-4">
          <ErrorText error={error} />
        </div>
      </form>
    </Card>
  );
}

function AdSpend({ brands }: { brands: Brand[] }) {
  const [brandId, setBrandId] = useState('');
  const bid = brandId || brands[0]?.id || '';
  const brand = brands.find((b) => b.id === bid);
  const campaigns = useLoad(
    () =>
      bid
        ? api<Array<{ id: string; name: string }>>(`/campaigns?brandId=${bid}`)
        : Promise.resolve([]),
    [bid],
  );
  const rows = useLoad(
    () =>
      bid
        ? api<
            Array<{
              id: string;
              campaignId: string;
              month: string;
              amountMinor: number;
              currency: string;
            }>
          >(`/ad-spend?brandId=${bid}`)
        : Promise.resolve([]),
    [bid],
  );
  const [v, setV] = useState({ campaignId: '', month: thisMonth().from.slice(0, 7), amount: '' });
  const { busy, error, run } = useAction();
  return (
    <Card
      title="Ad spend (entered manually per campaign and month)"
      actions={
        <Select
          aria-label="Brand"
          className="w-48"
          value={bid}
          onChange={(e) => setBrandId(e.target.value)}
        >
          {brands.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </Select>
      }
    >
      <form
        className="mb-4 grid gap-3 sm:grid-cols-4"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api('/ad-spend', {
              method: 'POST',
              body: { campaignId: v.campaignId, month: v.month, amountMinor: toMinor(v.amount) },
            });
            setV((x) => ({ ...x, amount: '' }));
            await rows.reload();
          });
        }}
      >
        <Field label="Campaign">
          <Select
            value={v.campaignId}
            onChange={(e) => setV((x) => ({ ...x, campaignId: e.target.value }))}
            required
          >
            <option value="">Choose…</option>
            {campaigns.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Month">
          <Input
            type="month"
            value={v.month}
            onChange={(e) => setV((x) => ({ ...x, month: e.target.value }))}
            required
          />
        </Field>
        <Field label={`Amount (${brand?.currency ?? ''})`}>
          <Input
            inputMode="decimal"
            value={v.amount}
            onChange={(e) => setV((x) => ({ ...x, amount: e.target.value }))}
            required
          />
        </Field>
        <div className="flex items-end">
          <Button disabled={busy}>Save spend</Button>
        </div>
        <div className="sm:col-span-4">
          <ErrorText error={error} />
        </div>
      </form>
      <Table head={['Month', 'Campaign', 'Spend']} empty={!rows.data?.length}>
        {rows.data?.map((r) => (
          <tr key={r.id}>
            <Td>{r.month.slice(0, 7)}</Td>
            <Td>{campaigns.data?.find((c) => c.id === r.campaignId)?.name ?? r.campaignId}</Td>
            <Td className="tabular-nums">{formatMoney(r.amountMinor, r.currency)}</Td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}
