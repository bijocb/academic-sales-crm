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
  useAction,
  useLoad,
} from '@/components/ui';
import { api } from '@/lib/api';
import { formatMoney, toMinor } from '@/lib/format';
import { fmtDateTime } from '@/lib/lead-format';
import { thisMonth } from '@/lib/reports';
import { useSession } from '@/lib/session';
import type { Brand } from '@/lib/types';

interface Rule {
  id: string;
  name: string;
  version: number;
  basis: 'PER_ADMISSION' | 'PERCENT_OF_COLLECTIONS';
  amountMinor: number | null;
  percentBp: number | null;
  currency: string;
  thresholdCount: number;
  capMinor: number | null;
  firstContactSharePct: number;
  effectiveFrom: string;
  effectiveTo: string | null;
}
interface Run {
  id: string;
  ruleId: string;
  periodStart: string;
  periodEnd: string;
  status: 'DRAFT' | 'APPROVED';
  totalMinor: number;
  currency: string;
  createdById: string;
  createdAt: string;
  approvedAt: string | null;
  lines?: Array<{
    id: string;
    userId: string;
    userName: string | null;
    kind: 'EARNED' | 'CLAWBACK';
    amountMinor: number;
    inputs: {
      admissions?: number;
      thresholdMet?: boolean;
      capped?: boolean;
      admissionIds?: string[];
    };
  }>;
}

const ruleText = (r: Rule) =>
  `${r.basis === 'PER_ADMISSION' ? `${formatMoney(r.amountMinor, r.currency)} per admission` : `${(r.percentBp ?? 0) / 100}% of collections`}` +
  `${r.thresholdCount ? ` · from ${r.thresholdCount} admissions` : ''}` +
  `${r.capMinor ? ` · cap ${formatMoney(r.capMinor, r.currency)}` : ''}` +
  ` · first contact ${r.firstContactSharePct}% / closing ${100 - r.firstContactSharePct}%`;

export default function IncentivesPage() {
  const { can, me } = useSession();
  const brands = useLoad(() => api<Brand[]>('/brands'));
  const [brandId, setBrandId] = useState('');
  const bid = brandId || brands.data?.[0]?.id || '';
  const rules = useLoad(
    () => (bid ? api<Rule[]>(`/incentive-rules?brandId=${bid}`) : Promise.resolve([])),
    [bid],
  );
  const runs = useLoad(
    () => (bid ? api<Run[]>(`/incentive-runs?brandId=${bid}`) : Promise.resolve([])),
    [bid],
  );
  const [open, setOpen] = useState<string | null>(null);
  const run = useLoad(
    () => (open ? api<Run>(`/incentive-runs/${open}`) : Promise.resolve(null)),
    [open],
  );
  const approve = useAction();
  const ruleName = (id: string) => {
    const r = rules.data?.find((x) => x.id === id);
    return r ? `${r.name} v${r.version}` : '—';
  };

  return (
    <>
      <PageHeader
        title="Incentives"
        description="Versioned rules, previews and approval. Approved runs are locked; later refunds are clawed back in the next run."
        actions={
          <Select
            aria-label="Brand"
            className="w-48"
            value={bid}
            onChange={(e) => {
              setBrandId(e.target.value);
              setOpen(null);
            }}
          >
            {brands.data?.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        }
      />
      <div className="space-y-6">
        <Card title="Rules">
          <ErrorText error={rules.error} />
          <Table head={['Rule', 'Terms', 'Effective']} empty={!rules.data?.length}>
            {rules.data?.map((r) => (
              <tr key={r.id}>
                <Td>
                  {r.name} <Badge>v{r.version}</Badge>
                </Td>
                <Td>{ruleText(r)}</Td>
                <Td className="whitespace-nowrap">
                  {r.effectiveFrom.slice(0, 10)} – {r.effectiveTo?.slice(0, 10) ?? 'open'}
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
        {can('target.manage') && bid && (
          <div className="grid gap-6 lg:grid-cols-2">
            <NewRule brandId={bid} onSaved={rules.reload} />
            <NewRun
              rules={rules.data ?? []}
              onSaved={async (id) => {
                await runs.reload();
                setOpen(id);
              }}
            />
          </div>
        )}
        <Card title="Runs">
          <ErrorText error={runs.error} />
          <Table head={['Period', 'Rule', 'Status', 'Total', '']} empty={!runs.data?.length}>
            {runs.data?.map((r) => (
              <tr key={r.id}>
                <Td className="whitespace-nowrap">
                  {r.periodStart.slice(0, 10)} – {r.periodEnd.slice(0, 10)}
                </Td>
                <Td>{ruleName(r.ruleId)}</Td>
                <Td>
                  <Badge tone={r.status === 'APPROVED' ? 'green' : 'amber'}>{r.status}</Badge>
                </Td>
                <Td className="tabular-nums">{formatMoney(r.totalMinor, r.currency)}</Td>
                <Td>
                  <Button variant="secondary" onClick={() => setOpen(r.id)}>
                    View
                  </Button>
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
        {run.data && (
          <Card
            title={`Run ${run.data.periodStart.slice(0, 10)} – ${run.data.periodEnd.slice(0, 10)}`}
            actions={
              run.data.status === 'DRAFT' &&
              can('target.manage') &&
              run.data.createdById !== me.user.id ? (
                <Button
                  disabled={approve.busy}
                  onClick={() =>
                    void approve.run(async () => {
                      await api(`/incentive-runs/${run.data!.id}/approve`, { method: 'POST' });
                      await run.reload();
                      await runs.reload();
                    })
                  }
                >
                  Approve and lock
                </Button>
              ) : run.data.status === 'DRAFT' ? (
                <span className="text-xs text-slate-500">
                  Needs approval by someone other than its creator
                </span>
              ) : (
                <span className="text-xs text-slate-500">
                  Approved {run.data.approvedAt ? fmtDateTime(run.data.approvedAt) : ''}
                </span>
              )
            }
          >
            <ErrorText error={approve.error} />
            <Table
              head={['Person', 'Kind', 'Admissions', 'Notes', 'Amount']}
              empty={!run.data.lines?.length}
            >
              {run.data.lines?.map((l) => (
                <tr key={l.id}>
                  <Td>{l.userName ?? l.userId}</Td>
                  <Td>
                    <Badge tone={l.kind === 'CLAWBACK' ? 'red' : 'slate'}>{l.kind}</Badge>
                  </Td>
                  <Td className="tabular-nums">
                    {l.kind === 'CLAWBACK'
                      ? (l.inputs.admissionIds?.length ?? 0)
                      : (l.inputs.admissions ?? '—')}
                  </Td>
                  <Td className="text-xs text-slate-500">
                    {l.kind === 'CLAWBACK'
                      ? 'Admission fully refunded'
                      : [
                          l.inputs.thresholdMet === false ? 'below threshold' : '',
                          l.inputs.capped ? 'capped' : '',
                        ]
                          .filter(Boolean)
                          .join(' · ') || '—'}
                  </Td>
                  <Td className="tabular-nums">{formatMoney(l.amountMinor, run.data!.currency)}</Td>
                </tr>
              ))}
            </Table>
          </Card>
        )}
      </div>
    </>
  );
}

function NewRule({ brandId, onSaved }: { brandId: string; onSaved: () => void }) {
  const [v, setV] = useState({
    name: '',
    basis: 'PER_ADMISSION',
    amount: '',
    percent: '',
    thresholdCount: '0',
    cap: '',
    firstContactSharePct: '50',
    effectiveFrom: thisMonth().from,
  });
  const { busy, error, run } = useAction();
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) =>
    setV((x) => ({ ...x, [k]: e.target.value }));
  return (
    <Card title="New rule or new version">
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api('/incentive-rules', {
              method: 'POST',
              body: {
                brandId,
                name: v.name,
                basis: v.basis,
                ...(v.basis === 'PER_ADMISSION'
                  ? { amountMinor: toMinor(v.amount) }
                  : { percentBp: Math.round(Number(v.percent) * 100) }),
                thresholdCount: Number(v.thresholdCount || 0),
                ...(v.cap ? { capMinor: toMinor(v.cap) } : {}),
                firstContactSharePct: Number(v.firstContactSharePct),
                effectiveFrom: v.effectiveFrom,
              },
            });
            onSaved();
          });
        }}
      >
        <Field label="Name" hint="Saving an existing name creates its next version">
          <Input value={v.name} onChange={set('name')} required />
        </Field>
        <Field label="Basis">
          <Select value={v.basis} onChange={set('basis')}>
            <option value="PER_ADMISSION">Amount per confirmed admission</option>
            <option value="PERCENT_OF_COLLECTIONS">Percent of net collections</option>
          </Select>
        </Field>
        {v.basis === 'PER_ADMISSION' ? (
          <Field label="Amount per admission">
            <Input inputMode="decimal" value={v.amount} onChange={set('amount')} required />
          </Field>
        ) : (
          <Field label="Percent">
            <Input inputMode="decimal" value={v.percent} onChange={set('percent')} required />
          </Field>
        )}
        <Field label="Minimum admissions (threshold)">
          <Input inputMode="numeric" value={v.thresholdCount} onChange={set('thresholdCount')} />
        </Field>
        <Field label="Cap per person (optional)">
          <Input inputMode="decimal" value={v.cap} onChange={set('cap')} />
        </Field>
        <Field label="First-contact share %" hint="The closing executive gets the rest">
          <Input
            inputMode="numeric"
            value={v.firstContactSharePct}
            onChange={set('firstContactSharePct')}
          />
        </Field>
        <Field label="Effective from">
          <Input type="date" value={v.effectiveFrom} onChange={set('effectiveFrom')} required />
        </Field>
        <div className="flex items-end">
          <Button disabled={busy}>Save rule</Button>
        </div>
        <div className="sm:col-span-2">
          <ErrorText error={error} />
        </div>
      </form>
    </Card>
  );
}

function NewRun({ rules, onSaved }: { rules: Rule[]; onSaved: (id: string) => void }) {
  const m = thisMonth();
  const [v, setV] = useState({ ruleId: '', periodStart: m.from, periodEnd: m.to });
  const { busy, error, run } = useAction();
  return (
    <Card title="Preview a run">
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const r = await api<Run>('/incentive-runs', { method: 'POST', body: v });
            onSaved(r.id);
          });
        }}
      >
        <Field label="Rule version">
          <Select
            aria-label="Rule version"
            value={v.ruleId}
            onChange={(e) => setV((x) => ({ ...x, ruleId: e.target.value }))}
            required
          >
            <option value="">Choose…</option>
            {rules.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} v{r.version}
              </option>
            ))}
          </Select>
        </Field>
        <span />
        <Field label="From">
          <Input
            type="date"
            value={v.periodStart}
            onChange={(e) => setV((x) => ({ ...x, periodStart: e.target.value }))}
          />
        </Field>
        <Field label="To">
          <Input
            type="date"
            value={v.periodEnd}
            onChange={(e) => setV((x) => ({ ...x, periodEnd: e.target.value }))}
          />
        </Field>
        <div>
          <Button disabled={busy}>Preview</Button>
        </div>
        <div className="sm:col-span-2">
          <ErrorText error={error} />
        </div>
      </form>
    </Card>
  );
}
