'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
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
import { CHANNEL_LABEL, fmtDateTime as fmt, leadStatusTone as statusTone } from '@/lib/lead-format';
import { useSession } from '@/lib/session';
import { BulkMove, DEFAULT_STAGES, SavedViews, STAGE_LABEL } from '@/components/pipeline-tools';
import type { Brand, Course, LeadRow, LeadSource, Paged } from '@/lib/types';

export default function LeadsPage() {
  const { can } = useSession();
  const router = useRouter();
  const brands = useLoad(() => api<Brand[]>('/brands'));
  const [brandId, setBrandId] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [stage, setStage] = useState('');
  const [owner, setOwner] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const leads = useLoad(
    () =>
      api<Paged<LeadRow>>(
        `/leads?page=${page}&pageSize=25${brandId ? `&brandId=${brandId}` : ''}${status ? `&status=${status}` : ''}${stage ? `&stage=${stage}` : ''}${owner ? `&ownerId=${owner}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`,
      ),
    [page, brandId, status, stage, owner, q],
  );
  const filters = { brandId, status, stage, owner, q };
  const applyView = (f: Record<string, string>) => {
    setBrandId(f.brandId ?? '');
    setStatus(f.status ?? '');
    setStage(f.stage ?? '');
    setOwner(f.owner ?? '');
    setQ(f.q ?? '');
    setPage(1);
  };
  const toggleSel = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const pages = leads.data ? Math.max(1, Math.ceil(leads.data.total / leads.data.pageSize)) : 1;
  const brandName = (id: string) => brands.data?.find((b) => b.id === id)?.name ?? '';

  return (
    <>
      <PageHeader
        title="Leads"
        description="Every enquiry from every channel. The original source is kept even when a person enquires again."
        actions={
          can('lead.create') && (
            <Button onClick={() => setAdding((a) => !a)}>{adding ? 'Close' : 'New lead'}</Button>
          )
        }
      />
      {adding && brands.data && (
        <div className="mb-6">
          <NewLead brands={brands.data} onDone={(id) => router.push(`/leads/${id}`)} />
        </div>
      )}
      <SavedViews page="leads" current={filters} onApply={applyView} />
      {selected.length > 0 && (
        <BulkMove
          leadIds={selected}
          onDone={() => {
            setSelected([]);
            void leads.reload();
          }}
        />
      )}
      <Card
        actions={
          <div className="flex flex-wrap gap-2">
            <Input
              placeholder="Name, phone, email or lead no."
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
              className="w-64"
            />
            <Select
              value={brandId}
              onChange={(e) => {
                setBrandId(e.target.value);
                setPage(1);
              }}
              className="w-48"
            >
              <option value="">All brands</option>
              {brands.data?.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
            <Select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
              className="w-40"
            >
              <option value="">Any status</option>
              {['OPEN', 'ON_HOLD', 'LOST', 'IN_RECOVERY', 'CLOSED_LOST', 'CONVERTED', 'MERGED'].map(
                (s) => (
                  <option key={s}>{s}</option>
                ),
              )}
            </Select>
            <Select
              aria-label="Stage"
              value={stage}
              onChange={(e) => {
                setStage(e.target.value);
                setPage(1);
              }}
              className="w-48"
            >
              <option value="">Any stage</option>
              {DEFAULT_STAGES.map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
            <Select
              aria-label="Owner"
              value={owner}
              onChange={(e) => {
                setOwner(e.target.value);
                setPage(1);
              }}
              className="w-40"
            >
              <option value="">Any owner</option>
              <option value="me">My leads</option>
              <option value="none">Unassigned</option>
            </Select>
          </div>
        }
      >
        <ErrorText error={leads.error} />
        <Table
          head={[
            '',
            'Lead',
            'Name',
            'Phone',
            'Brand',
            'Original source',
            'Course',
            'Enquiries',
            'Stage',
            'Status',
            'Last enquiry',
          ]}
          empty={leads.data?.items.length === 0}
        >
          {leads.data?.items.map((l) => (
            <tr
              key={l.id}
              className="cursor-pointer hover:bg-slate-50"
              onClick={() => router.push(`/leads/${l.id}`)}
            >
              <Td>
                <input
                  type="checkbox"
                  aria-label={`Select ${l.leadNumber}`}
                  checked={selected.includes(l.id)}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => toggleSel(l.id)}
                />
              </Td>
              <Td className="font-mono text-xs">{l.leadNumber}</Td>
              <Td className="font-medium">{l.person.fullName}</Td>
              <Td className="font-mono text-xs">{l.person.phone ?? l.person.email ?? '—'}</Td>
              <Td>{brandName(l.brandId)}</Td>
              <Td>
                {l.originalSource
                  ? `${l.originalSource.source ?? CHANNEL_LABEL[l.originalSource.channel]}${l.originalSource.utmCampaign ? ` · ${l.originalSource.utmCampaign}` : ''}`
                  : '—'}
              </Td>
              <Td>{l.course?.name ?? '—'}</Td>
              <Td>{l.enquiryCount}</Td>
              <Td className="whitespace-nowrap">{STAGE_LABEL[l.stage] ?? l.stage}</Td>
              <Td>
                <Badge tone={statusTone(l.status)}>{l.status}</Badge>
              </Td>
              <Td className="whitespace-nowrap">{fmt(l.lastEnquiryAt)}</Td>
            </tr>
          ))}
        </Table>
        <div className="mt-4 flex items-center gap-2 text-sm">
          <Button variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Previous
          </Button>
          <span className="text-slate-600">
            Page {page} of {pages} · {leads.data?.total ?? 0} leads
          </span>
          <Button
            variant="secondary"
            disabled={page >= pages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      </Card>
    </>
  );
}

function NewLead({ brands, onDone }: { brands: Brand[]; onDone: (leadId: string) => void }) {
  const [f, setF] = useState({
    brandId: brands[0]?.id ?? '',
    name: '',
    phone: '',
    email: '',
    courseId: '',
    sourceId: '',
    channel: 'CALL',
    city: '',
    message: '',
  });
  const courses = useLoad(
    () =>
      f.brandId
        ? api<Course[]>(`/courses?brandId=${f.brandId}&status=ACTIVE`)
        : Promise.resolve([]),
    [f.brandId],
  );
  const sources = useLoad(
    () =>
      f.brandId ? api<LeadSource[]>(`/lead-sources?brandId=${f.brandId}`) : Promise.resolve([]),
    [f.brandId],
  );
  const { busy, error, run } = useAction();
  const opt = (v: string) => (v.trim() ? v.trim() : undefined);
  return (
    <Card title="New lead">
      <form
        className="grid gap-4 sm:grid-cols-3"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const res = await api<{ leadId: string }>('/leads', {
              method: 'POST',
              body: {
                brandId: f.brandId,
                name: f.name,
                phone: opt(f.phone),
                email: opt(f.email),
                courseId: opt(f.courseId),
                sourceId: opt(f.sourceId),
                channel: f.channel,
                city: opt(f.city),
                message: opt(f.message),
              },
            });
            onDone(res.leadId);
          });
        }}
      >
        <Field label="Brand">
          <Select
            value={f.brandId}
            onChange={(e) => setF({ ...f, brandId: e.target.value, courseId: '', sourceId: '' })}
          >
            {brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Full name">
          <Input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label="Mobile" hint="Local numbers use the brand's country code">
          <Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
        </Field>
        <Field label="Email">
          <Input
            type="email"
            value={f.email}
            onChange={(e) => setF({ ...f, email: e.target.value })}
          />
        </Field>
        <Field label="Course of interest">
          <Select value={f.courseId} onChange={(e) => setF({ ...f, courseId: e.target.value })}>
            <option value="">—</option>
            {courses.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="How did they reach us?">
          <Select value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}>
            {['CALL', 'MANUAL', 'REFERRAL', 'EVENT', 'WHATSAPP', 'WEBSITE', 'OTHER'].map((c) => (
              <option key={c} value={c}>
                {CHANNEL_LABEL[c]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Source">
          <Select value={f.sourceId} onChange={(e) => setF({ ...f, sourceId: e.target.value })}>
            <option value="">—</option>
            {sources.data
              ?.filter((s) => s.status === 'ACTIVE')
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </Select>
        </Field>
        <Field label="City">
          <Input value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })} />
        </Field>
        <Field label="Notes">
          <Input value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} />
        </Field>
        <div className="sm:col-span-3">
          <ErrorText error={error} />
        </div>
        <div className="sm:col-span-3">
          <Button type="submit" disabled={busy}>
            Save lead
          </Button>
        </div>
      </form>
    </Card>
  );
}
