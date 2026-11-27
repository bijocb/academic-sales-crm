import { Injectable } from '@nestjs/common';
import type { LeadChannel } from '@prisma/client';
import { sha256 } from '../auth/crypto';
import { Clock } from '../common/clock';
import { unauthorized } from '../common/errors';
import { Db } from '../db/db.service';

export interface IntakeContext {
  keyId: string;
  organizationId: string;
  brandId: string;
  sourceId: string;
  channel: LeadChannel;
}

/** Resolves an intake key to its organization/brand/source. */
@Injectable()
export class IntakeKeyResolver {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  async resolve(key: string | undefined, expectedKeyId?: string): Promise<IntakeContext> {
    if (!key) throw unauthorized('INVALID_INTAKE_KEY', 'A valid intake key is required');
    const now = this.clock.now();
    // system(): the key identifies the tenant, so no tenant is known yet.
    const ctx = await this.db.system(async (tx) => {
      const k = await tx.intakeKey.findUnique({
        where: { keyHash: sha256(key) },
        include: { source: true, organization: true, brand: true },
      });
      if (!k || k.revokedAt || (expectedKeyId && k.id !== expectedKeyId)) return null;
      if (
        k.organization.status !== 'ACTIVE' ||
        k.brand.status !== 'ACTIVE' ||
        k.source.status !== 'ACTIVE'
      )
        return null;
      if (!k.lastUsedAt || now.getTime() - k.lastUsedAt.getTime() > 60_000) {
        await tx.intakeKey.update({ where: { id: k.id }, data: { lastUsedAt: now } });
      }
      return {
        keyId: k.id,
        organizationId: k.organizationId,
        brandId: k.brandId,
        sourceId: k.sourceId,
        channel: k.source.channel,
      };
    });
    if (!ctx) throw unauthorized('INVALID_INTAKE_KEY', 'A valid intake key is required');
    return ctx;
  }
}
