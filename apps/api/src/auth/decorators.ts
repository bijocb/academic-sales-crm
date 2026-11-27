import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Permission } from '@crm/contracts';
import type { Principal } from './principal';

export const IS_PUBLIC = 'crm:isPublic';
export const REQUIRED_PERMISSION = 'crm:requiredPermission';
export const PLATFORM_ADMIN_ONLY = 'crm:platformAdminOnly';

/** No authentication required. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/**
 * Coarse gate: caller must be an organization user holding the permission at some scope.
 * Services must still check the specific target with authz.can()/scope().
 */
export const RequirePermission = (permission: Permission) =>
  SetMetadata(REQUIRED_PERMISSION, permission);

export const PlatformAdminOnly = () => SetMetadata(PLATFORM_ADMIN_ONLY, true);

export const CurrentPrincipal = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): Principal => {
    return ctx.switchToHttp().getRequest().principal;
  },
);
