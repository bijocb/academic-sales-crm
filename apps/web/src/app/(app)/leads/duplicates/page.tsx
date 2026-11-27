'use client';
import Link from 'next/link';
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
import { fmtDateTime, REASON_LABEL } from '@/lib/lead-format';
import { useSession } from '@/lib/session';
import type { Brand, DuplicateCandidateRow, DuplicatePerson } from '@/lib/types';

type Side = 'A' | 'B';
type PlanItem = {
  brandId: string;
  action: string;
  leadId: string;
  leadNumber: string;
  intoLeadNumber?: string;
};

export default function DuplicatesPage() {
  const { canOrgWide } = useSession();
  const [status, setStatus] = useState<'OPEN' | 'MERGED' | 'DISMISSED'>('OPEN');
  const list = useLoad(
    () => api<DuplicateCandidateRow[]>(`/duplicates?status=${status}`),
    [status],
  );
  const brands = useLoad(() => api<Brand[]>('/brands'));
  const [open, setOpen] = useState<string | null>(null);
  const scan = useAction();
  const [scanResult, setScanResult] = useState<string | null>(null);
  const brandName = (id: string) => brands.data?.find((b) => b.id === id)?.name ?? 'Other brand';

  return (
    <>
      <PageHeader
        title="Possible duplicates"
        description="Suggestions only — nothing is merged automatically. Merging keeps every enquiry and its original source."
        actions={
          canOrgWide('lead.merge') && (
            <Button
              variant="secondary"
              disabled={scan.busy}
              onClick={() =>
                void scan.run(async () => {
                  const r = await api<{ scanned: number; created: number }>('/duplicates/scan', {
                    method: 'POST',
                  });
                  setScanResult(`Checked ${r.scanned} people, ${r.created} new suggestion(s).`);
                  await list.reload();
                })
              }
            >
              {scan.busy ? 'Scanning…' : 'Scan all people'}
            </Button>
          )
        }
      />
      {scanResult && <p className="mb-4 text-sm text-slate-600">{scanResult}</p>}
      <ErrorText error={scan.error ?? list.error} />
      <Card
        actions={
          <Select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as 'OPEN');
              setOpen(null);
            }}
            className="w-40"
          >
            <option value="OPEN">To review</option>
            <option value="MERGED">Merged</option>
            <option value="DISMISSED">Not duplicates</option>
          </Select>
        }
      >
        <Table head={['Person 1', 'Person 2', 'Why', 'Score', '']} empty={list.data?.length === 0}>
          {list.data?.map((c) => (
            <tr key={c.id}>
              <Td>
                <PersonCell p={c.personA} />
              </Td>
              <Td>
                <PersonCell p={c.personB} />
              </Td>
              <Td>
                <div className="flex flex-wrap gap-1">
                  {c.reasons.map((r) => (
                    <Badge key={r}>{REASON_LABEL[r] ?? r}</Badge>
                  ))}
                </div>
              </Td>
              <Td className="tabular-nums">{Math.round(c.score * 100)}%</Td>
              <Td>
                {status === 'OPEN' ? (
                  <Button variant="secondary" onClick={() => setOpen(open === c.id ? null : c.id)}>
                    {open === c.id ? 'Close' : 'Review'}
                  </Button>
                ) : (
                  <span className="text-xs text-slate-500">{c.resolutionNote}</span>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      </Card>
      {open && list.data && (
        <div className="mt-6">
          <Review
            c={list.data.find((x) => x.id === open)!}
            brandName={brandName}
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

function PersonCell({ p }: { p: DuplicatePerson }) {
  return (
    <div className="text-sm">
      <div className="font-medium">{p.fullName}</div>
      <div className="font-mono text-xs text-slate-500">
        {p.phone ?? '—'} · {p.email ?? '—'}
      </div>
      <div className="text-xs text-slate-500">{p.leads.map((l) => l.leadNumber).join(', ')}</div>
    </div>
  );
}

const FIELDS: Array<{ key: 'fullName' | 'phone' | 'email' | 'city'; label: string }> = [
  { key: 'fullName', label: 'Name' },
  { key: 'phone', label: 'Mobile' },
  { key: 'email', label: 'Email' },
  { key: 'city', label: 'City' },
];

function Review({
  c,
  brandName,
  onDone,
}: {
  c: DuplicateCandidateRow;
  brandName: (id: string) => string;
  onDone: () => void;
}) {
  const [survivor, setSurvivor] = useState<Side>(
    new Date(c.personA.createdAt) <= new Date(c.personB.createdAt) ? 'A' : 'B',
  );
  const [fields, setFields] = useState<Record<string, Side>>({
    fullName: survivor,
    phone: survivor,
    email: survivor,
    city: survivor,
  });
  const [note, setNote] = useState('');
  const preview = useLoad(
    () => api<{ plan: PlanItem[] }>(`/duplicates/${c.id}?survivor=${survivor}`),
    [c.id, survivor],
  );
  const merge = useAction();
  const dismiss = useAction();
  const people = { A: c.personA, B: c.personB };

  return (
    <Card title="Compare and decide">
      <div className="grid gap-4 sm:grid-cols-2">
        {(['A', 'B'] as Side[]).map((side) => (
          <label
            key={side}
            className={`cursor-pointer rounded-md p-3 ring-1 ${survivor === side ? 'bg-brand-50 ring-brand-600' : 'ring-slate-200'}`}
          >
            <input
              type="radio"
              name="survivor"
              className="mr-2"
              checked={survivor === side}
              onChange={() => {
                setSurvivor(side);
                setFields({ fullName: side, phone: side, email: side, city: side });
              }}
            />
            <span className="text-sm font-medium">Keep this record</span>
            <dl className="mt-2 space-y-1 text-sm">
              <div>{people[side].fullName}</div>
              <div className="font-mono text-xs">
                {people[side].phone ?? '—'} · {people[side].email ?? '—'}
              </div>
              <div className="text-xs text-slate-500">
                City: {people[side].city ?? '—'} · created {fmtDateTime(people[side].createdAt)}
              </div>
              {people[side].leads.map((l) => (
                <div key={l.id} className="text-xs">
                  <Link
                    href={`/leads/${l.id}`}
                    className="font-mono text-brand-700 hover:underline"
                  >
                    {l.leadNumber}
                  </Link>{' '}
                  · {brandName(l.brandId)} · {l.status} · {l.enquiryCount} enquiries
                </div>
              ))}
            </dl>
          </label>
        ))}
      </div>

      <h3 className="mt-6 mb-2 text-sm font-semibold text-slate-700">Which details to keep</h3>
      <div className="grid gap-3 sm:grid-cols-4">
        {FIELDS.map((f) => (
          <Field key={f.key} label={f.label}>
            <Select
              value={fields[f.key]}
              onChange={(e) => setFields({ ...fields, [f.key]: e.target.value as Side })}
            >
              {(['A', 'B'] as Side[]).map((side) => {
                const v =
                  f.key === 'fullName'
                    ? people[side].fullName
                    : f.key === 'phone'
                      ? people[side].phone
                      : f.key === 'email'
                        ? people[side].email
                        : people[side].city;
                return (
                  <option key={side} value={side}>
                    {v ?? '(empty)'}
                  </option>
                );
              })}
            </Select>
          </Field>
        ))}
      </div>

      <h3 className="mt-6 mb-2 text-sm font-semibold text-slate-700">What will happen</h3>
      <ul className="list-disc space-y-1 pl-5 text-sm">
        {preview.data?.plan.map((i) => (
          <li key={i.leadId}>
            {i.action === 'MERGE_INTO_SURVIVOR_LEAD' ? (
              <>
                {brandName(i.brandId)}: lead <span className="font-mono">{i.leadNumber}</span> is
                combined into <span className="font-mono">{i.intoLeadNumber}</span> (both enquiry
                histories kept)
              </>
            ) : (
              <>
                {brandName(i.brandId)}: lead <span className="font-mono">{i.leadNumber}</span> moves
                to the kept person
              </>
            )}
          </li>
        ))}
        <li>
          The other person record is kept (marked as merged); future enquiries from its phone or
          email go to the kept person.
        </li>
      </ul>
      <ErrorText error={preview.error} />

      <div className="mt-6 flex flex-wrap items-end gap-3">
        <div className="w-80">
          <Field label="Note (optional for merge, required to dismiss)">
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Same student, typo in phone"
            />
          </Field>
        </div>
        <Button
          disabled={merge.busy}
          onClick={() =>
            void merge.run(async () => {
              await api(`/duplicates/${c.id}/merge`, {
                method: 'POST',
                body: { survivor, fields, note: note || undefined },
              });
              onDone();
            })
          }
        >
          Merge
        </Button>
        <Button
          variant="secondary"
          disabled={dismiss.busy || note.trim().length < 3}
          onClick={() =>
            void dismiss.run(async () => {
              await api(`/duplicates/${c.id}/dismiss`, { method: 'POST', body: { note } });
              onDone();
            })
          }
        >
          Not duplicates
        </Button>
      </div>
      <div className="mt-2">
        <ErrorText error={merge.error ?? dismiss.error} />
      </div>
    </Card>
  );
}
