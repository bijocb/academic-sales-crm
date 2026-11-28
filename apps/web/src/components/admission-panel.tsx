'use client';
import { useState } from 'react';
import {
  Badge,
  Button,
  Card,
  ErrorText,
  Field,
  Input,
  Select,
  useAction,
  useLoad,
} from '@/components/ui';
import { api } from '@/lib/api';
import { fmtDateTime as fmt } from '@/lib/lead-format';

interface DocFile {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  uploadedAt: string;
}
interface AdmissionDoc {
  id: string;
  documentTypeId: string;
  required: boolean;
  status: 'MISSING' | 'UPLOADED' | 'VERIFIED' | 'REJECTED';
  rejectionReason: string | null;
  verifiedAt: string | null;
  type: { code: string; label: string; description: string | null } | null;
  files: DocFile[];
}
export interface AdmissionView {
  id: string;
  status: string;
  admissionNumber: string | null;
  holdsSeat: boolean;
  seatOverride: boolean;
  seatOverrideReason: string | null;
  confirmedAt: string | null;
  course: { id: string; name: string };
  batch: { id: string; name: string; startDate: string } | null;
  seats: { capacity: number; used: number } | null;
  student: {
    legalName: string;
    dateOfBirth: string | null;
    guardianName: string | null;
    guardianPhone: string | null;
    idType: string | null;
    idNumber: string | null;
    email: string | null;
    phone: string | null;
  };
  documents: AdmissionDoc[];
  readyForApproval: boolean;
  history: Array<{
    id: string;
    fromStatus: string;
    toStatus: string;
    reason: string | null;
    occurredAt: string;
  }>;
  handover: {
    id: string;
    status: string;
    provider: string | null;
    lastError: string | null;
  } | null;
  can: { manage: boolean; work: boolean; viewDocuments: boolean };
}

export const ADMISSION_TONE: Record<string, 'slate' | 'amber' | 'blue' | 'green' | 'red'> = {
  DRAFT: 'slate',
  DOCUMENTS_PENDING: 'amber',
  UNDER_VERIFICATION: 'blue',
  APPROVED: 'green',
  CONFIRMED: 'green',
  DEFERRED: 'slate',
  CANCELLED: 'red',
};
const DOC_TONE = {
  MISSING: 'slate',
  UPLOADED: 'blue',
  VERIFIED: 'green',
  REJECTED: 'red',
} as const;
export const label = (s: string) => s.replace(/_/g, ' ').toLowerCase();

/** Admission workspace on the lead page (FR-014). */
export function AdmissionPanel({
  leadId,
  leadStatus,
  canStart,
  onChanged,
}: {
  leadId: string;
  leadStatus: string;
  canStart: boolean;
  onChanged: () => void;
}) {
  const data = useLoad(
    () => api<{ current: AdmissionView | null }>(`/leads/${leadId}/admission`),
    [leadId],
  );
  const { busy, error, run } = useAction();
  const a = data.data?.current;
  const refresh = async () => {
    await data.reload();
    onChanged();
  };
  if (!data.data) return <ErrorText error={data.error} />;
  if (!a || a.status === 'CANCELLED') {
    if (!canStart || leadStatus !== 'OPEN') return null;
    return (
      <Card title="Admission">
        {a && <p className="mb-2 text-sm text-slate-500">The previous admission was cancelled.</p>}
        <p className="mb-3 text-sm text-slate-600">
          Start the admission when the student has chosen a course and batch (an accepted quotation
          is used if there is one).
        </p>
        <ErrorText error={error} />
        <Button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await api(`/leads/${leadId}/admission`, { method: 'POST', body: {} });
              await refresh();
            })
          }
        >
          Start admission
        </Button>
      </Card>
    );
  }
  const act = (path: string, body: object = {}) =>
    run(async () => {
      await api(`/admissions/${a.id}/${path}`, { method: 'POST', body });
      await refresh();
    });
  const ask = (q: string) => {
    const r = window.prompt(q);
    return r && r.trim().length >= 3 ? r.trim() : null;
  };
  const required = a.documents.filter((d) => d.required);
  const verified = required.filter((d) => d.status === 'VERIFIED').length;

  return (
    <Card
      title="Admission"
      actions={
        <div className="flex items-center gap-2">
          {a.admissionNumber && (
            <span className="font-mono text-sm font-semibold">{a.admissionNumber}</span>
          )}
          <Badge tone={ADMISSION_TONE[a.status]}>{label(a.status)}</Badge>
        </div>
      }
    >
      <p className="text-sm text-slate-600">
        {a.course.name}
        {a.batch
          ? ` · ${a.batch.name} (starts ${a.batch.startDate.slice(0, 10)})`
          : ' · no batch yet'}
        {a.seats && ` · seats ${a.seats.used}/${a.seats.capacity}`}
        {a.seatOverride && ` · over capacity: ${a.seatOverrideReason}`}
      </p>
      <p className="mt-1 text-xs text-slate-500">
        Documents verified {verified}/{required.length} required.{' '}
        {a.status !== 'CONFIRMED' &&
          'The admission is confirmed when the first payment is verified.'}
      </p>

      <ul className="mt-4 space-y-2">
        {a.documents.map((d) => (
          <DocumentRow
            key={d.id}
            admissionId={a.id}
            doc={d}
            can={a.can}
            onChanged={() => void refresh()}
          />
        ))}
      </ul>

      <StudentProfile admission={a} onSaved={() => void refresh()} />

      <ErrorText error={error} />
      {a.can.manage && !['CONFIRMED', 'CANCELLED'].includes(a.status) && (
        <div className="mt-4 flex flex-wrap gap-2">
          {['UNDER_VERIFICATION', 'DOCUMENTS_PENDING'].includes(a.status) && (
            <Button disabled={busy || !a.readyForApproval} onClick={() => void act('approve')}>
              Approve admission
            </Button>
          )}
          {a.status === 'DEFERRED' ? (
            <Button variant="secondary" disabled={busy} onClick={() => void act('resume')}>
              Resume
            </Button>
          ) : (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                const reason = ask('Why defer this admission?');
                if (reason) void act('defer', { reason });
              }}
            >
              Defer
            </Button>
          )}
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => {
              const reason = ask('Why cancel this admission?');
              if (reason) void act('cancel', { reason });
            }}
          >
            Cancel admission
          </Button>
        </div>
      )}
      {a.handover && (
        <p className="mt-4 text-sm">
          Batch / LMS handover:{' '}
          <Badge tone={a.handover.status === 'FAILED' ? 'red' : 'blue'}>
            {label(a.handover.status)}
          </Badge>
          {a.handover.status === 'PENDING' && !a.handover.provider && a.can.manage && (
            <Button
              className="ml-2"
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await api(`/lms-handovers/${a.handover!.id}/mark-done`, { method: 'POST' });
                  await refresh();
                })
              }
            >
              Mark handed over
            </Button>
          )}
        </p>
      )}
      <details className="mt-4 text-xs text-slate-500">
        <summary className="cursor-pointer">Status history</summary>
        <ol className="mt-1 space-y-0.5">
          {a.history.map((h) => (
            <li key={h.id}>
              {fmt(h.occurredAt)} · {label(h.fromStatus)} → {label(h.toStatus)}
              {h.reason ? ` — ${h.reason}` : ''}
            </li>
          ))}
        </ol>
      </details>
    </Card>
  );
}

function DocumentRow({
  admissionId,
  doc,
  can,
  onChanged,
}: {
  admissionId: string;
  doc: AdmissionDoc;
  can: AdmissionView['can'];
  onChanged: () => void;
}) {
  const { busy, error, run } = useAction();
  const latest = doc.files[0];
  return (
    <li className="rounded-md p-3 text-sm ring-1 ring-slate-200">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{doc.type?.label}</span>
        {!doc.required && <span className="text-xs text-slate-500">(optional)</span>}
        <Badge tone={DOC_TONE[doc.status]}>{label(doc.status)}</Badge>
        {doc.rejectionReason && doc.status === 'REJECTED' && (
          <span className="text-xs text-red-700">{doc.rejectionReason}</span>
        )}
        <span className="ml-auto flex flex-wrap items-center gap-2">
          {can.viewDocuments && latest && (
            <button
              type="button"
              className="text-xs text-brand-700 hover:underline"
              onClick={() =>
                void run(async () => {
                  const r = await api<{ url: string }>(`/document-files/${latest.id}/link`, {
                    method: 'POST',
                  });
                  window.location.href = r.url;
                })
              }
            >
              Download {latest.fileName}
            </button>
          )}
          {can.work && (
            <label className="cursor-pointer rounded-md px-2 py-1 text-xs ring-1 ring-slate-300 hover:bg-slate-50">
              {doc.status === 'MISSING' ? 'Upload' : 'Replace'}
              <input
                type="file"
                className="sr-only"
                aria-label={`Upload ${doc.type?.label}`}
                accept="application/pdf,image/jpeg,image/png,image/webp"
                disabled={busy}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  const form = new FormData();
                  form.append('file', f);
                  void run(async () => {
                    await api(`/admissions/${admissionId}/documents/${doc.documentTypeId}`, {
                      method: 'POST',
                      body: form,
                    });
                    onChanged();
                  });
                }}
              />
            </label>
          )}
          {can.manage && doc.status === 'UPLOADED' && (
            <>
              <Button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api(`/admission-documents/${doc.id}/verify`, { method: 'POST' });
                    onChanged();
                  })
                }
              >
                Verify
              </Button>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  const reason = window.prompt('Why reject this document?');
                  if (reason && reason.trim().length >= 3)
                    void run(async () => {
                      await api(`/admission-documents/${doc.id}/reject`, {
                        method: 'POST',
                        body: { reason },
                      });
                      onChanged();
                    });
                }}
              >
                Reject
              </Button>
            </>
          )}
        </span>
      </div>
      <ErrorText error={error} />
    </li>
  );
}

function StudentProfile({ admission, onSaved }: { admission: AdmissionView; onSaved: () => void }) {
  const s = admission.student;
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({
    legalName: s.legalName,
    dateOfBirth: s.dateOfBirth?.slice(0, 10) ?? '',
    guardianName: s.guardianName ?? '',
    guardianPhone: '',
    idType: s.idType ?? '',
    idNumber: '',
  });
  const { busy, error, run } = useAction();
  return (
    <div className="mt-4 rounded-md bg-slate-50 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Student: {s.legalName}</span>
        <span className="text-slate-500">
          {s.dateOfBirth ? `born ${s.dateOfBirth.slice(0, 10)}` : 'date of birth not set'}
          {s.idType ? ` · ${s.idType} ${s.idNumber ?? ''}` : ''}
          {s.guardianName ? ` · guardian ${s.guardianName}` : ''}
        </span>
        {admission.can.work && (
          <Button variant="secondary" className="ml-auto" onClick={() => setOpen((x) => !x)}>
            {open ? 'Close' : 'Edit student'}
          </Button>
        )}
      </div>
      {open && (
        <form
          className="mt-3 grid gap-3 sm:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api(`/admissions/${admission.id}/student`, {
                method: 'PATCH',
                body: {
                  legalName: f.legalName,
                  dateOfBirth: f.dateOfBirth || null,
                  guardianName: f.guardianName || null,
                  ...(f.guardianPhone ? { guardianPhone: f.guardianPhone } : {}),
                  idType: f.idType || null,
                  ...(f.idNumber ? { idNumber: f.idNumber } : {}),
                },
              });
              setOpen(false);
              onSaved();
            });
          }}
        >
          <Field label="Legal name">
            <Input
              required
              value={f.legalName}
              onChange={(e) => setF({ ...f, legalName: e.target.value })}
            />
          </Field>
          <Field label="Date of birth">
            <Input
              type="date"
              value={f.dateOfBirth}
              onChange={(e) => setF({ ...f, dateOfBirth: e.target.value })}
            />
          </Field>
          <Field label="Guardian name">
            <Input
              value={f.guardianName}
              onChange={(e) => setF({ ...f, guardianName: e.target.value })}
            />
          </Field>
          <Field label="Guardian phone (leave empty to keep)">
            <Input
              value={f.guardianPhone}
              onChange={(e) => setF({ ...f, guardianPhone: e.target.value })}
            />
          </Field>
          <Field label="ID type">
            <Select value={f.idType} onChange={(e) => setF({ ...f, idType: e.target.value })}>
              <option value="">—</option>
              <option>Aadhaar</option>
              <option>Emirates ID</option>
              <option>Passport</option>
              <option>Other</option>
            </Select>
          </Field>
          <Field label="ID number (leave empty to keep)">
            <Input value={f.idNumber} onChange={(e) => setF({ ...f, idNumber: e.target.value })} />
          </Field>
          <div className="sm:col-span-3">
            <ErrorText error={error} />
            <Button type="submit" disabled={busy}>
              Save student
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
