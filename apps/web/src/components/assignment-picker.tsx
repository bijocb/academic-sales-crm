'use client';
import { Field, Select, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import type { Branch, Brand, Role, Team } from '@/lib/types';

export interface AssignmentDraft {
  roleId: string;
  scopeType: 'ORGANIZATION' | 'BRAND' | 'BRANCH' | 'TEAM';
  brandId?: string;
  branchId?: string;
  teamId?: string;
}

export function useScopeOptions() {
  return useLoad(async () => {
    const [roles, brands, branches, teams] = await Promise.all([
      api<Role[]>('/roles'),
      api<Brand[]>('/brands').catch(() => [] as Brand[]),
      api<Branch[]>('/branches').catch(() => [] as Branch[]),
      api<Team[]>('/teams').catch(() => [] as Team[]),
    ]);
    return { roles, brands, branches, teams };
  });
}

export function AssignmentPicker({
  value,
  onChange,
  options,
}: {
  value: AssignmentDraft;
  onChange: (v: AssignmentDraft) => void;
  options: { roles: Role[]; brands: Brand[]; branches: Branch[]; teams: Team[] };
}) {
  const set = (patch: Partial<AssignmentDraft>) => onChange({ ...value, ...patch });
  return (
    <>
      <Field label="Role">
        <Select required value={value.roleId} onChange={(e) => set({ roleId: e.target.value })}>
          <option value="">Select a role…</option>
          {options.roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Scope" hint="Where the role applies">
        <Select
          value={value.scopeType}
          onChange={(e) =>
            set({
              scopeType: e.target.value as AssignmentDraft['scopeType'],
              brandId: undefined,
              branchId: undefined,
              teamId: undefined,
            })
          }
        >
          <option value="ORGANIZATION">Whole organization</option>
          <option value="BRAND">Brand</option>
          <option value="BRANCH">Branch</option>
          <option value="TEAM">Team</option>
        </Select>
      </Field>
      {value.scopeType === 'BRAND' && (
        <Field label="Brand">
          <Select
            required
            value={value.brandId ?? ''}
            onChange={(e) => set({ brandId: e.target.value })}
          >
            <option value="">Select…</option>
            {options.brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {value.scopeType === 'BRANCH' && (
        <Field label="Branch">
          <Select
            required
            value={value.branchId ?? ''}
            onChange={(e) => set({ branchId: e.target.value })}
          >
            <option value="">Select…</option>
            {options.branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name} ({options.brands.find((x) => x.id === b.brandId)?.code})
              </option>
            ))}
          </Select>
        </Field>
      )}
      {value.scopeType === 'TEAM' && (
        <Field label="Team">
          <Select
            required
            value={value.teamId ?? ''}
            onChange={(e) => set({ teamId: e.target.value })}
          >
            <option value="">Select…</option>
            {options.teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
    </>
  );
}

export const emptyAssignment = (): AssignmentDraft => ({ roleId: '', scopeType: 'BRAND' });
