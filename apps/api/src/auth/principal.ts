import type { Authz } from './authz';

export interface Principal {
  userId: string;
  email: string;
  name: string;
  organizationId: string | null; // null for platform admins
  isPlatformAdmin: boolean;
  familyId: string; // session family of the access token
  authz: Authz;
}

/** Principal of an organization user (organizationId guaranteed). */
export interface OrgPrincipal extends Principal {
  organizationId: string;
}
