import { Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import {
  ChangePasswordSchema,
  ForgotPasswordSchema,
  LoginSchema,
  ResetPasswordSchema,
  z,
} from '@crm/contracts';
import { ApiZodBody, ZBody } from '../common/zod';
import { unauthorized } from '../common/errors';
import { Db } from '../db/db.service';
import { APP_CONFIG, AppConfig } from '../config';
import { AuthService, IssuedTokens } from './auth.service';
import { clearAuthCookies, REFRESH_COOKIE, setAuthCookies } from './cookies';
import { CurrentPrincipal, Public } from './decorators';
import type { Principal } from './principal';

/** Per IP + e-mail (account lockout also applies), and at most 100 per IP across accounts. */
const AUTH_THROTTLE = { default: { limit: 10, ttl: 60_000 }, ip: { limit: 100, ttl: 60_000 } };

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private get secure(): boolean {
    return this.config.NODE_ENV === 'production';
  }

  private respond(res: Response, tokens: IssuedTokens) {
    setAuthCookies(res, tokens, this.secure);
    return { accessToken: tokens.accessToken, accessTokenExpiresAt: tokens.accessTokenExpiresAt };
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('login')
  @HttpCode(200)
  @ApiZodBody(LoginSchema)
  async login(
    @ZBody(LoginSchema) body: z.infer<typeof LoginSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const tokens = await this.auth.login(body.email, body.password, clientInfo(req));
    return this.respond(res, tokens);
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    if (!token)
      throw unauthorized('INVALID_REFRESH_TOKEN', 'Session expired, please sign in again');
    try {
      return this.respond(res, await this.auth.refresh(token, clientInfo(req)));
    } catch (e) {
      clearAuthCookies(res, this.secure);
      throw e;
    }
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@CurrentPrincipal() p: Principal, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(p);
    clearAuthCookies(res, this.secure);
  }

  @Post('logout-all')
  @HttpCode(204)
  async logoutAll(@CurrentPrincipal() p: Principal, @Res({ passthrough: true }) res: Response) {
    await this.auth.logoutAll(p);
    clearAuthCookies(res, this.secure);
  }

  @Get('me')
  async me(@CurrentPrincipal() p: Principal) {
    const organization = p.organizationId
      ? await this.db.tenant(p.organizationId, (tx) =>
          tx.organization.findUniqueOrThrow({
            where: { id: p.organizationId! },
            select: {
              id: true,
              name: true,
              slug: true,
              country: true,
              timezone: true,
              currency: true,
            },
          }),
        )
      : null;
    return {
      user: { id: p.userId, email: p.email, name: p.name, isPlatformAdmin: p.isPlatformAdmin },
      organization,
      permissions: p.authz.summary(),
    };
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('password/forgot')
  @HttpCode(202)
  @ApiZodBody(ForgotPasswordSchema)
  async forgot(@ZBody(ForgotPasswordSchema) body: z.infer<typeof ForgotPasswordSchema>) {
    await this.auth.forgotPassword(body.email);
    return { message: 'If an active account exists for this email, a reset link has been sent.' };
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('password/reset')
  @HttpCode(204)
  @ApiZodBody(ResetPasswordSchema)
  async reset(@ZBody(ResetPasswordSchema) body: z.infer<typeof ResetPasswordSchema>) {
    await this.auth.resetPassword(body.token, body.newPassword);
  }

  @Post('password/change')
  @HttpCode(204)
  @ApiZodBody(ChangePasswordSchema)
  async change(
    @CurrentPrincipal() p: Principal,
    @ZBody(ChangePasswordSchema) body: z.infer<typeof ChangePasswordSchema>,
  ) {
    await this.auth.changePassword(p, body.currentPassword, body.newPassword);
  }
}

function clientInfo(req: Request) {
  return { ip: req.ip, userAgent: req.headers['user-agent'] };
}
