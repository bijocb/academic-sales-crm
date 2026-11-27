'use client';
import { useState } from 'react';
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
import { formatMoney, toMinor } from '@/lib/format';
import { useSession } from '@/lib/session';
import type { Batch, Branch, Brand, Course, CourseCategory } from '@/lib/types';

const batchTone = (s: string) =>
  (({ OPEN: 'green', PLANNED: 'blue', CLOSED: 'slate', CANCELLED: 'red' }) as const)[s as 'OPEN'] ??
  'slate';

export default function CoursesPage() {
  const { can } = useSession();
  const brands = useLoad(() => api<Brand[]>('/brands'));
  const [brandId, setBrandId] = useState('');
  const brand = brands.data?.find((b) => b.id === brandId);
  const courses = useLoad(
    () => (brandId ? api<Course[]>(`/courses?brandId=${brandId}`) : Promise.resolve([])),
    [brandId],
  );
  const categories = useLoad(
    () =>
      brandId
        ? api<CourseCategory[]>(`/course-categories?brandId=${brandId}`)
        : Promise.resolve([]),
    [brandId],
  );
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const canManage = can('course.manage');

  return (
    <>
      <PageHeader
        title="Courses & batches"
        description="Each brand has its own catalogue. Fees are in the brand's currency."
        actions={
          canManage &&
          brandId && (
            <Button onClick={() => setAdding((a) => !a)}>{adding ? 'Close' : 'New course'}</Button>
          )
        }
      />
      {brands.data && (
        <div className="mb-6">
          <BrandPicker brands={brands.data} value={brandId} onChange={setBrandId} />
        </div>
      )}
      {adding && brand && (
        <div className="mb-6">
          <CreateCourse
            brand={brand}
            categories={categories.data ?? []}
            onCategory={() => void categories.reload()}
            onDone={() => {
              setAdding(false);
              void courses.reload();
            }}
          />
        </div>
      )}
      <ErrorText error={courses.error} />
      <Card>
        <Table
          head={['Course', 'Category', 'Mode', 'Duration', 'List fee', 'Batches', 'Status', '']}
          empty={courses.data?.length === 0}
        >
          {courses.data?.map((c) => (
            <tr key={c.id}>
              <Td>
                <span className="font-medium">{c.name}</span>
                <span className="block text-xs text-slate-500">{c.code}</span>
              </Td>
              <Td>{c.category?.name ?? '—'}</Td>
              <Td>{c.deliveryMode}</Td>
              <Td>
                {c.durationValue ? `${c.durationValue} ${c.durationUnit?.toLowerCase()}` : '—'}
              </Td>
              <Td className="tabular-nums">{formatMoney(c.listFeeMinor, c.currency)}</Td>
              <Td>{c._count?.batches ?? 0}</Td>
              <Td>
                <Badge tone={statusTone(c.status)}>{c.status}</Badge>
              </Td>
              <Td>
                <Button variant="secondary" onClick={() => setOpen(open === c.id ? null : c.id)}>
                  {open === c.id ? 'Hide' : 'Batches'}
                </Button>
              </Td>
            </tr>
          ))}
        </Table>
      </Card>
      {open && brand && (
        <div className="mt-6">
          <Batches
            course={courses.data!.find((c) => c.id === open)!}
            canManage={canManage}
            onChanged={() => void courses.reload()}
          />
        </div>
      )}
    </>
  );
}

function CreateCourse({
  brand,
  categories,
  onCategory,
  onDone,
}: {
  brand: Brand;
  categories: CourseCategory[];
  onCategory: () => void;
  onDone: () => void;
}) {
  const [f, setF] = useState({
    code: '',
    name: '',
    categoryId: '',
    deliveryMode: 'ONLINE',
    durationValue: '',
    durationUnit: 'MONTHS',
    fee: '',
    eligibility: '',
  });
  const [newCat, setNewCat] = useState({ name: '', code: '' });
  const { busy, error, run } = useAction();
  const cat = useAction();
  return (
    <Card title={`New course · ${brand.name}`}>
      <form
        className="grid gap-4 sm:grid-cols-4"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api('/courses', {
              method: 'POST',
              body: {
                brandId: brand.id,
                code: f.code,
                name: f.name,
                categoryId: f.categoryId || undefined,
                deliveryMode: f.deliveryMode,
                durationValue: f.durationValue ? Number(f.durationValue) : undefined,
                durationUnit: f.durationValue ? f.durationUnit : undefined,
                listFeeMinor: toMinor(f.fee) ?? undefined,
                eligibility: f.eligibility || undefined,
              },
            });
            onDone();
          });
        }}
      >
        <Field label="Course name">
          <Input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label="Code" hint="e.g. DS-PRO">
          <Input
            required
            value={f.code}
            onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })}
          />
        </Field>
        <Field label="Category">
          <Select value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })}>
            <option value="">—</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Delivery mode">
          <Select
            value={f.deliveryMode}
            onChange={(e) => setF({ ...f, deliveryMode: e.target.value })}
          >
            <option value="ONLINE">Online</option>
            <option value="OFFLINE">Offline</option>
            <option value="HYBRID">Hybrid</option>
          </Select>
        </Field>
        <Field label="Duration">
          <Input
            type="number"
            min={1}
            value={f.durationValue}
            onChange={(e) => setF({ ...f, durationValue: e.target.value })}
          />
        </Field>
        <Field label="Unit">
          <Select
            value={f.durationUnit}
            onChange={(e) => setF({ ...f, durationUnit: e.target.value })}
          >
            {['DAYS', 'WEEKS', 'MONTHS', 'YEARS'].map((u) => (
              <option key={u} value={u}>
                {u.toLowerCase()}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={`List fee (${brand.currency})`}>
          <Input
            type="number"
            min={0}
            step="0.01"
            value={f.fee}
            onChange={(e) => setF({ ...f, fee: e.target.value })}
          />
        </Field>
        <Field label="Eligibility">
          <Input
            value={f.eligibility}
            onChange={(e) => setF({ ...f, eligibility: e.target.value })}
          />
        </Field>
        <div className="sm:col-span-4">
          <ErrorText error={error} />
        </div>
        <div className="sm:col-span-4">
          <Button type="submit" disabled={busy}>
            Create course
          </Button>
        </div>
      </form>
      <div className="mt-6 border-t border-slate-200 pt-4">
        <p className="mb-2 text-sm font-medium text-slate-700">Add a category</p>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void cat.run(async () => {
              await api('/course-categories', {
                method: 'POST',
                body: { brandId: brand.id, ...newCat },
              });
              setNewCat({ name: '', code: '' });
              onCategory();
            });
          }}
        >
          <div className="w-56">
            <Field label="Name">
              <Input
                required
                value={newCat.name}
                onChange={(e) => setNewCat({ ...newCat, name: e.target.value })}
              />
            </Field>
          </div>
          <div className="w-40">
            <Field label="Code">
              <Input
                required
                value={newCat.code}
                onChange={(e) => setNewCat({ ...newCat, code: e.target.value.toUpperCase() })}
              />
            </Field>
          </div>
          <Button type="submit" variant="secondary" disabled={cat.busy}>
            Add category
          </Button>
        </form>
        <div className="mt-2">
          <ErrorText error={cat.error} />
        </div>
      </div>
    </Card>
  );
}

function Batches({
  course,
  canManage,
  onChanged,
}: {
  course: Course;
  canManage: boolean;
  onChanged: () => void;
}) {
  const batches = useLoad(() => api<Batch[]>(`/batches?courseId=${course.id}`), [course.id]);
  const branches = useLoad(
    () => api<Branch[]>(`/branches?brandId=${course.brandId}`),
    [course.brandId],
  );
  const [f, setF] = useState({
    code: '',
    name: '',
    startDate: '',
    endDate: '',
    capacity: '30',
    branchId: '',
    status: 'PLANNED',
  });
  const { busy, error, run } = useAction();
  const refresh = async () => {
    await batches.reload();
    onChanged();
  };
  return (
    <Card title={`Batches · ${course.name}`}>
      <Table
        head={['Batch', 'Branch', 'Starts', 'Ends', 'Capacity', 'Status', '']}
        empty={batches.data?.length === 0}
      >
        {batches.data?.map((b) => (
          <tr key={b.id}>
            <Td>
              <span className="font-medium">{b.name}</span>
              <span className="block text-xs text-slate-500">{b.code}</span>
            </Td>
            <Td>{b.branch?.name ?? '—'}</Td>
            <Td>{b.startDate.slice(0, 10)}</Td>
            <Td>{b.endDate?.slice(0, 10) ?? '—'}</Td>
            <Td>{b.capacity}</Td>
            <Td>
              <Badge tone={batchTone(b.status)}>{b.status}</Badge>
            </Td>
            <Td>
              {canManage && (
                <Select
                  aria-label={`Status of ${b.code}`}
                  value={b.status}
                  onChange={(e) =>
                    void run(async () => {
                      await api(`/batches/${b.id}`, {
                        method: 'PATCH',
                        body: { status: e.target.value },
                      });
                      await refresh();
                    })
                  }
                  className="w-36"
                >
                  {['PLANNED', 'OPEN', 'CLOSED', 'CANCELLED'].map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </Select>
              )}
            </Td>
          </tr>
        ))}
      </Table>
      {canManage && (
        <form
          className="mt-6 grid gap-3 sm:grid-cols-4"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api('/batches', {
                method: 'POST',
                body: {
                  courseId: course.id,
                  code: f.code,
                  name: f.name,
                  startDate: f.startDate,
                  endDate: f.endDate || undefined,
                  capacity: Number(f.capacity),
                  branchId: f.branchId || undefined,
                  status: f.status,
                },
              });
              setF({ ...f, code: '', name: '' });
              await refresh();
            });
          }}
        >
          <Field label="Batch name">
            <Input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </Field>
          <Field label="Code">
            <Input
              required
              value={f.code}
              onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })}
            />
          </Field>
          <Field label="Start date">
            <Input
              type="date"
              required
              value={f.startDate}
              onChange={(e) => setF({ ...f, startDate: e.target.value })}
            />
          </Field>
          <Field label="End date">
            <Input
              type="date"
              value={f.endDate}
              onChange={(e) => setF({ ...f, endDate: e.target.value })}
            />
          </Field>
          <Field label="Capacity">
            <Input
              type="number"
              min={0}
              required
              value={f.capacity}
              onChange={(e) => setF({ ...f, capacity: e.target.value })}
            />
          </Field>
          <Field label="Branch">
            <Select value={f.branchId} onChange={(e) => setF({ ...f, branchId: e.target.value })}>
              <option value="">—</option>
              {branches.data?.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Status">
            <Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
              <option value="PLANNED">Planned</option>
              <option value="OPEN">Open for admission</option>
            </Select>
          </Field>
          <div className="flex items-end">
            <Button type="submit" disabled={busy}>
              Add batch
            </Button>
          </div>
        </form>
      )}
      <div className="mt-3">
        <ErrorText error={error} />
      </div>
    </Card>
  );
}
