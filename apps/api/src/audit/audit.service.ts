import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Tx } from '../db/db.service';
import { requestContext } from '../common/request-context';

export interface AuditEntry {
  organizationId: string | null;
  action: string; // e.g. 'brand.created', 'auth.login_failed'
  entityType: string;
  entityId?: string | null;
  brandId?: string | null;
  actorUserId?: string | null; // defaults to current principal
  before?: unknown;
  after?: unknown;
  reason?: string | null;
}

/** Writes append-only audit rows inside the caller's transaction (same commit as the change). */
@Injectable()
export class AuditService {
  async record(tx: Tx, entry: AuditEntry): Promise<void> {
    const ctx = requestContext.get();
    await tx.auditLog.create({
      data: {
        organizationId: entry.organizationId,
        actorUserId:
          entry.actorUserId !== undefined ? entry.actorUserId : (ctx?.principal?.userId ?? null),
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        brandId: entry.brandId ?? null,
        before: toJson(entry.before),
        after: toJson(entry.after),
        reason: entry.reason ?? null,
        correlationId: ctx?.correlationId ?? null,
        ip: ctx?.ip ?? null,
      },
    });
  }
}

function toJson(v: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (v === undefined || v === null) return Prisma.DbNull;
  return JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
}
