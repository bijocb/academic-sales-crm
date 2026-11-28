import type { Tx } from '../db/db.service';
import { Features, repeatBucket } from './scoring';

/** Factors describe the enquiry and the first 3 days only (no outcome leakage, comparable for new leads). */
export const WINDOW_MS = 3 * 86_400_000;

/**
 * Builds scoring features for leads. Reads enquiries, sources, the first-response SLA clock and calls — never the
 * person record (name, phone, e-mail, location, language), the owner, or any free text. See docs/AI-REVIEW.md.
 */
export async function extractFeatures(tx: Tx, leadIds: string[]): Promise<Map<string, Features>> {
  const ids = [...new Set(leadIds)];
  const out = new Map<string, Features>();
  if (!ids.length) return out;
  const leads = await tx.lead.findMany({
    where: { id: { in: ids } },
    select: { id: true, createdAt: true },
  });
  const [enquiries, slas, calls] = await Promise.all([
    tx.enquiry.findMany({
      where: { leadId: { in: ids } },
      orderBy: { receivedAt: 'asc' },
      select: { leadId: true, sourceId: true, campaignId: true, courseId: true, receivedAt: true },
    }),
    tx.slaInstance.findMany({
      where: { leadId: { in: ids }, kind: 'FIRST_RESPONSE', state: { not: 'CANCELLED' } },
      orderBy: { startedAt: 'asc' },
      select: { leadId: true, state: true, breachedAt: true, resolvedAt: true },
    }),
    tx.activity.findMany({
      where: { leadId: { in: ids }, type: 'CALL', outcome: 'CONNECTED' },
      select: { leadId: true, occurredAt: true },
    }),
  ]);
  const sources = await tx.leadSource.findMany({
    where: {
      id: { in: [...new Set(enquiries.map((e) => e.sourceId).filter((x): x is string => !!x))] },
    },
    select: { id: true, channel: true },
  });
  const channel = new Map(sources.map((s) => [s.id, s.channel as string]));
  for (const l of leads) {
    const until = new Date(l.createdAt.getTime() + WINDOW_MS);
    const enq = enquiries.filter((e) => e.leadId === l.id);
    const first = enq[0];
    const sla = slas.find((s) => s.leadId === l.id);
    const slaOnTime =
      sla &&
      sla.state === 'RESOLVED' &&
      !sla.breachedAt &&
      sla.resolvedAt &&
      sla.resolvedAt <= until;
    out.set(l.id, {
      channel: (first?.sourceId && channel.get(first.sourceId)) || 'UNKNOWN',
      paidCampaign: first?.campaignId ? 'yes' : 'no',
      courseChosen: first?.courseId ? 'yes' : 'no',
      repeatEnquiry: repeatBucket(Math.max(1, enq.filter((e) => e.receivedAt <= until).length)),
      firstResponse: !sla ? 'none' : slaOnTime ? 'on_time' : sla.breachedAt ? 'late' : 'none',
      connected3d: calls.some((c) => c.leadId === l.id && c.occurredAt <= until) ? 'yes' : 'no',
    });
  }
  return out;
}
