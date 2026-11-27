/**
 * Permission catalog. Roles store these keys; the API validates against this list.
 * Permissions marked `phase` > 2 are declared now so role templates stay stable,
 * but are not enforced by any endpoint until their phase ships.
 */
export const PERMISSIONS = {
  // Phase 2 — identity & administration
  'organization.read': { phase: 2, description: 'View organization settings' },
  'organization.manage': { phase: 2, description: 'Edit organization settings' },
  'brand.read': { phase: 2, description: 'View brands and branches' },
  'brand.manage': { phase: 2, description: 'Create and edit brands' },
  'branch.manage': { phase: 2, description: 'Create and edit branches' },
  'team.read': { phase: 2, description: 'View teams and members' },
  'team.manage': { phase: 2, description: 'Create and edit teams and membership' },
  'user.read': { phase: 2, description: 'View users' },
  'user.manage': { phase: 2, description: 'Invite, edit, suspend and deactivate users' },
  'role.read': { phase: 2, description: 'View roles' },
  'role.manage': { phase: 2, description: 'Create and edit custom roles' },
  'role.assign': { phase: 2, description: 'Grant and revoke role assignments' },
  'audit.read': { phase: 2, description: 'View audit log' },

  // Later phases (declared)
  'course.read': { phase: 3, description: 'View courses and batches' },
  'course.manage': { phase: 3, description: 'Manage courses, batches and fees' },
  'settings.manage': {
    phase: 3,
    description: 'Manage business hours, holidays, SLA and pipeline settings',
  },
  'lead.read': { phase: 4, description: 'View leads in scope' },
  'lead.read_own': { phase: 4, description: 'View only leads owned or participated in' },
  'lead.create': { phase: 4, description: 'Create leads manually' },
  'lead.edit': { phase: 4, description: 'Edit lead details' },
  'lead.import': { phase: 4, description: 'Import leads from files' },
  'lead.export': { phase: 4, description: 'Export leads' },
  'lead.merge': { phase: 5, description: 'Merge duplicate leads' },
  'lead.archive': { phase: 5, description: 'Archive leads' },
  'lead.assign': { phase: 6, description: 'Manually assign leads' },
  'lead.receive': { phase: 6, description: 'Can be allocated new leads' },
  'lead.reassign': { phase: 6, description: 'Reassign leads' },
  'allocation.manage': { phase: 6, description: 'Manage allocation rules' },
  'task.manage': { phase: 7, description: 'Manage tasks of others in scope' },
  'pipeline.transition': { phase: 9, description: 'Change pipeline stage' },
  'recovery.manage': { phase: 10, description: 'Manage lost-lead recovery' },
  'admission.manage': { phase: 11, description: 'Manage admissions and documents' },
  'document.view': { phase: 11, description: 'View student documents' },
  'payment.read': { phase: 12, description: 'View payments' },
  'payment.record': { phase: 12, description: 'Record and verify payments' },
  'refund.request': { phase: 12, description: 'Request refunds' },
  'refund.approve': { phase: 12, description: 'Approve refunds' },
  'campaign.manage': { phase: 4, description: 'Manage sources and campaigns' },
  'integration.manage': { phase: 4, description: 'Manage integrations and credentials' },
  'report.read': { phase: 13, description: 'View reports and dashboards' },
  'report.export': { phase: 13, description: 'Export reports' },
  'target.manage': { phase: 13, description: 'Manage targets and incentives' },
  'pii.view_full': { phase: 4, description: 'View unmasked phone numbers and emails' },
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as Permission[];

export function isPermission(value: string): value is Permission {
  return Object.prototype.hasOwnProperty.call(PERMISSIONS, value);
}

export const SCOPE_TYPES = ['ORGANIZATION', 'BRAND', 'BRANCH', 'TEAM'] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];

const ALL = PERMISSION_KEYS;
const READ_ADMIN: Permission[] = [
  'organization.read',
  'brand.read',
  'team.read',
  'user.read',
  'role.read',
];

/** System role templates seeded into every organization (SRS §2). */
export const SYSTEM_ROLE_TEMPLATES: Record<
  string,
  { name: string; description: string; permissions: readonly Permission[] }
> = {
  ORG_ADMIN: {
    name: 'Organization Admin',
    description: 'Manage brands, branches, users and policies across the organization',
    // Everything except being a lead recipient (admins are not in the sales pool).
    permissions: ALL.filter((p) => p !== 'lead.receive'),
  },
  BRAND_MANAGER: {
    name: 'Brand Manager',
    description: 'Brand courses, teams, allocation and reports',
    permissions: [
      ...READ_ADMIN,
      'brand.manage',
      'branch.manage',
      'team.manage',
      'user.manage',
      'role.assign',
      'audit.read',
      'course.read',
      'course.manage',
      'settings.manage',
      'lead.read',
      'lead.read_own',
      'lead.create',
      'lead.edit',
      'lead.import',
      'lead.export',
      'lead.merge',
      'lead.archive',
      'lead.assign',
      'lead.reassign',
      'allocation.manage',
      'task.manage',
      'pipeline.transition',
      'recovery.manage',
      'campaign.manage',
      'payment.read',
      'report.read',
      'report.export',
      'target.manage',
      'pii.view_full',
    ],
  },
  SALES_MANAGER: {
    name: 'Sales Manager',
    description: 'Team performance, escalations, overrides and reassignment',
    permissions: [
      ...READ_ADMIN,
      'role.assign',
      'course.read',
      'lead.read',
      'lead.read_own',
      'lead.create',
      'lead.edit',
      'lead.export',
      'lead.merge',
      'lead.assign',
      'lead.reassign',
      'task.manage',
      'pipeline.transition',
      'recovery.manage',
      'payment.read',
      'report.read',
      'report.export',
      'target.manage',
      'pii.view_full',
    ],
  },
  TEAM_LEADER: {
    name: 'Team Leader',
    description: 'Daily task monitoring and team-level lead handling',
    permissions: [
      'brand.read',
      'team.read',
      'user.read',
      'course.read',
      'lead.read',
      'lead.read_own',
      'lead.create',
      'lead.edit',
      'lead.reassign',
      'task.manage',
      'pipeline.transition',
      'recovery.manage',
      'report.read',
      'pii.view_full',
    ],
  },
  SALES_EXECUTIVE: {
    name: 'Sales Executive',
    description: 'Work assigned leads, log interactions and follow-ups',
    permissions: [
      'brand.read',
      'course.read',
      'lead.read_own',
      'lead.create',
      'lead.edit',
      'lead.receive',
      'pipeline.transition',
      'pii.view_full',
    ],
  },
  COUNSELLOR: {
    name: 'Counsellor',
    description: 'Counselling, eligibility notes and course guidance',
    permissions: [
      'brand.read',
      'course.read',
      'lead.read_own',
      'lead.edit',
      'pipeline.transition',
      'pii.view_full',
    ],
  },
  ADMISSION_OFFICER: {
    name: 'Admission Officer',
    description: 'Document verification, admission workflow and batch handover',
    permissions: [
      'brand.read',
      'course.read',
      'lead.read',
      'admission.manage',
      'document.view',
      'payment.read',
      'pii.view_full',
    ],
  },
  ACCOUNTS_OFFICER: {
    name: 'Accounts Officer',
    description: 'Payment verification, refunds and outstanding balances',
    permissions: [
      'brand.read',
      'course.read',
      'lead.read',
      'payment.read',
      'payment.record',
      'refund.request',
      'refund.approve',
      'report.read',
    ],
  },
  MARKETING_MANAGER: {
    name: 'Marketing Manager',
    description: 'Campaign/source setup and ROI reports',
    permissions: [
      'brand.read',
      'course.read',
      'lead.read',
      'campaign.manage',
      'report.read',
      'report.export',
    ],
  },
  MANAGEMENT_VIEWER: {
    name: 'Management Viewer',
    description: 'Read-only consolidated KPIs',
    permissions: ['organization.read', 'brand.read', 'team.read', 'course.read', 'report.read'],
  },
};
