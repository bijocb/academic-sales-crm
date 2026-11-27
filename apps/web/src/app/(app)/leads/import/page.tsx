'use client';
import { useState } from 'react';
import { IMPORT_FIELDS, MAX_IMPORT_ROWS_PER_REQUEST, type ImportField } from '@crm/contracts';
import { BrandPicker } from '@/components/brand-picker';
import {
  Badge,
  Button,
  Card,
  ErrorText,
  Field,
  PageHeader,
  Select,
  Table,
  Td,
  useAction,
  useLoad,
} from '@/components/ui';
import { api } from '@/lib/api';
import { applyMapping, FIELD_LABELS, guessMapping, toCsv } from '@/lib/import-mapping';
import type { Brand, FieldIssue, LeadSource } from '@/lib/types';

type Sheet = { fileName: string; headers: string[]; rows: Array<Record<string, string>> };
type RowResult = {
  rowNumber: number;
  outcome: string;
  replay?: boolean;
  leadNumber?: string;
  errors: FieldIssue[];
};
const MAX_ROWS = 20_000;

async function readFile(file: File): Promise<Sheet> {
  if (/\.xlsx$/i.test(file.name)) {
    const { default: readXlsx } = await import('read-excel-file');
    const grid = await readXlsx(file);
    const headers = (grid[0] ?? []).map((h, i) => String(h ?? `Column ${i + 1}`).trim());
    const rows = grid
      .slice(1)
      .map((r) =>
        Object.fromEntries(
          headers.map((h, i) => [
            h,
            r[i] instanceof Date ? (r[i] as Date).toISOString() : r[i] == null ? '' : String(r[i]),
          ]),
        ),
      );
    return { fileName: file.name, headers, rows };
  }
  const Papa = (await import('papaparse')).default;
  const text = await file.text();
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.trim(),
  });
  return { fileName: file.name, headers: parsed.meta.fields ?? [], rows: parsed.data };
}

export default function ImportPage() {
  const brands = useLoad(() => api<Brand[]>('/brands'));
  const [brandId, setBrandId] = useState('');
  const sources = useLoad(
    () => (brandId ? api<LeadSource[]>(`/lead-sources?brandId=${brandId}`) : Promise.resolve([])),
    [brandId],
  );
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [mapping, setMapping] = useState<Record<string, ImportField | ''>>({});
  const [sourceId, setSourceId] = useState('');
  const [policy, setPolicy] = useState<'ADD_ENQUIRY' | 'SKIP_EXISTING'>('ADD_ENQUIRY');
  const [preview, setPreview] = useState<{
    summary: { valid: number; invalid: number; existing: number };
    results: Array<{ rowNumber: number; ok: boolean; errors: FieldIssue[] }>;
  } | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [results, setResults] = useState<RowResult[] | null>(null);
  const load = useAction();
  const action = useAction();

  const mappedRows = () =>
    sheet ? sheet.rows.map((r, i) => ({ rowNumber: i + 2, data: applyMapping(r, mapping) })) : [];
  const mappedFields = new Set(Object.values(mapping).filter(Boolean));
  const reset = () => {
    setPreview(null);
    setResults(null);
    setProgress(null);
  };

  return (
    <>
      <PageHeader
        title="Import leads"
        description="Upload a CSV or Excel (.xlsx) file, match its columns, check it, then import. Rows that fail go to Rejected leads."
      />
      {brands.data && (
        <div className="mb-6">
          <BrandPicker
            brands={brands.data}
            value={brandId}
            onChange={(id) => {
              setBrandId(id);
              reset();
            }}
          />
        </div>
      )}

      <Card title="1 · Choose file">
        <input
          type="file"
          accept=".csv,.xlsx"
          aria-label="Lead file"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            void load.run(async () => {
              const s = await readFile(file);
              if (s.rows.length === 0) throw new Error('The file has no data rows.');
              if (s.rows.length > MAX_ROWS)
                throw new Error(`Please split files over ${MAX_ROWS.toLocaleString()} rows.`);
              setSheet(s);
              setMapping(guessMapping(s.headers));
              reset();
            });
          }}
        />
        {sheet && (
          <p className="mt-2 text-sm text-slate-600">
            {sheet.fileName}: {sheet.rows.length} rows, {sheet.headers.length} columns
          </p>
        )}
        <div className="mt-2">
          <ErrorText error={load.error} />
        </div>
      </Card>

      {sheet && (
        <div className="mt-6">
          <Card
            title="2 · Match columns"
            actions={
              <span className="text-xs text-slate-500">Name and mobile or email are required</span>
            }
          >
            <Table head={['Column in file', 'Example', 'Import as']}>
              {sheet.headers.map((h) => (
                <tr key={h}>
                  <Td className="font-medium">{h}</Td>
                  <Td className="max-w-xs truncate text-slate-500">
                    {sheet.rows.find((r) => r[h])?.[h] ?? ''}
                  </Td>
                  <Td>
                    <Select
                      aria-label={`Map ${h}`}
                      value={mapping[h] ?? ''}
                      onChange={(e) => {
                        setMapping({ ...mapping, [h]: e.target.value as ImportField });
                        reset();
                      }}
                      className="w-56"
                    >
                      <option value="">Do not import</option>
                      {IMPORT_FIELDS.map((f) => (
                        <option
                          key={f}
                          value={f}
                          disabled={mapping[h] !== f && mappedFields.has(f)}
                        >
                          {FIELD_LABELS[f]}
                        </option>
                      ))}
                    </Select>
                  </Td>
                </tr>
              ))}
            </Table>
            <div className="mt-4 grid gap-4 sm:grid-cols-3">
              <Field label="Source for these leads">
                <Select value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
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
              <Field
                label="If the person already has an open lead"
                hint="Their original source is always kept"
              >
                <Select value={policy} onChange={(e) => setPolicy(e.target.value as 'ADD_ENQUIRY')}>
                  <option value="ADD_ENQUIRY">Add this as a new enquiry</option>
                  <option value="SKIP_EXISTING">Skip the row</option>
                </Select>
              </Field>
            </div>
            <div className="mt-4 flex gap-3">
              <Button
                variant="secondary"
                disabled={action.busy || !brandId || !mappedFields.has('name')}
                onClick={() =>
                  void action.run(async () => {
                    const rows = mappedRows().slice(0, MAX_IMPORT_ROWS_PER_REQUEST);
                    setPreview(
                      await api('/lead-imports/validate', {
                        method: 'POST',
                        body: { brandId, rows },
                      }),
                    );
                  })
                }
              >
                Check {Math.min(sheet.rows.length, MAX_IMPORT_ROWS_PER_REQUEST)} rows
              </Button>
              <Button
                disabled={action.busy || !brandId || !mappedFields.has('name') || !!results}
                onClick={() =>
                  void action.run(async () => {
                    const rows = mappedRows();
                    const imp = await api<{ id: string }>('/lead-imports', {
                      method: 'POST',
                      body: {
                        brandId,
                        sourceId: sourceId || undefined,
                        fileName: sheet.fileName,
                        duplicatePolicy: policy,
                        totalRows: rows.length,
                      },
                    });
                    const all: RowResult[] = [];
                    setProgress({ done: 0, total: rows.length });
                    for (let i = 0; i < rows.length; i += MAX_IMPORT_ROWS_PER_REQUEST) {
                      const chunk = rows.slice(i, i + MAX_IMPORT_ROWS_PER_REQUEST);
                      const res = await api<{ results: RowResult[] }>(
                        `/lead-imports/${imp.id}/rows`,
                        { method: 'POST', body: { rows: chunk } },
                      );
                      all.push(...res.results);
                      setProgress({
                        done: Math.min(i + chunk.length, rows.length),
                        total: rows.length,
                      });
                    }
                    await api(`/lead-imports/${imp.id}/complete`, { method: 'POST' });
                    setResults(all);
                  })
                }
              >
                Import {sheet.rows.length} rows
              </Button>
            </div>
            {progress && !results && (
              <p className="mt-3 text-sm text-slate-600">
                Importing… {progress.done} / {progress.total}
              </p>
            )}
            <div className="mt-3">
              <ErrorText error={action.error} />
            </div>
          </Card>
        </div>
      )}

      {preview && !results && (
        <div className="mt-6">
          <Card title="3 · Check results">
            <div className="flex flex-wrap gap-2 text-sm">
              <Badge tone="green">{preview.summary.valid} ready</Badge>
              <Badge tone="blue">{preview.summary.existing} already have an open lead</Badge>
              <Badge tone="red">{preview.summary.invalid} with problems</Badge>
            </div>
            <ProblemTable
              rows={preview.results
                .filter((r) => !r.ok)
                .map((r) => ({ rowNumber: r.rowNumber, errors: r.errors }))}
            />
          </Card>
        </div>
      )}

      {results && (
        <div className="mt-6">
          <Card title="Import finished">
            <div className="flex flex-wrap gap-2 text-sm">
              <Badge tone="green">
                {results.filter((r) => r.outcome === 'CREATED_LEAD').length} new leads
              </Badge>
              <Badge tone="blue">
                {results.filter((r) => r.outcome === 'ADDED_ENQUIRY').length} added to existing
                leads
              </Badge>
              <Badge>
                {results.filter((r) => r.outcome === 'SKIPPED_EXISTING').length} skipped
              </Badge>
              <Badge tone="red">
                {results.filter((r) => r.outcome === 'INVALID').length} sent to Rejected leads
              </Badge>
            </div>
            <ProblemTable rows={results.filter((r) => r.outcome === 'INVALID')} />
            {results.some((r) => r.outcome === 'INVALID') && sheet && (
              <Button
                variant="secondary"
                className="mt-4"
                onClick={() => {
                  const bad = new Map(
                    results
                      .filter((r) => r.outcome === 'INVALID')
                      .map((r) => [
                        r.rowNumber,
                        r.errors.map((e) => `${e.field}: ${e.message}`).join('; '),
                      ]),
                  );
                  const csv = toCsv(
                    sheet.rows
                      .map((r, i) => ({ row: i + 2, ...r, problem: bad.get(i + 2) ?? '' }))
                      .filter((r) => r.problem),
                  );
                  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = sheet.fileName.replace(/\.(csv|xlsx)$/i, '') + '-problems.csv';
                  a.click();
                  URL.revokeObjectURL(url);
                }}
              >
                Download problem rows
              </Button>
            )}
          </Card>
        </div>
      )}
    </>
  );
}

function ProblemTable({ rows }: { rows: Array<{ rowNumber: number; errors: FieldIssue[] }> }) {
  if (!rows.length) return null;
  return (
    <div className="mt-4">
      <Table head={['Row', 'Problem']}>
        {rows.slice(0, 100).map((r) => (
          <tr key={r.rowNumber}>
            <Td>{r.rowNumber}</Td>
            <Td>{r.errors.map((e) => e.message).join('; ')}</Td>
          </tr>
        ))}
      </Table>
      {rows.length > 100 && (
        <p className="mt-2 text-xs text-slate-500">Showing first 100 of {rows.length}.</p>
      )}
    </div>
  );
}
