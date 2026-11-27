import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import type { ScopeType } from '@crm/contracts';
import { Clock } from '../common/clock';
import { Db, Tx } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import { APP_CONFIG, AppConfig } from '../config';
import { badRequest, unauthorized } from '../common/errors';
import { AccountTokensService } from './account-tokens.service';
import { Authz, Grant } from './authz';
import { burnPasswordCheck, hashPassword, randomToken, sha256, verifyPassword } from './crypto';
import type { Principal } from './principal';

export interface IssuedTokens {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

interface AccessClaims {
  sub: string;
  fid: string; // session family
  org: string | null;
}

interface ClientInfo {
  ip?: string;
  userAgent?: string;
}

/** A rotated refresh token presented again within this window is treated as a benign race (multiple tabs). */
const ROTATION_GRACE_MS = 15_000;

const INVALID_CREDENTIALS = () =>
  unauthorized(
    'INVALID_CREDENTIALS',
    'Invalid email or password, or the account is temporarily locked',
  );

@Injectable()
export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly jwt: JwtService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly accountTokens: AccountTokensService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ---------------------------------------------------------------- login
  async login(email: string, password: string, client: ClientInfo): Promise<IssuedTokens> {
    // system(): authentication happens before any tenant is known.
    const user = await this.db.system((tx) =>
      tx.user.findUnique({ where: { email }, include: { organization: true } }),
    );
    if (!user || !user.passwordHash) {
      await burnPasswordCheck(password);
      throw INVALID_CREDENTIALS();
    }
    const now = this.clock.now();
    const passwordOk = await verifyPassword(user.passwordHash, password);

    // Failures must be committed (lockout counter, audit), so the transaction returns an
    // outcome and we throw only after it commits.
    const outcome = await this.db.system(async (tx) => {
      if (user.lockedUntil && user.lockedUntil > now) {
        await this.audit.record(tx, {
          organizationId: user.organizationId,
          actorUserId: user.id,
          action: 'auth.login_blocked_locked',
          entityType: 'user',
          entityId: user.id,
        });
        return null;
      }
      if (!passwordOk) {
        const failures = user.failedLoginCount + 1;
        const lock = failures >= this.config.LOGIN_MAX_FAILURES;
        await tx.user.update({
          where: { id: user.id },
          data: lock
            ? {
                failedLoginCount: 0,
                lockedUntil: new Date(now.getTime() + this.config.LOGIN_LOCK_MINUTES * 60_000),
              }
            : { failedLoginCount: failures },
        });
        await this.audit.record(tx, {
          organizationId: user.organizationId,
          actorUserId: user.id,
          action: lock ? 'auth.account_locked' : 'auth.login_failed',
          entityType: 'user',
          entityId: user.id,
        });
        return null;
      }
      if (user.status !== 'ACTIVE' || (user.organization && user.organization.status !== 'ACTIVE'))
        return null;
      await tx.user.update({
        where: { id: user.id },
        data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: now },
      });
      const tokens = await this.createSession(tx, user, randomUUID(), client);
      await this.audit.record(tx, {
        organizationId: user.organizationId,
        actorUserId: user.id,
        action: 'auth.login',
        entityType: 'user',
        entityId: user.id,
      });
      return tokens;
    });
    if (!outcome) throw INVALID_CREDENTIALS();
    return outcome;
  }

  // -------------------------------------------------------------- refresh
  async refresh(refreshToken: string, client: ClientInfo): Promise<IssuedTokens> {
    const now = this.clock.now();
    // system(): token-based lookup before tenant is known.
    const result = await this.db.system(async (tx) => {
      const session = await tx.session.findUnique({
        where: { refreshTokenHash: sha256(refreshToken) },
        include: { user: { include: { organization: true } } },
      });
      if (!session) return { error: 'INVALID' as const };

      if (session.revokedAt) {
        const benignRace =
          session.revokeReason === 'rotated' &&
          session.rotatedAt &&
          now.getTime() - session.rotatedAt.getTime() < ROTATION_GRACE_MS;
        if (!benignRace) {
          // Reuse of an old refresh token: assume theft, kill the whole family.
          await tx.session.updateMany({
            where: { familyId: session.familyId, revokedAt: null },
            data: { revokedAt: now, revokeReason: 'refresh_reuse_detected' },
          });
          await this.audit.record(tx, {
            organizationId: session.organizationId,
            actorUserId: session.userId,
            action: 'auth.refresh_reuse_detected',
            entityType: 'session',
            entityId: session.familyId,
          });
        }
        return { error: 'INVALID' as const };
      }
      if (session.expiresAt <= now) return { error: 'INVALID' as const };
      const u = session.user;
      if (u.status !== 'ACTIVE' || (u.organization && u.organization.status !== 'ACTIVE')) {
        return { error: 'INVALID' as const };
      }
      await tx.session.update({
        where: { id: session.id },
        data: { revokedAt: now, rotatedAt: now, revokeReason: 'rotated' },
      });
      return { tokens: await this.createSession(tx, u, session.familyId, client) };
    });
    if ('error' in result)
      throw unauthorized('INVALID_REFRESH_TOKEN', 'Session expired, please sign in again');
    return result.tokens;
  }

  // --------------------------------------------------------------- logout
  async logout(principal: Principal): Promise<void> {
    await this.db.system(async (tx) => {
      await tx.session.updateMany({
        where: { familyId: principal.familyId, revokedAt: null },
        data: { revokedAt: this.clock.now(), revokeReason: 'logout' },
      });
      await this.audit.record(tx, {
        organizationId: principal.organizationId,
        action: 'auth.logout',
        entityType: 'user',
        entityId: principal.userId,
      });
    });
  }

  async logoutAll(principal: Principal): Promise<void> {
    await this.db.system(async (tx) => {
      await this.revokeAllSessions(tx, principal.userId, 'logout_all');
      await this.audit.record(tx, {
        organizationId: principal.organizationId,
        action: 'auth.logout_all',
        entityType: 'user',
        entityId: principal.userId,
      });
    });
  }

  async revokeAllSessions(
    tx: Tx,
    userId: string,
    reason: string,
    exceptFamilyId?: string,
  ): Promise<void> {
    await tx.session.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(exceptFamilyId ? { familyId: { not: exceptFamilyId } } : {}),
      },
      data: { revokedAt: this.clock.now(), revokeReason: reason },
    });
  }

  // ------------------------------------------------------------ passwords
  async forgotPassword(email: string): Promise<void> {
    // system(): unauthenticated flow.
    const issued = await this.db.system(async (tx) => {
      const user = await tx.user.findUnique({ where: { email }, include: { organization: true } });
      if (!user || user.status !== 'ACTIVE') return null;
      if (user.organization && user.organization.status !== 'ACTIVE') return null;
      const token = await this.accountTokens.issue(tx, user, 'PASSWORD_RESET');
      await this.audit.record(tx, {
        organizationId: user.organizationId,
        actorUserId: user.id,
        action: 'auth.password_reset_requested',
        entityType: 'user',
        entityId: user.id,
      });
      return { user, token };
    });
    // Sent after commit; response is identical whether or not the user exists.
    if (issued)
      await this.accountTokens.sendPasswordReset(issued.user.email, issued.user.name, issued.token);
  }

  /** Completes both password reset and invite acceptance. */
  async resetPassword(token: string, newPassword: string): Promise<void> {
    const now = this.clock.now();
    const passwordHash = await hashPassword(newPassword);
    const ok = await this.db.system(async (tx) => {
      const record = await tx.authToken.findUnique({
        where: { tokenHash: sha256(token) },
        include: { user: true },
      });
      if (!record || record.usedAt || record.expiresAt <= now) return false;
      const user = record.user;
      if (user.status === 'DEACTIVATED' || user.status === 'SUSPENDED') return false;
      if (record.type === 'PASSWORD_RESET' && user.status !== 'ACTIVE') return false;
      await tx.authToken.update({ where: { id: record.id }, data: { usedAt: now } });
      await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          passwordChangedAt: now,
          failedLoginCount: 0,
          lockedUntil: null,
          ...(record.type === 'INVITE' ? { status: 'ACTIVE' } : {}),
        },
      });
      await this.revokeAllSessions(tx, user.id, 'password_reset');
      await this.audit.record(tx, {
        organizationId: user.organizationId,
        actorUserId: user.id,
        action: record.type === 'INVITE' ? 'auth.invite_accepted' : 'auth.password_reset',
        entityType: 'user',
        entityId: user.id,
      });
      return true;
    });
    if (!ok) throw badRequest('INVALID_TOKEN', 'This link is invalid or has expired');
  }

  async changePassword(
    principal: Principal,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.db.system((tx) =>
      tx.user.findUniqueOrThrow({ where: { id: principal.userId } }),
    );
    if (!user.passwordHash || !(await verifyPassword(user.passwordHash, currentPassword))) {
      throw badRequest('INVALID_CURRENT_PASSWORD', 'Current password is incorrect');
    }
    const passwordHash = await hashPassword(newPassword);
    await this.db.system(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { passwordHash, passwordChangedAt: this.clock.now() },
      });
      await this.revokeAllSessions(tx, user.id, 'password_changed', principal.familyId);
      await this.audit.record(tx, {
        organizationId: user.organizationId,
        action: 'auth.password_changed',
        entityType: 'user',
        entityId: user.id,
      });
    });
  }

  // ---------------------------------------------------- request principal
  /**
   * Validates an access token AND the live session behind it, so logout, revocation and
   * deactivation take effect immediately (not after token expiry).
   */
  async authenticate(accessToken: string): Promise<Principal> {
    let claims: AccessClaims;
    try {
      claims = await this.jwt.verifyAsync<AccessClaims>(accessToken, { algorithms: ['HS256'] });
    } catch {
      throw unauthorized('INVALID_ACCESS_TOKEN', 'Session expired, please sign in again');
    }
    const now = this.clock.now();
    // system(): resolving the caller's own identity and grants.
    const principal = await this.db.system(async (tx) => {
      const live = await tx.session.findFirst({
        where: {
          familyId: claims.fid,
          userId: claims.sub,
          revokedAt: null,
          expiresAt: { gt: now },
        },
        select: { id: true },
      });
      if (!live) return null;
      const user = await tx.user.findUnique({
        where: { id: claims.sub },
        include: { organization: true },
      });
      if (!user || user.status !== 'ACTIVE') return null;
      if (user.organization && user.organization.status !== 'ACTIVE') return null;
      const grants = user.organizationId ? await loadGrants(tx, user.id) : [];
      return {
        userId: user.id,
        email: user.email,
        name: user.name,
        organizationId: user.organizationId,
        isPlatformAdmin: user.isPlatformAdmin,
        familyId: claims.fid,
        authz: new Authz(grants),
      } satisfies Principal;
    });
    if (!principal) throw unauthorized('SESSION_REVOKED', 'Session expired, please sign in again');
    return principal;
  }

  // -------------------------------------------------------------- helpers
  private async createSession(
    tx: Tx,
    user: { id: string; organizationId: string | null },
    familyId: string,
    client: ClientInfo,
  ): Promise<IssuedTokens> {
    const now = this.clock.now();
    const refreshToken = randomToken(32);
    const refreshTokenExpiresAt = new Date(
      now.getTime() + this.config.REFRESH_TOKEN_TTL_DAYS * 86_400_000,
    );
    await tx.session.create({
      data: {
        userId: user.id,
        organizationId: user.organizationId,
        familyId,
        refreshTokenHash: sha256(refreshToken),
        expiresAt: refreshTokenExpiresAt,
        userAgent: client.userAgent?.slice(0, 500),
        ip: client.ip,
      },
    });
    const ttl = this.config.ACCESS_TOKEN_TTL_SECONDS;
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, fid: familyId, org: user.organizationId } satisfies AccessClaims,
      { algorithm: 'HS256', expiresIn: ttl },
    );
    return {
      accessToken,
      accessTokenExpiresAt: new Date(now.getTime() + ttl * 1000),
      refreshToken,
      refreshTokenExpiresAt,
    };
  }
}

export async function loadGrants(tx: Tx, userId: string): Promise<Grant[]> {
  const rows = await tx.roleAssignment.findMany({
    where: { userId, revokedAt: null },
    include: { role: { include: { permissions: true } }, team: { select: { branchId: true } } },
  });
  return rows.map((r) => ({
    scopeType: r.scopeType as ScopeType,
    brandId: r.brandId,
    branchId: r.scopeType === 'TEAM' ? (r.team?.branchId ?? null) : r.branchId,
    teamId: r.teamId,
    permissions: new Set(r.role.permissions.map((p) => p.permission)),
  }));
}
