import { z } from 'zod';
import { PERMISSION_KEYS, SCOPE_TYPES } from './permissions';

export const COUNTRIES = ['IN', 'AE'] as const;
export const CURRENCIES = ['INR', 'AED'] as const;
export const DEFAULT_TIMEZONE: Record<(typeof COUNTRIES)[number], string> = {
  IN: 'Asia/Kolkata',
  AE: 'Asia/Dubai',
};
export const DEFAULT_CURRENCY: Record<(typeof COUNTRIES)[number], (typeof CURRENCIES)[number]> = {
  IN: 'INR',
  AE: 'AED',
};

export const PASSWORD_MIN_LENGTH = 10;

const timezone = z.string().refine(
  (tz) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  },
  { message: 'Must be a valid IANA time zone, e.g. Asia/Kolkata' },
);

const name = z.string().trim().min(1).max(200);
const code = z
  .string()
  .trim()
  .min(2)
  .max(32)
  .regex(/^[A-Z0-9_-]+$/, 'Use upper-case letters, digits, - or _');
const email = z.string().trim().toLowerCase().pipe(z.email()).pipe(z.string().max(254));
const password = z.string().min(PASSWORD_MIN_LENGTH).max(200);
const uuid = z.uuid();
const reason = z.string().trim().min(3).max(500);

// ---------- auth ----------
export const LoginSchema = z.object({ email, password: z.string().min(1).max(200) });
export const ForgotPasswordSchema = z.object({ email });
export const ResetPasswordSchema = z.object({
  token: z.string().min(20).max(200),
  newPassword: password,
});
export const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: password,
});

// ---------- platform ----------
export const CreateOrganizationSchema = z.object({
  name,
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(2)
    .max(50)
    .regex(/^[a-z0-9-]+$/),
  country: z.enum(COUNTRIES),
  timezone: timezone.optional(),
  currency: z.enum(CURRENCIES).optional(),
  admin: z.object({ name, email }),
});

// ---------- organization ----------
export const UpdateOrganizationSchema = z
  .object({ name, timezone, currency: z.enum(CURRENCIES) })
  .partial();

// ---------- brands / branches ----------
export const CreateBrandSchema = z.object({
  name,
  code,
  country: z.enum(COUNTRIES),
  timezone: timezone.optional(),
  currency: z.enum(CURRENCIES).optional(),
});
const optText = (max: number) => z.string().trim().max(max).nullable();
export const UpdateBrandSchema = z
  .object({
    name,
    timezone,
    currency: z.enum(CURRENCIES),
    status: z.enum(['ACTIVE', 'ARCHIVED']),
    // Contact details quoted in messages ({{brand_phone}} …).
    contactPhone: optText(40),
    contactEmail: z.email().max(254).nullable(),
    website: z.url().max(300).nullable(),
    address: optText(500),
  })
  .partial();

export const CreateBranchSchema = z.object({
  brandId: uuid,
  name,
  code,
  city: z.string().trim().max(100).optional(),
  country: z.enum(COUNTRIES),
  timezone: timezone.optional(),
});
export const UpdateBranchSchema = z
  .object({
    name,
    city: z.string().trim().max(100),
    timezone,
    status: z.enum(['ACTIVE', 'ARCHIVED']),
  })
  .partial();

// ---------- teams ----------
export const CreateTeamSchema = z.object({
  brandId: uuid,
  branchId: uuid.optional(),
  name,
  leaderId: uuid.optional(),
});
export const UpdateTeamSchema = z
  .object({ name, leaderId: uuid.nullable(), status: z.enum(['ACTIVE', 'ARCHIVED']) })
  .partial();
export const AddTeamMemberSchema = z.object({ userId: uuid });

// ---------- role assignments ----------
export const CreateRoleAssignmentSchema = z
  .object({
    roleId: uuid,
    scopeType: z.enum(SCOPE_TYPES),
    brandId: uuid.optional(),
    branchId: uuid.optional(),
    teamId: uuid.optional(),
    reason: reason.optional(),
  })
  .superRefine((v, ctx) => {
    const need = {
      ORGANIZATION: null,
      BRAND: 'brandId',
      BRANCH: 'branchId',
      TEAM: 'teamId',
    } as const;
    const key = need[v.scopeType];
    if (key && !v[key])
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: `${key} is required for ${v.scopeType} scope`,
      });
  });

// ---------- users ----------
const languages = z.array(z.string().trim().min(2).max(10)).max(20);
export const CreateUserSchema = z.object({
  name,
  email,
  phone: z.string().trim().max(30).optional(),
  managerId: uuid.optional(),
  maxActiveLeads: z.number().int().min(0).max(10000).optional(),
  languages: languages.optional(),
  /** Required unless the caller manages users organization-wide. */
  assignment: CreateRoleAssignmentSchema.optional(),
});
export const UpdateUserSchema = z
  .object({
    name,
    phone: z.string().trim().max(30).nullable(),
    managerId: uuid.nullable(),
    maxActiveLeads: z.number().int().min(0).max(10000).nullable(),
    languages,
  })
  .partial();
export const UserStatusChangeSchema = z.object({
  status: z.enum(['ACTIVE', 'SUSPENDED', 'DEACTIVATED']),
  reason,
});

// ---------- roles ----------
export const CreateRoleSchema = z.object({
  key: code,
  name,
  description: z.string().trim().max(500).optional(),
  permissions: z.array(z.enum(PERMISSION_KEYS as [string, ...string[]])).min(1),
});
export const UpdateRoleSchema = z
  .object({
    name,
    description: z.string().trim().max(500),
    permissions: z.array(z.enum(PERMISSION_KEYS as [string, ...string[]])).min(1),
  })
  .partial();

export const ReasonSchema = z.object({ reason });
export const RevokeRoleAssignmentSchema = ReasonSchema;

// ---------- paging ----------
export const PageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  q: z.string().trim().max(100).optional(),
});

export type LoginInput = z.infer<typeof LoginSchema>;
export type CreateOrganizationInput = z.infer<typeof CreateOrganizationSchema>;
export type CreateBrandInput = z.infer<typeof CreateBrandSchema>;
export type CreateBranchInput = z.infer<typeof CreateBranchSchema>;
export type CreateTeamInput = z.infer<typeof CreateTeamSchema>;
export type CreateUserInput = z.infer<typeof CreateUserSchema>;
export type CreateRoleInput = z.infer<typeof CreateRoleSchema>;
export type CreateRoleAssignmentInput = z.infer<typeof CreateRoleAssignmentSchema>;
export type PageQuery = z.infer<typeof PageQuerySchema>;
