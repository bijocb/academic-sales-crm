'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ADMISSION_TONE, label } from '@/components/admission-panel';
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
import { fmtDateTime as fmt } from '@/lib/lead-format';
import { useSession } from '@/lib/session';
import type { Brand, Course } from '@/lib/types';

interface Row {
  id: string;
  leadId: string;
  leadNumber?: string;
  studentName?: string;
  course?: string;
  batch: string | null;
  status: string;
  admissionNumber: string | null;
  documents: { verified: number; required: number };
  updatedAt: string;
}
interface DocType {
  id: string;
  code: string;
  label: string;
  description: string | null;
  requiredByDefault: boolean;
  active: boolean;
}

export default function AdmissionsPage() {
  const { can } = useSession();
  const brands = useLoad(() => api<Brand[]>('/brands'));
  const [status, setStatus] = useState('');
  const rows = useLoad(
    () =>
      can('admission.manage')
        ? api<Row[]>(`/admissions${status ? `?status=${status}` : ''}`)
        : Promise.resolve([] as Row[]),
    [status],
  );
  const [brandId, setBrandId] = useState('');
  const bid = brandId || brands.data?.[0]?.id || '';
  return (
    <>
      <PageHeader
        title="Admissions"
        description="Document checks, approval and batch seats. Confirmation follows the first verified payment."
      />
      <div className="space-y-6">
        {can('admission.manage') && (
          <Card
            actions={
              <Select
                aria-label="Status"
                className="w-52"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                <option value="">All open</option>
                {[
                  'DOCUMENTS_PENDING',
                  'UNDER_VERIFICATION',
                  'APPROVED',
                  'CONFIRMED',
                  'DEFERRED',
                  'CANCELLED',
                ].map((s) => (
                  <option key={s} value={s}>
                    {label(s)}
                  </option>
                ))}
              </Select>
            }
          >
            <ErrorText error={rows.error} />
            <Table
              head={[
                'Student',
                'Course / batch',
                'Documents',
                'Status',
                'Admission no.',
                'Updated',
              ]}
              empty={rows.data?.length === 0}
            >
              {rows.data?.map((r) => (
                <tr key={r.id}>
                  <Td>
                    <Link
                      href={`/leads/${r.leadId}`}
                      className="font-medium text-brand-700 hover:underline"
                    >
                      {r.studentName}
                    </Link>{' '}
                    <span className="font-mono text-xs text-slate-500">{r.leadNumber}</span>
                  </Td>
                  <Td>
                    {r.course}
                    {r.batch ? ` · ${r.batch}` : ''}
                  </Td>
                  <Td className="tabular-nums">
                    {r.documents.verified}/{r.documents.required}
                  </Td>
                  <Td>
                    <Badge tone={ADMISSION_TONE[r.status]}>{label(r.status)}</Badge>
                  </Td>
                  <Td className="font-mono text-xs">{r.admissionNumber ?? '—'}</Td>
                  <Td className="whitespace-nowrap">{fmt(r.updatedAt)}</Td>
                </tr>
              ))}
            </Table>
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
            <NumberingCard brandId={bid} />
            <DocumentTypesCard brandId={bid} />
            <CourseChecklistCard brandId={bid} />
          </>
        )}
      </div>
    </>
  );
}

function NumberingCard({ brandId }: { brandId: string }) {
  const s = useLoad(
    () =>
      api<{ numberFormat: string; requireApprovalToConfirm: boolean }>(
        `/admission-settings?brandId=${brandId}`,
      ),
    [brandId],
  );
  const [f, setF] = useState({ numberFormat: '', requireApprovalToConfirm: false });
  const { busy, error, run } = useAction();
  useEffect(() => {
    if (s.data)
      setF({
        numberFormat: s.data.numberFormat,
        requireApprovalToConfirm: s.data.requireApprovalToConfirm,
      });
  }, [s.data]);
  return (
    <Card title="Admission numbers and confirmation">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api(`/admission-settings?brandId=${brandId}`, { method: 'PUT', body: f });
            await s.reload();
          });
        }}
      >
        <div className="max-w-md">
          <Field label="Number format ({BRAND}, {YYYY}, {YY}, {SEQ:5})">
            <Input
              value={f.numberFormat}
              onChange={(e) => setF({ ...f, numberFormat: e.target.value })}
            />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={f.requireApprovalToConfirm}
            onChange={(e) => setF({ ...f, requireApprovalToConfirm: e.target.checked })}
          />
          Confirm only after the admission is approved (default: the first verified payment
          confirms, D-006)
        </label>
        <ErrorText error={error ?? s.error} />
        <Button type="submit" disabled={busy}>
          Save
        </Button>
      </form>
    </Card>
  );
}

function DocumentTypesCard({ brandId }: { brandId: string }) {
  const types = useLoad(() => api<DocType[]>(`/document-types?brandId=${brandId}`), [brandId]);
  const [f, setF] = useState({ code: '', label: '', requiredByDefault: true });
  const { busy, error, run } = useAction();
  const patch = (t: DocType, body: Partial<DocType>) =>
    run(async () => {
      await api(`/document-types/${t.id}`, { method: 'PATCH', body });
      await types.reload();
    });
  return (
    <Card title="Document types">
      <Table
        head={['Document', 'Code', 'Required by default', 'Active']}
        empty={types.data?.length === 0}
      >
        {types.data?.map((t) => (
          <tr key={t.id} className={t.active ? '' : 'text-slate-400'}>
            <Td>
              {t.label}
              {t.description && (
                <span className="block text-xs text-slate-500">{t.description}</span>
              )}
            </Td>
            <Td className="font-mono text-xs">{t.code}</Td>
            <Td>
              <input
                type="checkbox"
                aria-label={`${t.label} required`}
                checked={t.requiredByDefault}
                disabled={busy}
                onChange={(e) => void patch(t, { requiredByDefault: e.target.checked })}
              />
            </Td>
            <Td>
              <input
                type="checkbox"
                aria-label={`${t.label} active`}
                checked={t.active}
                disabled={busy}
                onChange={(e) => void patch(t, { active: e.target.checked })}
              />
            </Td>
          </tr>
        ))}
      </Table>
      <form
        className="mt-4 flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api('/document-types', { method: 'POST', body: { brandId, ...f } });
            setF({ code: '', label: '', requiredByDefault: true });
            await types.reload();
          });
        }}
      >
        <div className="w-64">
          <Field label="New document">
            <Input
              required
              minLength={2}
              value={f.label}
              onChange={(e) => setF({ ...f, label: e.target.value })}
            />
          </Field>
        </div>
        <div className="w-48">
          <Field label="Document code">
            <Input
              required
              value={f.code}
              onChange={(e) =>
                setF({ ...f, code: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') })
              }
            />
          </Field>
        </div>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <input
            type="checkbox"
            checked={f.requiredByDefault}
            onChange={(e) => setF({ ...f, requiredByDefault: e.target.checked })}
          />
          Required
        </label>
        <Button type="submit" disabled={busy}>
          Add document
        </Button>
      </form>
      <ErrorText error={error ?? types.error} />
    </Card>
  );
}

function CourseChecklistCard({ brandId }: { brandId: string }) {
  const courses = useLoad(
    () => api<Course[]>(`/courses?brandId=${brandId}&status=ACTIVE`),
    [brandId],
  );
  const [courseId, setCourseId] = useState('');
  const reqs = useLoad(
    () =>
      courseId
        ? api<Array<{ documentTypeId: string; label: string; required: boolean }>>(
            `/courses/${courseId}/document-requirements`,
          )
        : Promise.resolve([]),
    [courseId],
  );
  const { busy, error, run } = useAction();
  const toggle = (typeId: string, required: boolean) =>
    run(async () => {
      const next = (reqs.data ?? []).map((r) => ({
        documentTypeId: r.documentTypeId,
        required: r.documentTypeId === typeId ? required : r.required,
      }));
      await api(`/courses/${courseId}/document-requirements`, {
        method: 'PUT',
        body: { requirements: next },
      });
      await reqs.reload();
    });
  return (
    <Card title="Checklist per course">
      <div className="w-72">
        <Field label="Course">
          <Select value={courseId} onChange={(e) => setCourseId(e.target.value)}>
            <option value="">Select…</option>
            {courses.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {courseId && (
        <ul className="mt-3 space-y-1 text-sm">
          {reqs.data?.map((r) => (
            <li key={r.documentTypeId}>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={r.required}
                  disabled={busy}
                  onChange={(e) => void toggle(r.documentTypeId, e.target.checked)}
                />
                {r.label} {r.required ? '(required)' : '(optional)'}
              </label>
            </li>
          ))}
        </ul>
      )}
      <ErrorText error={error ?? reqs.error} />
    </Card>
  );
}
