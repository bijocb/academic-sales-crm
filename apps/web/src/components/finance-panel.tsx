'use client';
import { useState } from 'react';
import {
  Badge,
  Button,
  ErrorText,
  Field,
  Input,
  Select,
  useAction,
  useLoad,
} from '@/components/ui';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { fmtDateTime as fmt } from '@/lib/lead-format';
import { toLocalInput, localInputToIso } from '@/lib/task-format';

interface Instalment {
  id: string;
  seq: number;
  dueDate: string;
  amountMinor: number;
  paidMinor: number;
  dueMinor: number;
  overdue: boolean;
}
interface PaymentRow {
  id: string;
  amountMinor: number;
  currency: string;
  method: string;
  reference: string | null;
  receiptNumber: string;
  verification: string;
  receivedAt: string;
}
interface RefundRow {
  id: string;
  paymentId: string;
  amountMinor: number;
  currency: string;
  reason: string;
  status: string;
}
interface Attempt {
  id: string;
  amountMinor: number;
  currency: string;
  status: string;
  checkoutUrl: string | null;
  mismatch: string | null;
  createdAt: string;
}
interface Finance {
  plan: { id: string; currency: string; baseAmountMinor: number };
  admissionStatus: string;
  netFee: number;
  paid: number;
  refundedPaid: number;
  netCollected: number;
  outstanding: number;
  overdueMinor: number;
  schedule: Instalment[];
  payments: PaymentRow[];
  refunds: RefundRow[];
  attempts: Attempt[];
  gateway: string | null;
  can: { work: boolean; record: boolean; requestRefund: boolean; approveRefund: boolean };
}

const METHODS = [
  ['BANK_TRANSFER', 'Bank transfer'],
  ['UPI', 'UPI'],
  ['CASH', 'Cash'],
  ['CHEQUE', 'Cheque'],
  ['CARD_MACHINE', 'Card machine'],
] as const;
const toMinor = (v: string) => Math.round(Number(v) * 100);

/** Fees, payments and refunds for one admission (FR-015). */
export function FinancePanel({
  admissionId,
  onChanged,
}: {
  admissionId: string;
  onChanged: () => void;
}) {
  const fin = useLoad(() => api<Finance>(`/admissions/${admissionId}/finance`), [admissionId]);
  const [mode, setMode] = useState<'pay' | 'plan' | 'adjust' | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const f = fin.data;
  if (!f) return <ErrorText error={fin.error} />;
  const cur = f.plan.currency;
  const m = (x: number) => formatMoney(x, cur);
  const refresh = async () => {
    await fin.reload();
    onChanged();
  };
  const active = !['CANCELLED', 'CANCELLED_REFUNDED'].includes(f.admissionStatus);

  return (
    <div className="mt-4 rounded-md p-3 ring-1 ring-slate-200">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="font-semibold">Fees</span>
        <span>
          Fee {m(f.netFee)} · paid {m(f.netCollected)} ·{' '}
          <span className="font-semibold">outstanding {m(f.outstanding)}</span>
        </span>
        {f.overdueMinor > 0 && <Badge tone="red">{m(f.overdueMinor)} overdue</Badge>}
        {f.refundedPaid > 0 && (
          <span className="text-xs text-slate-500">(refunded {m(f.refundedPaid)})</span>
        )}
      </div>
      <table className="mt-2 w-full text-left text-xs">
        <thead className="text-slate-500">
          <tr>
            <th className="py-1">Instalment</th>
            <th>Due</th>
            <th className="text-right">Amount</th>
            <th className="text-right">Paid</th>
          </tr>
        </thead>
        <tbody>
          {f.schedule.map((i) => (
            <tr key={i.id} className={i.overdue ? 'text-red-700' : ''}>
              <td className="py-0.5">{i.seq}</td>
              <td>{i.dueDate.slice(0, 10)}</td>
              <td className="text-right tabular-nums">{m(i.amountMinor)}</td>
              <td className="text-right tabular-nums">{m(i.paidMinor)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {active && (
        <div className="mt-3 flex flex-wrap gap-2">
          {f.can.work && f.outstanding > 0 && (
            <Button
              variant="secondary"
              disabled={busy || !f.gateway}
              title={!f.gateway ? 'No payment gateway connected yet' : undefined}
              onClick={() =>
                void run(async () => {
                  const r = await api<Attempt>(`/fee-plans/${f.plan.id}/payment-links`, {
                    method: 'POST',
                    body: {},
                  });
                  setLink(r.checkoutUrl);
                  await fin.reload();
                })
              }
            >
              Create payment link
            </Button>
          )}
          {f.can.record && f.outstanding > 0 && (
            <Button
              variant={mode === 'pay' ? 'primary' : 'secondary'}
              onClick={() => setMode(mode === 'pay' ? null : 'pay')}
            >
              Record payment
            </Button>
          )}
          {(f.can.record || (f.can.work && !f.payments.length)) && (
            <Button variant="secondary" onClick={() => setMode(mode === 'plan' ? null : 'plan')}>
              Instalments
            </Button>
          )}
          {f.can.record && (
            <Button
              variant="secondary"
              onClick={() => setMode(mode === 'adjust' ? null : 'adjust')}
            >
              Adjust fee
            </Button>
          )}
        </div>
      )}
      {!f.gateway && (
        <p className="mt-1 text-xs text-slate-500">
          No payment gateway connected yet: Accounts records payments manually.
        </p>
      )}
      {link && (
        <p className="mt-2 text-sm">
          Payment link:{' '}
          <a
            className="break-all text-brand-700 underline"
            href={link}
            target="_blank"
            rel="noreferrer"
          >
            {link}
          </a>
        </p>
      )}
      <ErrorText error={error} />
      {mode === 'pay' && (
        <RecordPayment
          planId={f.plan.id}
          outstanding={f.outstanding}
          currency={cur}
          onDone={() => {
            setMode(null);
            void refresh();
          }}
        />
      )}
      {mode === 'plan' && (
        <Replan
          planId={f.plan.id}
          onDone={() => {
            setMode(null);
            void refresh();
          }}
        />
      )}
      {mode === 'adjust' && (
        <Adjust
          planId={f.plan.id}
          onDone={() => {
            setMode(null);
            void refresh();
          }}
        />
      )}

      {f.payments.length > 0 && (
        <div className="mt-4">
          <h4 className="text-xs font-semibold text-slate-600">Payments</h4>
          <ul className="mt-1 space-y-1 text-xs">
            {f.payments.map((p) => (
              <PaymentItem
                key={p.id}
                p={p}
                refunds={f.refunds.filter((r) => r.paymentId === p.id)}
                can={f.can}
                onChanged={() => void refresh()}
              />
            ))}
          </ul>
        </div>
      )}
      {f.attempts.some((x) => x.status !== 'SUCCEEDED') && (
        <div className="mt-3 text-xs text-slate-600">
          <h4 className="font-semibold">Payment links</h4>
          {f.attempts
            .filter((x) => x.status !== 'SUCCEEDED')
            .map((x) => (
              <p key={x.id}>
                {m(x.amountMinor)} · {x.status.toLowerCase()} · {fmt(x.createdAt)}
                {x.mismatch && <span className="text-red-700"> · {x.mismatch}</span>}
              </p>
            ))}
        </div>
      )}
    </div>
  );
}

function PaymentItem({
  p,
  refunds,
  can,
  onChanged,
}: {
  p: PaymentRow;
  refunds: RefundRow[];
  can: Finance['can'];
  onChanged: () => void;
}) {
  const { busy, error, run } = useAction();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ amount: '', reason: '' });
  return (
    <li className="rounded bg-slate-50 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono">{p.receiptNumber}</span>
        <span className="font-semibold">{formatMoney(p.amountMinor, p.currency)}</span>
        <span>
          {p.method.toLowerCase().replace('_', ' ')}
          {p.reference ? ` · ${p.reference}` : ''} · {fmt(p.receivedAt)}
        </span>
        <Badge tone="green">
          {p.verification === 'MANUAL' ? 'verified by Accounts' : 'verified by gateway'}
        </Badge>
        {can.requestRefund && (
          <button
            type="button"
            className="ml-auto text-brand-700 hover:underline"
            onClick={() => setOpen((x) => !x)}
          >
            Request refund
          </button>
        )}
      </div>
      {refunds.map((r) => (
        <div key={r.id} className="mt-1 flex flex-wrap items-center gap-2 pl-4">
          Refund {formatMoney(r.amountMinor, r.currency)} — {r.reason}
          <Badge tone={r.status === 'PAID' ? 'green' : r.status === 'REJECTED' ? 'red' : 'amber'}>
            {r.status.toLowerCase()}
          </Badge>
          {can.approveRefund && r.status === 'REQUESTED' && (
            <>
              <Button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api(`/refunds/${r.id}/approve`, { method: 'POST', body: {} });
                    onChanged();
                  })
                }
              >
                Approve
              </Button>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  const note = window.prompt('Why reject this refund?');
                  if (note && note.trim().length >= 3)
                    void run(async () => {
                      await api(`/refunds/${r.id}/reject`, { method: 'POST', body: { note } });
                      onChanged();
                    });
                }}
              >
                Reject
              </Button>
            </>
          )}
          {can.approveRefund && r.status === 'APPROVED' && (
            <Button
              disabled={busy}
              onClick={() => {
                const reference = window.prompt('Payout reference (bank / UPI transaction)');
                if (reference && reference.trim().length >= 2)
                  void run(async () => {
                    await api(`/refunds/${r.id}/paid`, {
                      method: 'POST',
                      body: {
                        method: 'BANK_TRANSFER',
                        reference,
                        paidOn: new Date().toISOString().slice(0, 10),
                      },
                    });
                    onChanged();
                  });
              }}
            >
              Mark paid out
            </Button>
          )}
        </div>
      ))}
      {open && (
        <form
          className="mt-2 flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api(`/payments/${p.id}/refunds`, {
                method: 'POST',
                body: { amountMinor: toMinor(f.amount), reason: f.reason },
              });
              setOpen(false);
              onChanged();
            });
          }}
        >
          <div className="w-32">
            <Field label={`Refund (${p.currency})`}>
              <Input
                type="number"
                step="0.01"
                min={0.01}
                required
                value={f.amount}
                onChange={(e) => setF({ ...f, amount: e.target.value })}
              />
            </Field>
          </div>
          <div className="min-w-48 flex-1">
            <Field label="Refund reason">
              <Input
                required
                minLength={3}
                value={f.reason}
                onChange={(e) => setF({ ...f, reason: e.target.value })}
              />
            </Field>
          </div>
          <Button type="submit" disabled={busy}>
            Request
          </Button>
        </form>
      )}
      <ErrorText error={error} />
    </li>
  );
}

function RecordPayment({
  planId,
  outstanding,
  currency,
  onDone,
}: {
  planId: string;
  outstanding: number;
  currency: string;
  onDone: () => void;
}) {
  const [f, setF] = useState({
    amount: String(outstanding / 100),
    method: 'BANK_TRANSFER',
    reference: '',
    receivedAt: toLocalInput(new Date()),
  });
  const { busy, error, run } = useAction();
  return (
    <form
      className="mt-3 flex flex-wrap items-end gap-3 rounded-md bg-slate-50 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await api(`/fee-plans/${planId}/payments`, {
            method: 'POST',
            body: {
              amountMinor: toMinor(f.amount),
              method: f.method,
              reference: f.reference || undefined,
              receivedAt: localInputToIso(f.receivedAt),
            },
          });
          onDone();
        });
      }}
    >
      <div className="w-36">
        <Field label={`Amount (${currency})`}>
          <Input
            type="number"
            step="0.01"
            min={0.01}
            required
            value={f.amount}
            onChange={(e) => setF({ ...f, amount: e.target.value })}
          />
        </Field>
      </div>
      <div className="w-40">
        <Field label="Method">
          <Select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>
            {METHODS.map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="w-44">
        <Field label="Reference">
          <Input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />
        </Field>
      </div>
      <div className="w-52">
        <Field label="Received at">
          <Input
            type="datetime-local"
            required
            value={f.receivedAt}
            onChange={(e) => setF({ ...f, receivedAt: e.target.value })}
          />
        </Field>
      </div>
      <ErrorText error={error} />
      <Button type="submit" disabled={busy}>
        Save verified payment
      </Button>
    </form>
  );
}

function Replan({ planId, onDone }: { planId: string; onDone: () => void }) {
  const [f, setF] = useState({
    count: '2',
    firstDueDate: new Date().toISOString().slice(0, 10),
    intervalDays: '30',
  });
  const { busy, error, run } = useAction();
  return (
    <form
      className="mt-3 flex flex-wrap items-end gap-3 rounded-md bg-slate-50 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await api(`/fee-plans/${planId}/schedule`, {
            method: 'PUT',
            body: {
              mode: 'EQUAL',
              count: Number(f.count),
              firstDueDate: f.firstDueDate,
              intervalDays: Number(f.intervalDays),
            },
          });
          onDone();
        });
      }}
    >
      <div className="w-28">
        <Field label="Instalments">
          <Input
            type="number"
            min={1}
            max={24}
            value={f.count}
            onChange={(e) => setF({ ...f, count: e.target.value })}
          />
        </Field>
      </div>
      <div className="w-44">
        <Field label="First due">
          <Input
            type="date"
            required
            value={f.firstDueDate}
            onChange={(e) => setF({ ...f, firstDueDate: e.target.value })}
          />
        </Field>
      </div>
      <div className="w-32">
        <Field label="Every (days)">
          <Input
            type="number"
            min={1}
            value={f.intervalDays}
            onChange={(e) => setF({ ...f, intervalDays: e.target.value })}
          />
        </Field>
      </div>
      <ErrorText error={error} />
      <Button type="submit" disabled={busy}>
        Split equally
      </Button>
    </form>
  );
}

function Adjust({ planId, onDone }: { planId: string; onDone: () => void }) {
  const [f, setF] = useState({ amount: '', direction: '-1', reason: '' });
  const { busy, error, run } = useAction();
  return (
    <form
      className="mt-3 flex flex-wrap items-end gap-3 rounded-md bg-slate-50 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await api(`/fee-plans/${planId}/adjustments`, {
            method: 'POST',
            body: { amountMinor: Number(f.direction) * toMinor(f.amount), reason: f.reason },
          });
          onDone();
        });
      }}
    >
      <div className="w-36">
        <Field label="Change">
          <Select value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value })}>
            <option value="-1">Reduce (concession)</option>
            <option value="1">Increase</option>
          </Select>
        </Field>
      </div>
      <div className="w-32">
        <Field label="By amount">
          <Input
            type="number"
            step="0.01"
            min={0.01}
            required
            value={f.amount}
            onChange={(e) => setF({ ...f, amount: e.target.value })}
          />
        </Field>
      </div>
      <div className="min-w-56 flex-1">
        <Field label="Adjustment reason">
          <Input
            required
            minLength={3}
            value={f.reason}
            onChange={(e) => setF({ ...f, reason: e.target.value })}
          />
        </Field>
      </div>
      <ErrorText error={error} />
      <Button type="submit" disabled={busy}>
        Save adjustment
      </Button>
    </form>
  );
}
