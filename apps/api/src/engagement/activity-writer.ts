import type { ActivityDirection, ActivityType } from '@prisma/client';
import { Tx } from '../db/db.service';

/** The one place activities (append-only interaction history) are written. */
export function recordActivity(
  tx: Tx,
  a: {
    lead: { id: string; organizationId: string; brandId: string; personId: string };
    type: ActivityType;
    direction: ActivityDirection;
    actorUserId: string | null;
    now: Date;
    occurredAt?: Date;
    startedAt?: Date | null;
    durationSec?: number | null;
    outcome?: string | null;
    subject?: string | null;
    body?: string | null;
    templateId?: string | null;
    provider?: string | null;
    providerRef?: string | null;
    taskId?: string | null;
  },
) {
  const endedAt =
    a.startedAt && a.durationSec != null
      ? new Date(a.startedAt.getTime() + a.durationSec * 1000)
      : null;
  return tx.activity.create({
    data: {
      organizationId: a.lead.organizationId,
      brandId: a.lead.brandId,
      leadId: a.lead.id,
      personId: a.lead.personId,
      type: a.type,
      direction: a.direction,
      actorUserId: a.actorUserId,
      occurredAt: a.occurredAt ?? a.startedAt ?? a.now,
      startedAt: a.startedAt ?? null,
      endedAt,
      durationSec: a.durationSec ?? null,
      outcome: a.outcome ?? null,
      subject: a.subject ?? null,
      body: a.body ?? null,
      templateId: a.templateId ?? null,
      provider: a.provider ?? null,
      providerRef: a.providerRef ?? null,
      taskId: a.taskId ?? null,
      createdAt: a.now,
    },
  });
}
