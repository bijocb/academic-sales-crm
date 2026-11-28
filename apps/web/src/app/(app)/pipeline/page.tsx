'use client';
import Link from 'next/link';
import { useState } from 'react';
import { SavedViews } from '@/components/pipeline-tools';
import { Badge, ErrorText, PageHeader, Select, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import type { Brand } from '@/lib/types';

interface Card {
  id: string;
  leadNumber: string;
  name: string;
  course: string | null;
  ownerName: string | null;
  interestLevel: 'HOT' | 'WARM' | 'COLD' | null;
  daysInStage: number;
  nextTaskDue: string | null;
  overdue: boolean;
}
interface Board {
  columns: Array<{ key: string; label: string; count: number; leads: Card[] }>;
}
const INTEREST_TONE = { HOT: 'red', WARM: 'amber', COLD: 'slate' } as const;

export default function PipelinePage() {
  const brands = useLoad(() => api<Brand[]>('/brands'));
  const [brandId, setBrandId] = useState('');
  const [mine, setMine] = useState('false');
  const board = useLoad(
    () => api<Board>(`/pipeline?mine=${mine}${brandId ? `&brandId=${brandId}` : ''}`),
    [brandId, mine],
  );
  return (
    <>
      <PageHeader
        title="Pipeline"
        description="Open leads by stage. Open a lead to move it — each stage checks its required details."
        actions={
          <div className="flex gap-2">
            <Select
              aria-label="Brand"
              className="w-52"
              value={brandId}
              onChange={(e) => setBrandId(e.target.value)}
            >
              <option value="">All my brands</option>
              {brands.data?.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
            <Select
              aria-label="Whose leads"
              className="w-40"
              value={mine}
              onChange={(e) => setMine(e.target.value)}
            >
              <option value="false">All I can see</option>
              <option value="true">My leads</option>
            </Select>
          </div>
        }
      />
      <SavedViews
        page="pipeline"
        current={{ brandId, mine: mine === 'true' ? 'true' : '' }}
        onApply={(f) => {
          setBrandId(f.brandId ?? '');
          setMine(f.mine === 'true' ? 'true' : 'false');
        }}
      />
      <ErrorText error={board.error} />
      <div className="flex gap-3 overflow-x-auto pb-4">
        {board.data?.columns.map((c) => (
          <section
            key={c.key}
            className="w-64 shrink-0 rounded-lg bg-slate-100 p-2"
            aria-label={c.label}
          >
            <h2 className="mb-2 flex items-center justify-between px-1 text-sm font-semibold text-slate-700">
              {c.label}
              <span className="rounded-full bg-white px-2 text-xs font-medium text-slate-600">
                {c.count}
              </span>
            </h2>
            <ul className="space-y-2">
              {c.leads.map((l) => (
                <li key={l.id}>
                  <Link
                    href={`/leads/${l.id}`}
                    className="block rounded-md bg-white p-2 text-sm shadow-sm ring-1 ring-slate-200 hover:ring-brand-400"
                  >
                    <span className="block font-medium">{l.name}</span>
                    <span className="block font-mono text-xs text-slate-500">{l.leadNumber}</span>
                    {l.course && <span className="block text-xs text-slate-600">{l.course}</span>}
                    <span className="mt-1 flex flex-wrap items-center gap-1 text-xs text-slate-500">
                      {l.interestLevel && (
                        <Badge tone={INTEREST_TONE[l.interestLevel]}>
                          {l.interestLevel.toLowerCase()}
                        </Badge>
                      )}
                      {l.overdue && <Badge tone="red">task overdue</Badge>}
                      <span>{l.ownerName ?? 'unassigned'}</span>
                      <span>· {l.daysInStage}d in stage</span>
                    </span>
                  </Link>
                </li>
              ))}
              {c.count > c.leads.length && (
                <li className="px-1 text-xs text-slate-700">
                  +{c.count - c.leads.length} more — use the leads list
                </li>
              )}
            </ul>
          </section>
        ))}
      </div>
    </>
  );
}
