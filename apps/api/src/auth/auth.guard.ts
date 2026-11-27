import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { Permission } from '@crm/contracts';
import { forbidden, unauthorized } from '../common/errors';
import { requestContext } from '../common/request-context';
import { AuthService } from './auth.service';
import { IS_PUBLIC, PLATFORM_ADMIN_ONLY, REQUIRED_PERMISSION } from './decorators';
import { ACCESS_COOKIE } from './cookies';

/**
 * Global guard: every route requires authentication unless marked @Public().
 * - Platform admins may only call @PlatformAdminOnly() routes (and /auth/*).
 * - @RequirePermission() routes require an organization user holding that permission somewhere.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest<Request & { principal?: unknown }>();
    const token = extractAccessToken(req);
    if (!token) throw unauthorized();
    const principal = await this.auth.authenticate(token);
    req.principal = principal;
    const store = requestContext.get();
    if (store) store.principal = principal;

    const platformOnly = this.reflector.getAllAndOverride<boolean>(PLATFORM_ADMIN_ONLY, targets);
    if (platformOnly) {
      if (!principal.isPlatformAdmin) throw forbidden();
      return true;
    }
    const permission = this.reflector.getAllAndOverride<Permission>(REQUIRED_PERMISSION, targets);
    if (permission) {
      if (!principal.organizationId || !principal.authz.has(permission)) throw forbidden();
    }
    return true;
  }
}

export function extractAccessToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim() || undefined;
  const cookie = (req.cookies as Record<string, string> | undefined)?.[ACCESS_COOKIE];
  return cookie || undefined;
}
