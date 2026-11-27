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
  statusTone,
  useAction,
  useLoad,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';

interface Org {
  id: string;
  name: string;
  slug: string;
  country: string;
  timezone: string;
  currency: string;
  status: 'ACTIVE' | 'SUSPENDED';
  createdAt: string;
  _count: { brands: number; users: number };
}

export default function PlatformPage() {
  const { me } = useSession();
  const orgs = useLoad(() =>
    me.user.isPlatformAdmin ? api<Org[]>('/platform/organizations') : Promise.resolve([]),
  );
  const [form, setForm] = useState({
    name: '',
    slug: '',
    country: 'IN',
    adminName: '',
    adminEmail: '',
  });
  const [reason, setReason] = useState('');
  const create = useAction();
  const status = useAction();

  if (!me.user.isPlatformAdmin)
    return <p className="text-sm text-slate-500">Platform administrators only.</p>;
  return (
    <>
      <PageHeader
        title="Organizations"
        description="Each organization is an isolated tenant with its own brands, users and data."
      />
      <Card title="New organization">
        <form
          className="grid gap-4 sm:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault();
            void create.run(async () => {
              await api('/platform/organizations', {
                method: 'POST',
                body: {
                  name: form.name,
                  slug: form.slug,
                  country: form.country,
                  admin: { name: form.adminName, email: form.adminEmail },
                },
              });
              setForm({ name: '', slug: '', country: 'IN', adminName: '', adminEmail: '' });
              await orgs.reload();
            });
          }}
        >
          <Field label="Organization name">
            <Input
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
          <Field label="Slug" hint="lower-case, e.g. abc-education">
            <Input
              required
              value={form.slug}
              onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase() })}
            />
          </Field>
          <Field label="Home country">
            <Select
              value={form.country}
              onChange={(e) => setForm({ ...form, country: e.target.value })}
            >
              <option value="IN">India</option>
              <option value="AE">UAE</option>
            </Select>
          </Field>
          <Field label="First admin name">
            <Input
              required
              value={form.adminName}
              onChange={(e) => setForm({ ...form, adminName: e.target.value })}
            />
          </Field>
          <Field label="First admin email" hint="Receives the invitation">
            <Input
              type="email"
              required
              value={form.adminEmail}
              onChange={(e) => setForm({ ...form, adminEmail: e.target.value })}
            />
          </Field>
          <div className="flex items-end">
            <Button type="submit" disabled={create.busy}>
              Create organization
            </Button>
          </div>
          <div className="sm:col-span-3">
            <ErrorText error={create.error} />
          </div>
        </form>
      </Card>
      <div className="mt-6">
        <Card
          title="All organizations"
          actions={
            <Input
              placeholder="Reason for suspend/activate"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-72"
            />
          }
        >
          <ErrorText error={orgs.error ?? status.error} />
          <Table
            head={['Name', 'Slug', 'Country', 'Brands', 'Users', 'Status', '']}
            empty={orgs.data?.length === 0}
          >
            {orgs.data?.map((o) => (
              <tr key={o.id}>
                <Td className="font-medium">{o.name}</Td>
                <Td>{o.slug}</Td>
                <Td>
                  {o.country} · {o.currency}
                </Td>
                <Td>{o._count.brands}</Td>
                <Td>{o._count.users}</Td>
                <Td>
                  <Badge tone={statusTone(o.status)}>{o.status}</Badge>
                </Td>
                <Td>
                  <Button
                    variant={o.status === 'ACTIVE' ? 'danger' : 'secondary'}
                    disabled={status.busy}
                    onClick={() =>
                      void status.run(async () => {
                        if (reason.trim().length < 3) throw new Error('Enter a reason first.');
                        await api(
                          `/platform/organizations/${o.id}/${o.status === 'ACTIVE' ? 'suspend' : 'activate'}`,
                          { method: 'POST', body: { reason } },
                        );
                        setReason('');
                        await orgs.reload();
                      })
                    }
                  >
                    {o.status === 'ACTIVE' ? 'Suspend' : 'Activate'}
                  </Button>
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>
    </>
  );
}
