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
import type { Brand } from '@/lib/types';

interface Template {
  id: string;
  brandId: string;
  channel: 'WHATSAPP' | 'EMAIL';
  name: string;
  language: string;
  subject: string | null;
  body: string;
  providerTemplateName: string | null;
  status: 'DRAFT' | 'APPROVED' | 'ARCHIVED';
}

const TONE = { DRAFT: 'amber', APPROVED: 'green', ARCHIVED: 'slate' } as const;

export default function TemplatesPage() {
  const brands = useLoad(() => api<Brand[]>('/brands'));
  const [brandId, setBrandId] = useState('');
  const bid = brandId || brands.data?.[0]?.id || '';
  const list = useLoad(
    () => (bid ? api<Template[]>(`/message-templates?brandId=${bid}`) : Promise.resolve([])),
    [bid],
  );
  const [f, setF] = useState({
    channel: 'WHATSAPP',
    name: '',
    language: 'en',
    subject: '',
    body: '',
    providerTemplateName: '',
  });
  const { busy, error, run } = useAction();
  const setStatus = (t: Template, status: Template['status']) =>
    run(async () => {
      await api(`/message-templates/${t.id}`, { method: 'PATCH', body: { status } });
      await list.reload();
    });

  return (
    <>
      <PageHeader
        title="Message templates"
        description="WhatsApp messages can only use approved templates. Placeholders: {{first_name}}, {{full_name}}, {{course}}, {{owner_name}}, {{brand}}."
        actions={
          <Select
            aria-label="Brand"
            className="w-56"
            value={bid}
            onChange={(e) => setBrandId(e.target.value)}
          >
            {brands.data?.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        }
      />
      <div className="space-y-6">
        <Card title="New template">
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await api('/message-templates', {
                  method: 'POST',
                  body: {
                    brandId: bid,
                    channel: f.channel,
                    name: f.name,
                    language: f.language,
                    subject: f.subject || undefined,
                    body: f.body,
                    providerTemplateName: f.providerTemplateName || undefined,
                  },
                });
                setF({ ...f, name: '', subject: '', body: '', providerTemplateName: '' });
                await list.reload();
              });
            }}
          >
            <div className="flex flex-wrap items-end gap-3">
              <div className="w-36">
                <Field label="Channel">
                  <Select
                    value={f.channel}
                    onChange={(e) => setF({ ...f, channel: e.target.value })}
                  >
                    <option value="WHATSAPP">WhatsApp</option>
                    <option value="EMAIL">Email</option>
                  </Select>
                </Field>
              </div>
              <div className="w-56">
                <Field label="Template name">
                  <Input
                    required
                    minLength={2}
                    value={f.name}
                    onChange={(e) => setF({ ...f, name: e.target.value })}
                  />
                </Field>
              </div>
              <div className="w-24">
                <Field label="Language">
                  <Input
                    value={f.language}
                    onChange={(e) => setF({ ...f, language: e.target.value })}
                  />
                </Field>
              </div>
              {f.channel === 'WHATSAPP' ? (
                <div className="w-64">
                  <Field label="Provider template name">
                    <Input
                      value={f.providerTemplateName}
                      onChange={(e) => setF({ ...f, providerTemplateName: e.target.value })}
                    />
                  </Field>
                </div>
              ) : (
                <div className="min-w-64 flex-1">
                  <Field label="Subject">
                    <Input
                      value={f.subject}
                      onChange={(e) => setF({ ...f, subject: e.target.value })}
                    />
                  </Field>
                </div>
              )}
            </div>
            <Field label="Text">
              <textarea
                className="w-full rounded-md border-0 px-3 py-2 text-sm ring-1 ring-slate-300"
                rows={4}
                required
                value={f.body}
                onChange={(e) => setF({ ...f, body: e.target.value })}
              />
            </Field>
            <ErrorText error={error} />
            <Button type="submit" disabled={busy || !bid}>
              Save as draft
            </Button>
          </form>
        </Card>
        <Card title="Templates">
          <ErrorText error={list.error} />
          <Table head={['Name', 'Channel', 'Text', 'Status', '']} empty={list.data?.length === 0}>
            {list.data?.map((t) => (
              <tr key={t.id}>
                <Td className="font-medium">
                  {t.name} <span className="text-xs text-slate-500">({t.language})</span>
                </Td>
                <Td>{t.channel === 'WHATSAPP' ? 'WhatsApp' : 'Email'}</Td>
                <Td className="max-w-md text-xs whitespace-pre-line text-slate-600">
                  {t.subject ? `${t.subject}\n` : ''}
                  {t.body}
                </Td>
                <Td>
                  <Badge tone={TONE[t.status]}>{t.status.toLowerCase()}</Badge>
                </Td>
                <Td className="whitespace-nowrap">
                  {t.status !== 'APPROVED' && (
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() => void setStatus(t, 'APPROVED')}
                    >
                      Approve
                    </Button>
                  )}{' '}
                  {t.status !== 'ARCHIVED' && (
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() => void setStatus(t, 'ARCHIVED')}
                    >
                      Archive
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>
    </>
  );
}
