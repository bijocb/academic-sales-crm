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
import { sheetScript } from '@/lib/sheet-script';
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
          {can('integration.manage') && <MetaConnections brandId={brandId} />}
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
    <Card title="Intake keys (website, landing pages, Google Ads lead forms, Google Sheets)">
      {created && (
        <div className="mb-4 space-y-2 rounded-md bg-amber-50 p-3 text-sm ring-1 ring-amber-200">
          <p className="font-medium">Copy this key now — it will not be shown again.</p>
          <code className="block break-all rounded bg-white p-2 ring-1 ring-amber-200">
            {created.key}
          </code>
          {created.channel === 'GOOGLE_SHEETS' ? (
            <div className="space-y-2">
              <p>
                In the Google Sheet: <strong>Extensions → Apps Script</strong>, replace the code
                with the script below, <strong>Save</strong>, then run <strong>setup</strong> once
                and allow access. New rows are sent every 5 minutes (and at once for a linked Google
                Form). Row 1 must hold the headers (Name, Phone, Email, Course, …).
              </p>
              <Button
                type="button"
                variant="secondary"
                onClick={() => void navigator.clipboard.writeText(sheetScript(origin, created.key))}
              >
                Copy Apps Script
              </Button>
              <pre
                aria-label="Google Apps Script"
                className="max-h-64 overflow-auto rounded bg-white p-2 text-xs ring-1 ring-amber-200"
              >
                {sheetScript(origin, created.key)}
              </pre>
            </div>
          ) : created.channel === 'GOOGLE_ADS' ? (
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

interface MetaConnectionRow {
  id: string;
  pageId: string;
  pageName: string;
  sourceId: string;
  status: 'ACTIVE' | 'PAUSED';
  subscribed: boolean;
  lastLeadAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
}

/** Facebook / Instagram Lead Ads pages (A-047). The page token is write-only. */
function MetaConnections({ brandId }: { brandId: string }) {
  const list = useLoad(
    () => api<MetaConnectionRow[]>(`/meta-connections?brandId=${brandId}`),
    [brandId],
  );
  const sources = useLoad(() => api<LeadSource[]>(`/lead-sources?brandId=${brandId}`), [brandId]);
  const metaSources = sources.data?.filter(
    (s) => s.channel === 'META_ADS' && s.status === 'ACTIVE',
  );
  const [f, setF] = useState({ pageId: '', pageName: '', sourceId: '', accessToken: '' });
  const [newToken, setNewToken] = useState<Record<string, string>>({});
  const { busy, error, run } = useAction();
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return (
    <Card title="Facebook & Instagram Lead Ads">
      <p className="mb-3 text-sm text-slate-600">
        Leads from Lead Ads forms arrive within seconds through Meta&apos;s webhook. Callback URL
        for the Meta app: <code className="break-all">{origin}/api/v1/webhooks/meta</code>. Connect
        each Facebook page with a page access token that has the <code>leads_retrieval</code> and{' '}
        <code>pages_manage_metadata</code> permissions; the token is stored encrypted and never
        shown again.
      </p>
      <ErrorText error={list.error} />
      <Table
        head={['Page', 'Source', 'Status', 'Last lead', 'Last problem', '']}
        empty={!list.data?.length}
      >
        {list.data?.map((c) => (
          <tr key={c.id}>
            <Td>
              <span className="font-medium">{c.pageName}</span>
              <span className="block font-mono text-xs text-slate-500">{c.pageId}</span>
            </Td>
            <Td>{sources.data?.find((s) => s.id === c.sourceId)?.name ?? '—'}</Td>
            <Td>
              <Badge tone={c.status === 'ACTIVE' ? 'green' : 'amber'}>{c.status}</Badge>
            </Td>
            <Td>{c.lastLeadAt ? new Date(c.lastLeadAt).toLocaleString() : 'None yet'}</Td>
            <Td className="max-w-64 text-xs text-red-700">{c.lastError ?? '—'}</Td>
            <Td>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await api(`/meta-connections/${c.id}`, {
                        method: 'PATCH',
                        body: { status: c.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE' },
                      });
                      await list.reload();
                    })
                  }
                >
                  {c.status === 'ACTIVE' ? 'Pause' : 'Resume'}
                </Button>
                <Input
                  aria-label={`New page token for ${c.pageName}`}
                  className="w-40"
                  type="password"
                  placeholder="New token"
                  value={newToken[c.id] ?? ''}
                  onChange={(e) => setNewToken({ ...newToken, [c.id]: e.target.value })}
                />
                <Button
                  variant="secondary"
                  disabled={busy || !newToken[c.id]}
                  onClick={() =>
                    void run(async () => {
                      await api(`/meta-connections/${c.id}`, {
                        method: 'PATCH',
                        body: { accessToken: newToken[c.id] },
                      });
                      setNewToken({ ...newToken, [c.id]: '' });
                      await list.reload();
                    })
                  }
                >
                  Replace token
                </Button>
              </div>
            </Td>
          </tr>
        ))}
      </Table>
      <form
        className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api('/meta-connections', { method: 'POST', body: { ...f, brandId } });
            setF({ pageId: '', pageName: '', sourceId: '', accessToken: '' });
            await list.reload();
          });
        }}
      >
        <Field label="Facebook page name">
          <Input
            required
            value={f.pageName}
            onChange={(e) => setF({ ...f, pageName: e.target.value })}
          />
        </Field>
        <Field label="Page ID">
          <Input
            required
            inputMode="numeric"
            value={f.pageId}
            onChange={(e) => setF({ ...f, pageId: e.target.value })}
          />
        </Field>
        <Field label="Leads arrive as source">
          <Select
            aria-label="Meta source"
            required
            value={f.sourceId}
            onChange={(e) => setF({ ...f, sourceId: e.target.value })}
          >
            <option value="">Select…</option>
            {metaSources?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Page access token">
          <Input
            required
            type="password"
            autoComplete="off"
            value={f.accessToken}
            onChange={(e) => setF({ ...f, accessToken: e.target.value })}
          />
        </Field>
        <div className="flex items-end">
          <Button type="submit" disabled={busy}>
            Connect page
          </Button>
        </div>
      </form>
      <div className="mt-2">
        <ErrorText error={error} />
      </div>
    </Card>
  );
}
