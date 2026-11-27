import { Inject, Injectable } from '@nestjs/common';
import type { AuthTokenType } from '@prisma/client';
import { Clock } from '../common/clock';
import type { Tx } from '../db/db.service';
import { MailService } from '../mail/mail.service';
import { APP_CONFIG, AppConfig } from '../config';
import { randomToken, sha256 } from './crypto';

const TTL_MINUTES: Record<AuthTokenType, number> = { INVITE: 7 * 24 * 60, PASSWORD_RESET: 30 };

/** Single-use, hashed invite / password-reset tokens delivered by email. */
@Injectable()
export class AccountTokensService {
  constructor(
    private readonly clock: Clock,
    private readonly mail: MailService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Creates a token (invalidating earlier unused ones of the same type) and returns the plaintext. */
  async issue(
    tx: Tx,
    user: { id: string; organizationId: string | null },
    type: AuthTokenType,
  ): Promise<string> {
    const now = this.clock.now();
    await tx.authToken.updateMany({
      where: { userId: user.id, type, usedAt: null },
      data: { usedAt: now },
    });
    const token = randomToken();
    await tx.authToken.create({
      data: {
        userId: user.id,
        organizationId: user.organizationId,
        type,
        tokenHash: sha256(token),
        expiresAt: new Date(now.getTime() + TTL_MINUTES[type] * 60_000),
      },
    });
    return token;
  }

  async sendInvite(email: string, name: string, orgName: string, token: string): Promise<void> {
    const link = `${this.config.WEB_ORIGIN}/reset-password?token=${encodeURIComponent(token)}&invite=1`;
    await this.mail.send({
      to: email,
      subject: `You have been invited to ${orgName} CRM`,
      text: `Hello ${name},\n\nYou have been invited to the ${orgName} sales CRM.\nSet your password here (valid for 7 days):\n${link}\n`,
    });
  }

  async sendPasswordReset(email: string, name: string, token: string): Promise<void> {
    const link = `${this.config.WEB_ORIGIN}/reset-password?token=${encodeURIComponent(token)}`;
    await this.mail.send({
      to: email,
      subject: 'Reset your CRM password',
      text: `Hello ${name},\n\nReset your password here (valid for 30 minutes):\n${link}\n\nIf you did not request this, ignore this email.\n`,
    });
  }
}
