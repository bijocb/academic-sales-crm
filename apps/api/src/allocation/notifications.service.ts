import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { OrgPrincipal } from '../auth/principal';
import { Clock } from '../common/clock';
import { Db, Tx } from '../db/db.service';

/** In-app notifications. Email/WhatsApp delivery arrives with Phase 8 providers. */
@Injectable()
export class NotificationsService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  /** Idempotent per (user, dedupKey). */
  async create(
    tx: Tx,
    n: {
      organizationId: string;
      userId: string;
      type: string;
      title: string;
      body?: string;
      link?: string;
      dedupKey: string;
      now: Date;
    },
  ) {
    try {
      await tx.$executeRaw`
        INSERT INTO notifications (id, organization_id, user_id, type, title, body, link, dedup_key, created_at)
        VALUES (gen_random_uuid(), ${n.organizationId}::uuid, ${n.userId}::uuid, ${n.type}, ${n.title}, ${n.body ?? null}, ${n.link ?? null}, ${n.dedupKey}, ${n.now})
        ON CONFLICT (user_id, dedup_key) DO NOTHING`;
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError)) throw e;
    }
  }

  list(p: OrgPrincipal, unreadOnly: boolean) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const [items, unread] = await Promise.all([
        tx.notification.findMany({
          where: { userId: p.userId, ...(unreadOnly ? { readAt: null } : {}) },
          orderBy: { createdAt: 'desc' },
          take: 50,
        }),
        tx.notification.count({ where: { userId: p.userId, readAt: null } }),
      ]);
      return { items, unread };
    });
  }

  markRead(p: OrgPrincipal, id?: string) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const r = await tx.notification.updateMany({
        where: { userId: p.userId, readAt: null, ...(id ? { id } : {}) },
        data: { readAt: this.clock.now() },
      });
      return { updated: r.count };
    });
  }
}
