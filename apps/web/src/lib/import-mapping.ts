import { IMPORT_FIELDS, type ImportField } from '@crm/contracts';

export const FIELD_LABELS: Record<ImportField, string> = {
  name: 'Full name',
  phone: 'Mobile / phone',
  email: 'Email',
  courseCode: 'Course code',
  course: 'Course (text)',
  city: 'City',
  language: 'Language',
  message: 'Notes / message',
  utm_source: 'UTM source',
  utm_medium: 'UTM medium',
  utm_campaign: 'UTM campaign',
  utm_term: 'UTM term',
  utm_content: 'UTM content',
  externalId: 'External ID',
  receivedAt: 'Enquiry date',
};

const SYNONYMS: Record<ImportField, string[]> = {
  name: ['name', 'full name', 'fullname', 'student name', 'candidate', 'lead name'],
  phone: [
    'phone',
    'mobile',
    'mobile number',
    'phone number',
    'contact',
    'contact number',
    'whatsapp',
  ],
  email: ['email', 'email id', 'e-mail', 'mail'],
  courseCode: ['course code'],
  course: ['course', 'program', 'programme', 'course interested', 'interested course'],
  city: ['city', 'location', 'place'],
  language: ['language'],
  message: ['message', 'notes', 'remarks', 'comments', 'query'],
  utm_source: ['utm_source', 'utm source', 'source'],
  utm_medium: ['utm_medium', 'utm medium', 'medium'],
  utm_campaign: ['utm_campaign', 'utm campaign', 'campaign'],
  utm_term: ['utm_term', 'utm term'],
  utm_content: ['utm_content', 'utm content'],
  externalId: ['id', 'lead id', 'external id', 'reference'],
  receivedAt: ['date', 'created', 'created at', 'enquiry date', 'submitted at', 'timestamp'],
};

const norm = (s: string) => s.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');

/** Best-guess column → field mapping from header names (each field used once). */
export function guessMapping(headers: string[]): Record<string, ImportField | ''> {
  const used = new Set<ImportField>();
  const out: Record<string, ImportField | ''> = {};
  for (const h of headers) {
    const n = norm(h);
    const hit = IMPORT_FIELDS.find((f) => !used.has(f) && SYNONYMS[f].some((s) => norm(s) === n));
    out[h] = hit ?? '';
    if (hit) used.add(hit);
  }
  return out;
}

export function applyMapping(
  row: Record<string, string>,
  mapping: Record<string, ImportField | ''>,
): Record<string, string> {
  const data: Record<string, string> = {};
  for (const [col, field] of Object.entries(mapping)) {
    if (field && row[col] != null && String(row[col]).trim() !== '')
      data[field] = String(row[col]).trim();
  }
  return data;
}

/** CSV text for the error report (Excel-safe quoting). */
export function toCsv(rows: Array<Record<string, string | number>>): string {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const q = (v: string | number) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return [headers.map(q).join(','), ...rows.map((r) => headers.map((h) => q(r[h])).join(','))].join(
    '\n',
  );
}
