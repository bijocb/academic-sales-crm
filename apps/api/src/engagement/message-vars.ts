import type { Tx } from '../db/db.service';

type Vars = Record<string, string | undefined>;

const money = (minor: bigint, currency: string) =>
  new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-AE', {
    style: 'currency',
    currency,
  }).format(Number(minor) / 100);
const day = (d: Date, timeZone: string) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(d);
const dayTime = (d: Date, timeZone: string) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
const MODE: Record<string, string> = { ONLINE: 'Online', OFFLINE: 'Classroom', HYBRID: 'Hybrid' };

/**
 * Values for template placeholders (TEMPLATE_PLACEHOLDERS), read from the lead's own records. A value that does not
 * exist for this lead stays empty, and the template then reports which fields are missing instead of sending gaps.
 */
export async function templateVars(
  tx: Tx,
  lead: {
    id: string;
    brandId: string;
    ownerId: string | null;
    courseId: string | null;
    person: { fullName: string };
  },
  now: Date,
  /** The person sending: signs as owner when the lead has no owner yet. */
  senderId?: string,
): Promise<Vars> {
  const [brand, owner, course, quote, admission, appointment] = await Promise.all([
    tx.brand.findUniqueOrThrow({ where: { id: lead.brandId } }),
    lead.ownerId
      ? tx.user.findUnique({ where: { id: lead.ownerId }, select: { name: true, phone: true } })
      : null,
    lead.courseId ? tx.course.findUnique({ where: { id: lead.courseId } }) : null,
    tx.quotation.findFirst({
      where: { leadId: lead.id, status: { in: ['ACCEPTED', 'OPEN'] } },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }], // ACCEPTED before OPEN
    }),
    tx.admission.findFirst({
      where: { leadId: lead.id, status: { notIn: ['CANCELLED', 'CANCELLED_REFUNDED'] } },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    }),
    tx.appointment.findFirst({
      where: { leadId: lead.id, status: 'SCHEDULED', startsAt: { gte: now } },
      orderBy: { startsAt: 'asc' },
      select: { startsAt: true },
    }),
  ]);
  const sender =
    !owner && senderId
      ? await tx.user.findUnique({ where: { id: senderId }, select: { name: true, phone: true } })
      : null;
  const tz = brand.timezone;
  const v: Vars = {
    first_name: lead.person.fullName.split(/\s+/)[0],
    full_name: lead.person.fullName,
    owner_name: owner?.name ?? sender?.name,
    owner_phone: (owner ? owner.phone : sender?.phone) ?? undefined,
    brand: brand.name,
    brand_phone: brand.contactPhone ?? undefined,
    brand_email: brand.contactEmail ?? undefined,
    brand_website: brand.website ?? undefined,
    brand_address: brand.address ?? undefined,
    appointment_time: appointment ? dayTime(appointment.startsAt, tz) : undefined,
  };
  if (course) {
    v.course = course.name;
    v.course_fee =
      course.listFeeMinor !== null ? money(course.listFeeMinor, course.currency) : undefined;
    v.course_duration =
      course.durationValue && course.durationUnit
        ? `${course.durationValue} ${course.durationUnit.toLowerCase().replace(/s$/, course.durationValue === 1 ? '' : 's')}`
        : undefined;
    v.course_mode = MODE[course.deliveryMode];
  }
  // Next batch: the quoted batch, else the course's next open or planned batch.
  const batch = quote?.batchId
    ? await tx.batch.findUnique({ where: { id: quote.batchId }, select: { startDate: true } })
    : (quote?.courseId ?? lead.courseId)
      ? await tx.batch.findFirst({
          where: {
            courseId: (quote?.courseId ?? lead.courseId)!,
            status: { in: ['OPEN', 'PLANNED'] },
            startDate: { gte: now },
          },
          orderBy: { startDate: 'asc' },
          select: { startDate: true },
        })
      : null;
  if (batch) v.next_batch = day(batch.startDate, 'UTC');
  if (quote) v.quotation_total = money(quote.totalMinor, quote.currency);

  const plan = admission
    ? await tx.feePlan.findUnique({ where: { admissionId: admission.id } })
    : null;
  if (plan) {
    const [adj, paid, refunds, instalments] = await Promise.all([
      tx.feeAdjustment.aggregate({ where: { planId: plan.id }, _sum: { amountMinor: true } }),
      tx.payment.aggregate({ where: { planId: plan.id }, _sum: { amountMinor: true } }),
      tx.refund.findMany({
        where: { admissionId: plan.admissionId },
        select: { id: true, amountMinor: true },
      }),
      tx.instalment.findMany({ where: { planId: plan.id }, orderBy: { seq: 'asc' } }),
    ]);
    const paidOut = refunds.length
      ? new Set(
          (
            await tx.refundEvent.findMany({
              where: { refundId: { in: refunds.map((r) => r.id) }, type: 'PAID' },
              select: { refundId: true },
            })
          ).map((e) => e.refundId),
        )
      : new Set<string>();
    const refunded = refunds
      .filter((r) => paidOut.has(r.id))
      .reduce((s, r) => s + r.amountMinor, 0n);
    const total = plan.baseAmountMinor + (adj._sum.amountMinor ?? 0n);
    const net = (paid._sum.amountMinor ?? 0n) - refunded;
    v.fee_total = money(total, plan.currency);
    v.fee_paid = money(net, plan.currency);
    v.fee_outstanding = money(total - net > 0n ? total - net : 0n, plan.currency);
    // Payments cover instalments oldest first; the first not fully covered is the next due.
    let left = net;
    for (const i of instalments) {
      if (left >= i.amountMinor) {
        left -= i.amountMinor;
        continue;
      }
      v.next_due_date = day(i.dueDate, 'UTC');
      v.next_due_amount = money(i.amountMinor - (left > 0n ? left : 0n), plan.currency);
      break;
    }
  }
  return v;
}
