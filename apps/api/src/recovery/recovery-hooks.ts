import { Tx } from '../db/db.service';
import { changeLeadStatus } from '../leads/status-history';

/**
 * Transaction-level recovery hooks used by other modules (no DI, so no import cycles).
 */

/** Closes a live recovery case and the lead as CLOSED_LOST. */
export async function closeRecoveryCase(
  tx: Tx,
  c: { id: string; leadId: string },
  reason: string,
  reasonCode: string,
  actorUserId: string | null,
  now: Date,
  caseStatus: 'CLOSED' | 'CANCELLED' = 'CLOSED',
) {
  await tx.recoveryCase.update({
    where: { id: c.id },
    data: { status: caseStatus, closedAt: now, closeReason: reason, nextAttemptAt: null },
  });
  const lead = await tx.lead.findUniqueOrThrow({ where: { id: c.leadId } });
  await tx.task.updateMany({
    where: { leadId: lead.id, status: 'OPEN' },
    data: {
      status: 'CANCELLED',
      cancelReason: reason,
      cancelledAt: now,
      cancelledById: actorUserId,
    },
  });
  await changeLeadStatus(tx, {
    lead,
    to: 'CLOSED_LOST',
    reasonCode,
    notes: reason,
    actorUserId,
    now,
  });
  await tx.leadEvent.create({
    data: {
      organizationId: lead.organizationId,
      leadId: lead.id,
      type: 'LEAD_CLOSED',
      actorUserId,
      body: `Closed as lost — ${reason}`,
      data: { recoveryCaseId: c.id, reasonCode },
      occurredAt: now,
    },
  });
}

/** FR-012: an opt-out ends every live recovery case of the person. */
export async function closeRecoveryOnOptOut(
  tx: Tx,
  personId: string,
  actorUserId: string | null,
  now: Date,
) {
  const cases = await tx.recoveryCase.findMany({
    where: {
      status: { in: ['SCHEDULED', 'ACTIVE'] },
      leadId: {
        in: (await tx.lead.findMany({ where: { personId }, select: { id: true } })).map(
          (l) => l.id,
        ),
      },
    },
  });
  for (const c of cases)
    await closeRecoveryCase(
      tx,
      c,
      'The person opted out of contact',
      'OPTED_OUT',
      actorUserId,
      now,
    );
}

/** A person enquired again while their old lead waited in the recovery cooldown. */
export async function cancelRecoveryOnReturn(
  tx: Tx,
  previousLeadId: string,
  newLeadNumber: string,
  now: Date,
) {
  const c = await tx.recoveryCase.findFirst({
    where: { leadId: previousLeadId, status: 'SCHEDULED' },
  });
  if (c)
    await closeRecoveryCase(
      tx,
      c,
      `Returned with a new enquiry (${newLeadNumber})`,
      'RETURNED',
      null,
      now,
      'CANCELLED',
    );
}
