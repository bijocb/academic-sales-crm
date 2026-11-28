'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
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
import { formatMoney } from '@/lib/format';
import { fmtDateTime as fmt } from '@/lib/lead-format';
import { useSession } from '@/lib/session';
import type { Brand } from '@/lib/types';

interface RefundRow {
  id: string;
  leadId?: string;
  student: string | null;
  admissionNumber: string | null;
  amountMinor: number;
  currency: string;
  reason: string;
  status: string;
  requestedAt: string;
}
interface Recon {
  mismatched: Array<{ id: string; providerOrderId: string; mismatch: string }>;
  disputed: Array<{ id: string; providerOrderId: string }>;
  stalePending: Array<{ id: string; providerOrderId: string; createdAt: string }>;
  succeededWithoutPayment: string[];
}
interface Settings {
  receiptNumberFormat: string;
  minConfirmAmountMinor: number;
  defaultDueDays: number;
  refundMakerChecker: boolean;
}

export default function FinancePage() {
  const { can } = useSession();
  const [status, setStatus] = useState('REQUESTED');
  const refunds = useLoad(() => api<RefundRow[]>(`/finance/refunds?status=${status}`), [status]);
  const recon = useLoad(() =>
    can('payment.read') ? api<Recon>('/finance/reconciliation') : Promise.resolve(null),
  );
  const brands = useLoad(() => api<Brand[]>('/brands'));
  const [brandId, setBrandId] = useState('');
  const bid = brandId || brands.data?.[0]?.id || '';
  return (
    <>
      <PageHeader
        title="Finance"
        description="Refund approvals, gateway reconciliation and receipt settings. Payments are recorded on each admission."
      />
      <div className="space-y-6">
        <Card
          title="Refunds"
          actions={
            <Select
              aria-label="Refund status"
              className="w-40"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="REQUESTED">To approve</option>
              <option value="APPROVED">To pay out</option>
              <option value="PAID">Paid</option>
              <option value="REJECTED">Rejected</option>
            </Select>
          }
        >
          <ErrorText error={refunds.error} />
          <Table
            head={['Student', 'Amount', 'Reason', 'Requested', 'Status']}
            empty={refunds.data?.length === 0}
          >
            {refunds.data?.map((r) => (
              <tr key={r.id}>
                <Td>
                  {r.leadId ? (
                    <Link
                      href={`/leads/${r.leadId}`}
                      className="font-medium text-brand-700 hover:underline"
                    >
                      {r.student}
                    </Link>
                  ) : (
                    r.student
                  )}{' '}
                  <span className="font-mono text-xs text-slate-500">{r.admissionNumber}</span>
                </Td>
                <Td className="tabular-nums">{formatMoney(r.amountMinor, r.currency)}</Td>
                <Td>{r.reason}</Td>
                <Td className="whitespace-nowrap">{fmt(r.requestedAt)}</Td>
                <Td>
                  <Badge
                    tone={r.status === 'PAID' ? 'green' : r.status === 'REJECTED' ? 'red' : 'amber'}
                  >
                    {r.status.toLowerCase()}
                  </Badge>
                </Td>
              </tr>
            ))}
          </Table>
          <p className="mt-2 text-xs text-slate-500">
            Approve, reject and mark refunds paid on the student&apos;s admission (lead page).
          </p>
        </Card>
        {recon.data && (
          <Card title="Gateway reconciliation">
            <ul className="space-y-1 text-sm">
              <li>Amount mismatches (not recorded as paid): {recon.data.mismatched.length}</li>
              {recon.data.mismatched.map((x) => (
                <li key={x.id} className="pl-4 text-xs text-red-700">
                  {x.providerOrderId}: {x.mismatch}
                </li>
              ))}
              <li>Disputed payments: {recon.data.disputed.length}</li>
              <li>Pending for more than an hour: {recon.data.stalePending.length}</li>
              <li>
                Gateway successes without a payment record:{' '}
                {recon.data.succeededWithoutPayment.length}
              </li>
            </ul>
          </Card>
        )}
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
            <SettingsCard brandId={bid} />
          </>
        )}
      </div>
    </>
  );
}

function SettingsCard({ brandId }: { brandId: string }) {
  const s = useLoad(() => api<Settings>(`/finance-settings?brandId=${brandId}`), [brandId]);
  const [f, setF] = useState<Settings | null>(null);
  const { busy, error, run } = useAction();
  useEffect(() => {
    if (s.data) setF(s.data);
  }, [s.data]);
  if (!f) return <ErrorText error={s.error} />;
  return (
    <Card title="Receipts and confirmation">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api(`/finance-settings?brandId=${brandId}`, {
              method: 'PUT',
              body: {
                receiptNumberFormat: f.receiptNumberFormat,
                minConfirmAmountMinor: f.minConfirmAmountMinor,
                defaultDueDays: f.defaultDueDays,
                refundMakerChecker: f.refundMakerChecker,
              },
            });
            await s.reload();
          });
        }}
      >
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-72">
            <Field label="Receipt number format">
              <Input
                value={f.receiptNumberFormat}
                onChange={(e) => setF({ ...f, receiptNumberFormat: e.target.value })}
              />
            </Field>
          </div>
          <div className="w-56">
            <Field label="Minimum payment that confirms (minor units)">
              <Input
                type="number"
                min={1}
                value={f.minConfirmAmountMinor}
                onChange={(e) => setF({ ...f, minConfirmAmountMinor: Number(e.target.value) })}
              />
            </Field>
          </div>
          <div className="w-40">
            <Field label="First instalment due (days)">
              <Input
                type="number"
                min={0}
                value={f.defaultDueDays}
                onChange={(e) => setF({ ...f, defaultDueDays: Number(e.target.value) })}
              />
            </Field>
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={f.refundMakerChecker}
            onChange={(e) => setF({ ...f, refundMakerChecker: e.target.checked })}
          />
          Refunds must be approved by someone other than the requester
        </label>
        <p className="text-xs text-slate-500">
          Receipts are payment receipts, not tax invoices (GST/VAT invoicing is open: O-09).
        </p>
        <ErrorText error={error} />
        <Button type="submit" disabled={busy}>
          Save
        </Button>
      </form>
    </Card>
  );
}
