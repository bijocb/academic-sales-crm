import type { OrgPrincipal, Principal } from '../auth/principal';
import { forbidden } from './errors';

/** Narrows to an organization user; platform admins have no tenant data access (A-014). */
export function requireOrg(p: Principal): OrgPrincipal {
  if (!p.organizationId) throw forbidden('This action is only available to organization users');
  return p as OrgPrincipal;
}

export function pageArgs(page: number, pageSize: number) {
  return { skip: (page - 1) * pageSize, take: pageSize };
}
