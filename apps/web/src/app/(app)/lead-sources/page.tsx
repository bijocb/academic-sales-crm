'use client';
import { useState } from 'react';
import { LEAD_CHANNELS } from '@crm/contracts';
import { BrandPicker } from '@/components/brand-picker';
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
  statusTone,
  useAction,
  useLoad,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { Brand, Campaign, IntakeKeyRow, LeadSource } from '@/lib/types';

export default function LeadSourcesPage() {
  const { can } = useSession();
  const brands = useLoad(() => api<Brand[]>('/brands'));
  const [brandId, setBrandId] = useState('');
  return (
    <>
      <PageHeader
        title="Sources & campaigns"
        description="Where leads come from. Every enquiry keeps its original source and campaign permanently."
      />
      {brands.data && (
        <div className="mb-6">
          <BrandPicker brands={brands.data} value={brandId} onChange={setBrandId} />
        </div>
      )}
      {brandId && (
        <div className="space-y-6" key={brandId}>
          <Sources brandId={brandId} canEdit={can('campaign.manage')} />
          <Campaigns brandId={brandId} canEdit={can('campaign.manage')} />
          {can('integration.manage') && <Keys brandId={brandId} />}
        </div>
      )}
    </>
  );
}

function Sources({ brandId, canEdit }: { brandId: string; canEdit: boolean }) {
  const list = useLoad(() => api<LeadSource[]>(`/lead-sources?brandId=${brandId}`), [brandId]);
  const [f, setF] = useState({ name: '', channel: 'OTHER', isPaid: false });
  const { busy, error, run } = useAction();
  return (
    <Card title="Lead sources">
      <Table head={['Source', 'Channel', 'Paid', 'Status', '']} empty={list.data?.length === 0}>
        {list.data?.map((s) => (
          <tr key={s.id}>
            <Td className="font-medium">{s.name}</Td>
            <Td>
              <Badge>{s.channel}</Badge>
            </Td>
            <Td>{s.isPaid ? 'Paid' : 'Organic'}</Td>
            <Td>
              <Badge tone={statusTone(s.status)}>{s.status}</Badge>
            </Td>
            <Td>
              {canEdit && (
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await api(`/lead-sources/${s.id}`, {
                        method: 'PATCH',
                        body: { status: s.status === 'ACTIVE' ? 'ARCHIVED' : 'ACTIVE' },
                      });
                      await list.reload();
                    })
                  }
                >
                  {s.status === 'ACTIVE' ? 'Archive' : 'Restore'}
                </Button>
              )}
            </Td>
          </tr>
        ))}
      </Table>
      {canEdit && (
        <form
          className="mt-4 flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api('/lead-sources', { method: 'POST', body: { brandId, ...f } });
              setF({ name: '', channel: 'OTHER', isPaid: false });
              await list.reload();
            });
          }}
        >
          <div className="w-56">
            <Field label="Name">
              <Input
                required
                value={f.name}
                onChange={(e) => setF({ ...f, name: e.target.value })}
              />
            </Field>
          </div>
          <div className="w-44">
            <Field label="Channel">
              <Select value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}>
                {LEAD_CHANNELS.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </Select>
            </Field>
          </div>
          <label className="flex items-center gap-2 pb-2 text-sm">
            <input
              type="checkbox"
              checked={f.isPaid}
              onChange={(e) => setF({ ...f, isPaid: e.target.checked })}
            />{' '}
            Paid
          </label>
          <Button type="submit" variant="secondary" disabled={busy}>
            Add source
          </Button>
        </form>
      )}
      <div className="mt-2">
        <ErrorText error={error} />
      </div>
    </Card>
  );
}

function Campaigns({ brandId, canEdit }: { brandId: string; canEdit: boolean }) {
  const list = useLoad(() => api<Campaign[]>(`/campaigns?brandId=${brandId}`), [brandId]);
  const sources = useLoad(() => api<LeadSource[]>(`/lead-sources?brandId=${brandId}`), [brandId]);
  const [f, setF] = useState({ name: '', utmCampaign: '', sourceId: '' });
  const { busy, error, run } = useAction();
  return (
    <Card
      title="Campaigns"
      actions={
        <span className="text-xs text-slate-500">
          Enquiries are linked automatically when their utm_campaign matches
        </span>
      }
    >
      <Table
        head={['Campaign', 'UTM campaign', 'Source', 'Status']}
        empty={list.data?.length === 0}
      >
        {list.data?.map((c) => (
          <tr key={c.id}>
            <Td className="font-medium">{c.name}</Td>
            <Td className="font-mono text-xs">{c.utmCampaign ?? '—'}</Td>
            <Td>{c.source?.name ?? '—'}</Td>
            <Td>
              <Badge tone={statusTone(c.status)}>{c.status}</Badge>
            </Td>
          </tr>
        ))}
      </Table>
      {canEdit && (
        <form
          className="mt-4 flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api('/campaigns', {
                method: 'POST',
                body: {
                  brandId,
                  name: f.name,
                  utmCampaign: f.utmCampaign || undefined,
                  sourceId: f.sourceId || undefined,
                },
              });
              setF({ name: '', utmCampaign: '', sourceId: '' });
              await list.reload();
            });
          }}
        >
          <div className="w-56">
            <Field label="Name">
              <Input
                required
                value={f.name}
                onChange={(e) => setF({ ...f, name: e.target.value })}
              />
            </Field>
          </div>
          <div className="w-48">
            <Field label="utm_campaign">
              <Input
                value={f.utmCampaign}
                onChange={(e) => setF({ ...f, utmCampaign: e.target.value })}
              />
            </Field>
          </div>
          <div className="w-48">
            <Field label="Source">
              <Select value={f.sourceId} onChange={(e) => setF({ ...f, sourceId: e.target.value })}>
                <option value="">—</option>
                {sources.data?.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Button type="submit" variant="secondary" disabled={busy}>
            Add campaign
          </Button>
        </form>
      )}
      <div className="mt-2">
        <ErrorText error={error} />
      </div>
    </Card>
  );
}

function Keys({ brandId }: { brandId: string }) {
  const list = useLoad(() => api<IntakeKeyRow[]>(`/intake-keys?brandId=${brandId}`), [brandId]);
  const sources = useLoad(() => api<LeadSource[]>(`/lead-sources?brandId=${brandId}`), [brandId]);
  const [f, setF] = useState({ name: '', sourceId: '' });
  const [created, setCreated] = useState<{ id: string; key: string; channel: string } | null>(null);
  const { busy, error, run } = useAction();
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return (
    <Card title="Intake keys (website, landing pages, Google Ads lead forms)">
      {created && (
        <div className="mb-4 space-y-2 rounded-md bg-amber-50 p-3 text-sm ring-1 ring-amber-200">
          <p className="font-medium">Copy this key now — it will not be shown again.</p>
          <code className="block break-all rounded bg-white p-2 ring-1 ring-amber-200">
            {created.key}
          </code>
          {created.channel === 'GOOGLE_ADS' ? (
            <p>
              In Google Ads lead form → Webhook: URL{' '}
              <code className="break-all">
                {origin}/api/v1/webhooks/google-ads/{created.id}
              </code>{' '}
              and Key = the key above.
            </p>
          ) : (
            <pre className="overflow-x-auto rounded bg-white p-2 text-xs ring-1 ring-amber-200">{`curl -X POST ${origin}/api/v1/intake/leads \\
  -H "Authorization: Bearer ${created.key}" \\
  -H "Content-Type: application/json" \\
  -d '{"name":"Student Name","phone":"9876543210","email":"student@example.com","course":"Data Science","utm_source":"google","utm_campaign":"nov-intake"}'`}</pre>
          )}
        </div>
      )}
      <Table
        head={['Name', 'Source', 'Key', 'Last used', 'Status', '']}
        empty={list.data?.length === 0}
      >
        {list.data?.map((k) => (
          <tr key={k.id}>
            <Td className="font-medium">{k.name}</Td>
            <Td>{k.source.name}</Td>
            <Td className="font-mono text-xs">{k.keyPrefix}…</Td>
            <Td>{k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : 'Never'}</Td>
            <Td>
              {k.revokedAt ? <Badge tone="red">Revoked</Badge> : <Badge tone="green">Active</Badge>}
            </Td>
            <Td>
              {!k.revokedAt && (
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await api(`/intake-keys/${k.id}`, { method: 'DELETE' });
                      await list.reload();
                    })
                  }
                >
                  Revoke
                </Button>
              )}
            </Td>
          </tr>
        ))}
      </Table>
      <form
        className="mt-4 flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const res = await api<{ id: string; key: string }>('/intake-keys', {
              method: 'POST',
              body: f,
            });
            setCreated({
              ...res,
              channel: sources.data?.find((s) => s.id === f.sourceId)?.channel ?? '',
            });
            setF({ name: '', sourceId: '' });
            await list.reload();
          });
        }}
      >
        <div className="w-56">
          <Field label="Key name">
            <Input
              required
              value={f.name}
              onChange={(e) => setF({ ...f, name: e.target.value })}
              placeholder="e.g. Main website form"
            />
          </Field>
        </div>
        <div className="w-56">
          <Field label="Leads arrive as source">
            <Select
              required
              value={f.sourceId}
              onChange={(e) => setF({ ...f, sourceId: e.target.value })}
            >
              <option value="">Select…</option>
              {sources.data
                ?.filter((s) => s.status === 'ACTIVE')
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </Select>
          </Field>
        </div>
        <Button type="submit" disabled={busy}>
          Create key
        </Button>
      </form>
      <div className="mt-2">
        <ErrorText error={error} />
      </div>
    </Card>
  );
}
