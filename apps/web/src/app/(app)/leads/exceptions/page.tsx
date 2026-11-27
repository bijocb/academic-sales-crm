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
import type { Brand, IntakeExceptionRow, Paged } from '@/lib/types';

export default function ExceptionsPage() {
  const brands = useLoad(() => api<Brand[]>('/brands'));
  const [status, setStatus] = useState<'OPEN' | 'RESOLVED' | 'DISCARDED'>('OPEN');
  const list = useLoad(
    () => api<Paged<IntakeExceptionRow>>(`/intake-exceptions?status=${status}&pageSize=100`),
    [status],
  );
  const [open, setOpen] = useState<string | null>(null);
  const brandName = (id: string) => brands.data?.find((b) => b.id === id)?.name ?? '';

  return (
    <>
      <PageHeader
        title="Rejected leads"
        description="Submissions that failed validation are kept here, never dropped. Fix and resubmit, or discard with a reason."
      />
      <Card
        actions={
          <Select
            value={status}
            onChange={(e) => setStatus(e.target.value as 'OPEN')}
            className="w-40"
          >
            <option value="OPEN">Needs action</option>
            <option value="RESOLVED">Resolved</option>
            <option value="DISCARDED">Discarded</option>
          </Select>
        }
      >
        <ErrorText error={list.error} />
        <Table
          head={['Received', 'Brand', 'Channel', 'Submitted', 'Problem', '']}
          empty={list.data?.items.length === 0}
        >
          {list.data?.items.map((x) => (
            <tr key={x.id}>
              <Td className="whitespace-nowrap">{new Date(x.receivedAt).toLocaleString()}</Td>
              <Td>{brandName(x.brandId)}</Td>
              <Td>
                <Badge>{x.channel}</Badge>
                {x.rowNumber ? (
                  <span className="ml-1 text-xs text-slate-500">row {x.rowNumber}</span>
                ) : null}
              </Td>
              <Td className="text-xs">
                {[x.payload.name, x.payload.phone, x.payload.email].filter(Boolean).join(' · ') ||
                  '—'}
              </Td>
              <Td className="text-sm text-red-700">{x.errors.map((e) => e.message).join('; ')}</Td>
              <Td>
                {status === 'OPEN' && (
                  <Button variant="secondary" onClick={() => setOpen(open === x.id ? null : x.id)}>
                    {open === x.id ? 'Close' : 'Fix'}
                  </Button>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      </Card>
      {open && list.data && (
        <div className="mt-6">
          <Fix
            row={list.data.items.find((x) => x.id === open)!}
            onDone={() => {
              setOpen(null);
              void list.reload();
            }}
          />
        </div>
      )}
    </>
  );
}

function Fix({ row, onDone }: { row: IntakeExceptionRow; onDone: () => void }) {
  const [f, setF] = useState({
    name: row.payload.name ?? '',
    phone: row.payload.phone ?? '',
    email: row.payload.email ?? '',
    course: row.payload.course ?? '',
    city: row.payload.city ?? '',
  });
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const fix = useAction();
  const discard = useAction();
  const opt = (v: string) => (v.trim() ? v.trim() : undefined);
  return (
    <Card title="Fix and resubmit">
      <form
        className="grid gap-4 sm:grid-cols-3"
        onSubmit={(e) => {
          e.preventDefault();
          void fix.run(async () => {
            await api(`/intake-exceptions/${row.id}/resolve`, {
              method: 'POST',
              body: {
                lead: {
                  ...row.payload,
                  name: opt(f.name),
                  phone: opt(f.phone),
                  email: opt(f.email),
                  course: opt(f.course),
                  city: opt(f.city),
                },
                note: opt(note),
              },
            });
            onDone();
          });
        }}
      >
        <Field label="Full name">
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label="Mobile">
          <Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
        </Field>
        <Field label="Email">
          <Input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        </Field>
        <Field label="Course">
          <Input value={f.course} onChange={(e) => setF({ ...f, course: e.target.value })} />
        </Field>
        <Field label="City">
          <Input value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} />
        </Field>
        <Field label="Note (optional)">
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <div className="sm:col-span-3">
          <ErrorText error={fix.error} />
        </div>
        <div className="sm:col-span-3">
          <Button type="submit" disabled={fix.busy}>
            Create lead
          </Button>
        </div>
      </form>
      <div className="mt-6 flex flex-wrap items-end gap-3 border-t border-slate-200 pt-4">
        <div className="w-80">
          <Field label="Or discard — reason">
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Spam / test submission"
            />
          </Field>
        </div>
        <Button
          variant="danger"
          disabled={discard.busy || reason.trim().length < 3}
          onClick={() =>
            void discard.run(async () => {
              await api(`/intake-exceptions/${row.id}/discard`, {
                method: 'POST',
                body: { reason },
              });
              onDone();
            })
          }
        >
          Discard
        </Button>
      </div>
      <div className="mt-2">
        <ErrorText error={discard.error} />
      </div>
    </Card>
  );
}
