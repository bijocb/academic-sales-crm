'use client';
import { useState } from 'react';
import { DEFAULT_TIMEZONE } from '@crm/contracts';
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
import type { Branch, Brand } from '@/lib/types';

type Country = 'IN' | 'AE';

export default function BrandsPage() {
  const { canOrgWide, can } = useSession();
  const brands = useLoad(() => api<Brand[]>('/brands'));
  const branches = useLoad(() => api<Branch[]>('/branches'));
  const [showCreate, setShowCreate] = useState(false);

  return (
    <>
      <PageHeader
        title="Brands & branches"
        description="Each brand has its own country, time zone and currency."
        actions={
          canOrgWide('brand.manage') && (
            <Button onClick={() => setShowCreate((s) => !s)}>
              {showCreate ? 'Close' : 'New brand'}
            </Button>
          )
        }
      />
      {showCreate && (
        <div className="mb-6">
          <CreateBrand
            onDone={() => {
              setShowCreate(false);
              void brands.reload();
            }}
          />
        </div>
      )}
      <ErrorText error={brands.error} />
      <div className="space-y-4">
        {brands.data?.map((b) => (
          <BrandCard
            key={b.id}
            brand={b}
            branches={(branches.data ?? []).filter((x) => x.brandId === b.id)}
            canAddBranch={can('branch.manage')}
            canEditBrand={can('brand.manage')}
            onChanged={() => void branches.reload()}
            onBrandChanged={() => void brands.reload()}
          />
        ))}
        {brands.data?.length === 0 && <p className="text-sm text-slate-500">No brands yet.</p>}
      </div>
    </>
  );
}

function CreateBrand({ onDone }: { onDone: () => void }) {
  const [form, setForm] = useState({ name: '', code: '', country: 'IN' as Country });
  const { busy, error, run } = useAction();
  return (
    <Card title="New brand">
      <form
        className="grid gap-4 sm:grid-cols-4"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api('/brands', { method: 'POST', body: form });
            onDone();
          });
        }}
      >
        <Field label="Name">
          <Input
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </Field>
        <Field label="Code" hint="e.g. ACAD-IN">
          <Input
            required
            value={form.code}
            onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
          />
        </Field>
        <Field label="Country" hint={`Time zone ${DEFAULT_TIMEZONE[form.country]}`}>
          <Select
            value={form.country}
            onChange={(e) => setForm({ ...form, country: e.target.value as Country })}
          >
            <option value="IN">India (INR)</option>
            <option value="AE">UAE (AED)</option>
          </Select>
        </Field>
        <div className="flex items-end">
          <Button type="submit" disabled={busy}>
            Create brand
          </Button>
        </div>
        <div className="sm:col-span-4">
          <ErrorText error={error} />
        </div>
      </form>
    </Card>
  );
}

function BrandCard({
  brand,
  branches,
  canAddBranch,
  canEditBrand,
  onChanged,
  onBrandChanged,
}: {
  brand: Brand;
  branches: Branch[];
  canAddBranch: boolean;
  canEditBrand: boolean;
  onChanged: () => void;
  onBrandChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', code: '', city: '' });
  const { busy, error, run } = useAction();
  return (
    <Card
      title={`${brand.name} · ${brand.code}`}
      actions={
        <div className="flex items-center gap-2">
          <Badge tone="blue">{brand.country === 'IN' ? 'India' : 'UAE'}</Badge>
          <Badge>{brand.timezone}</Badge>
          <Badge>{brand.currency}</Badge>
          <Badge tone={statusTone(brand.status)}>{brand.status}</Badge>
        </div>
      }
    >
      <BrandContact brand={brand} canEdit={canEditBrand} onSaved={onBrandChanged} />
      <Table head={['Branch', 'Code', 'City', 'Time zone', 'Status']} empty={branches.length === 0}>
        {branches.map((br) => (
          <tr key={br.id}>
            <Td>{br.name}</Td>
            <Td>{br.code}</Td>
            <Td>{br.city ?? '—'}</Td>
            <Td>{br.timezone}</Td>
            <Td>
              <Badge tone={statusTone(br.status)}>{br.status}</Badge>
            </Td>
          </tr>
        ))}
      </Table>
      {canAddBranch && (
        <div className="mt-4">
          {adding ? (
            <form
              className="grid gap-3 sm:grid-cols-4"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await api('/branches', {
                    method: 'POST',
                    body: {
                      ...form,
                      city: form.city || undefined,
                      brandId: brand.id,
                      country: brand.country,
                    },
                  });
                  setForm({ name: '', code: '', city: '' });
                  setAdding(false);
                  onChanged();
                });
              }}
            >
              <Field label="Branch name">
                <Input
                  required
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </Field>
              <Field label="Code">
                <Input
                  required
                  value={form.code}
                  onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
                />
              </Field>
              <Field label="City">
                <Input
                  value={form.city}
                  onChange={(e) => setForm({ ...form, city: e.target.value })}
                />
              </Field>
              <div className="flex items-end gap-2">
                <Button type="submit" disabled={busy}>
                  Add
                </Button>
                <Button type="button" variant="secondary" onClick={() => setAdding(false)}>
                  Cancel
                </Button>
              </div>
              <div className="sm:col-span-4">
                <ErrorText error={error} />
              </div>
            </form>
          ) : (
            <Button variant="secondary" onClick={() => setAdding(true)}>
              Add branch
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

/** Contact details quoted in messages ({{brand_phone}}, {{brand_email}}, {{brand_website}}, {{brand_address}}). */
function BrandContact({
  brand,
  canEdit,
  onSaved,
}: {
  brand: Brand;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const [f, setF] = useState({
    contactPhone: brand.contactPhone ?? '',
    contactEmail: brand.contactEmail ?? '',
    website: brand.website ?? '',
    address: brand.address ?? '',
  });
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAction();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => {
    setSaved(false);
    setF({ ...f, [k]: e.target.value });
  };
  return (
    <form
      className="mb-4 grid gap-3 rounded-md bg-slate-50 p-3 sm:grid-cols-2 lg:grid-cols-5"
      aria-label={`${brand.name} contact details`}
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          await api(`/brands/${brand.id}`, {
            method: 'PATCH',
            body: {
              contactPhone: f.contactPhone || null,
              contactEmail: f.contactEmail || null,
              website: f.website || null,
              address: f.address || null,
            },
          });
          setSaved(true);
          onSaved();
        });
      }}
    >
      <p className="text-xs text-slate-600 sm:col-span-2 lg:col-span-5">
        Contact details used in messages to students (college details templates).
      </p>
      <Field label="Phone">
        <Input disabled={!canEdit} value={f.contactPhone} onChange={set('contactPhone')} />
      </Field>
      <Field label="Email">
        <Input
          disabled={!canEdit}
          type="email"
          value={f.contactEmail}
          onChange={set('contactEmail')}
        />
      </Field>
      <Field label="Website">
        <Input
          disabled={!canEdit}
          type="url"
          placeholder="https://"
          value={f.website}
          onChange={set('website')}
        />
      </Field>
      <Field label="Address">
        <Input disabled={!canEdit} value={f.address} onChange={set('address')} />
      </Field>
      {canEdit && (
        <div className="flex items-end gap-2">
          <Button type="submit" variant="secondary" disabled={busy}>
            Save contacts
          </Button>
          {saved && <span className="text-xs text-green-700">Saved</span>}
        </div>
      )}
      <div className="sm:col-span-2 lg:col-span-5">
        <ErrorText error={error} />
      </div>
    </form>
  );
}
