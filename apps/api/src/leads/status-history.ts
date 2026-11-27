import type { LeadStatus } from '@prisma/client';
import { Tx } from '../db/db.service';

/** Changes a lead's status and appends the change to lead_status_history (append-only). */
export async function changeLeadStatus(
  tx: Tx,
  c: {
    lead: { id: string; organizationId: string; brandId: string; status: string };
    to: LeadStatus;
    reasonCode?: string | null;
    notes?: string | null;
    actorUserId: string | null;
    now: Date;
  },
) {
  if (c.lead.status === c.to) return;
  await tx.lead.update({ where: { id: c.lead.id }, data: { status: c.to } });
  await tx.leadStatusHistory.create({
    data: {
      organizationId: c.lead.organizationId,
      brandId: c.lead.brandId,
      leadId: c.lead.id,
      fromStatus: c.lead.status,
      toStatus: c.to,
      reasonCode: c.reasonCode ?? null,
      notes: c.notes ?? null,
      actorUserId: c.actorUserId,
      occurredAt: c.now,
    },
  });
}
