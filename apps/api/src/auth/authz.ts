import type { Permission, ScopeType } from '@crm/contracts';

/** One active role assignment, flattened with its role's permissions. */
export interface Grant {
  scopeType: ScopeType;
  brandId: string | null;
  branchId: string | null; // for TEAM grants: the team's branch (may be null)
  teamId: string | null;
  permissions: ReadonlySet<string>;
}

/** What an action targets. Omit everything to target the whole organization. */
export interface ScopeTarget {
  brandId?: string | null;
  branchId?: string | null;
  teamId?: string | null;
}

export interface ScopeSet {
  all: boolean;
  brandIds: string[];
  branchIds: string[];
  teamIds: string[];
}

/**
 * Pure permission evaluation (no I/O). Effective access = permission AND a grant whose
 * scope covers the target:
 *   ORGANIZATION covers everything; BRAND covers targets in that brand;
 *   BRANCH covers targets in that branch; TEAM covers only that team.
 */
export class Authz {
  constructor(private readonly grants: readonly Grant[]) {}

  static empty(): Authz {
    return new Authz([]);
  }

  /** Holds the permission at any scope (coarse gate; always follow with can()/scope()). */
  has(permission: Permission): boolean {
    return this.grants.some((g) => g.permissions.has(permission));
  }

  can(permission: Permission, target: ScopeTarget = {}): boolean {
    return this.grants.some((g) => g.permissions.has(permission) && covers(g, target));
  }

  /** Scope sets for building query filters. */
  scope(permission: Permission): ScopeSet {
    const set: ScopeSet = { all: false, brandIds: [], branchIds: [], teamIds: [] };
    for (const g of this.grants) {
      if (!g.permissions.has(permission)) continue;
      if (g.scopeType === 'ORGANIZATION') set.all = true;
      else if (g.scopeType === 'BRAND' && g.brandId) set.brandIds.push(g.brandId);
      else if (g.scopeType === 'BRANCH' && g.branchId) set.branchIds.push(g.branchId);
      else if (g.scopeType === 'TEAM' && g.teamId) set.teamIds.push(g.teamId);
    }
    set.brandIds = [...new Set(set.brandIds)];
    set.branchIds = [...new Set(set.branchIds)];
    set.teamIds = [...new Set(set.teamIds)];
    return set;
  }

  /** Brands in which the permission is held at any level (for "can see this brand" reads). */
  visibleBrandIds(permission: Permission): { all: boolean; brandIds: string[] } {
    let all = false;
    const ids = new Set<string>();
    for (const g of this.grants) {
      if (!g.permissions.has(permission)) continue;
      if (g.scopeType === 'ORGANIZATION') all = true;
      else if (g.brandId) ids.add(g.brandId);
    }
    return { all, brandIds: [...ids] };
  }

  /**
   * Anti-escalation: the actor may grant `rolePermissions` at `target` only if they hold
   * `role.assign` there AND every permission of the role at that same scope.
   */
  canGrant(rolePermissions: Iterable<string>, target: ScopeTarget): boolean {
    if (!this.can('role.assign', target)) return false;
    for (const p of rolePermissions) {
      if (!this.holdsOrMayConfer(p as Permission, target)) return false;
    }
    return true;
  }

  /**
   * `lead.receive` only marks someone as a lead recipient (it grants no access), so anyone who
   * may assign leads at that scope may confer it without holding it. Everything else must be held.
   */
  holdsOrMayConfer(permission: Permission, target: ScopeTarget = {}): boolean {
    if (permission === 'lead.receive')
      return (
        this.can('lead.assign', target) ||
        this.can('lead.reassign', target) ||
        this.can('lead.receive', target)
      );
    return this.can(permission, target);
  }

  /** Permission → list of scopes, for the UI (/auth/me). */
  summary(): Record<string, Array<Omit<Grant, 'permissions'>>> {
    const out: Record<string, Array<Omit<Grant, 'permissions'>>> = {};
    for (const g of this.grants) {
      for (const p of g.permissions) {
        (out[p] ??= []).push({
          scopeType: g.scopeType,
          brandId: g.brandId,
          branchId: g.branchId,
          teamId: g.teamId,
        });
      }
    }
    return out;
  }
}

function covers(g: Grant, t: ScopeTarget): boolean {
  switch (g.scopeType) {
    case 'ORGANIZATION':
      return true;
    case 'BRAND':
      return !!t.brandId && t.brandId === g.brandId;
    case 'BRANCH':
      return !!t.branchId && t.branchId === g.branchId;
    case 'TEAM':
      return !!t.teamId && t.teamId === g.teamId;
  }
}
