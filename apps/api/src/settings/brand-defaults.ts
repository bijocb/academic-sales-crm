import type { Prisma } from '@prisma/client';
import {
  DEFAULT_DOCUMENT_TYPES,
  DEFAULT_LOSS_REASONS,
  DEFAULT_PIPELINE,
  DEFAULT_RECOVERY_POLICY,
  DEFAULT_SLA_POLICY,
  DEFAULT_WORKING_HOURS,
} from '@crm/contracts';

type Tx = Prisma.TransactionClient;

/**
 * Creates any missing operational defaults for a brand (working hours, SLA policy,
 * pipeline stages). Idempotent: existing configuration is never overwritten.
 * Called on brand creation, by seeds, and by the deploy-time backfill.
 */
export async function ensureBrandDefaults(
  tx: Tx,
  brand: { id: string; organizationId: string; country: 'IN' | 'AE' },
): Promise<{ created: string[] }> {
  const created: string[] = [];
  const { id: brandId, organizationId } = brand;

  if ((await tx.workingHours.count({ where: { brandId } })) === 0) {
    await tx.workingHours.createMany({
      data: DEFAULT_WORKING_HOURS[brand.country].map((s) => ({ organizationId, brandId, ...s })),
    });
    created.push('working_hours');
  }

  if (!(await tx.slaPolicy.findUnique({ where: { brandId } }))) {
    const { checkpoints, ...policy } = DEFAULT_SLA_POLICY;
    const p = await tx.slaPolicy.create({ data: { organizationId, brandId, ...policy } });
    await tx.slaCheckpoint.createMany({
      data: checkpoints.map((c, i) => ({ organizationId, policyId: p.id, position: i + 1, ...c })),
    });
    created.push('sla_policy');
  }

  const existing = new Set(
    (await tx.pipelineStage.findMany({ where: { brandId }, select: { key: true } })).map(
      (s) => s.key,
    ),
  );
  const missing = DEFAULT_PIPELINE.map((s, i) => ({ ...s, position: i + 1 })).filter(
    (s) => !existing.has(s.key),
  );
  if (missing.length) {
    await tx.pipelineStage.createMany({
      data: missing.map((s) => ({
        organizationId,
        brandId,
        key: s.key,
        position: s.position,
        label: s.label,
        requiredFields: s.requiredFields,
      })),
    });
    created.push('pipeline_stages');
  }
  if (!(await tx.allocationSettings.findUnique({ where: { brandId } }))) {
    await tx.allocationSettings.create({ data: { organizationId, brandId } });
    created.push('allocation_settings');
  }
  if ((await tx.leadSource.count({ where: { brandId } })) === 0) {
    await tx.leadSource.createMany({
      data: DEFAULT_LEAD_SOURCES.map((x) => ({ organizationId, brandId, ...x })),
    });
    created.push('lead_sources');
  }
  if ((await tx.lossReason.count({ where: { brandId } })) === 0) {
    await tx.lossReason.createMany({
      data: DEFAULT_LOSS_REASONS.map((r, i) => ({
        organizationId,
        brandId,
        position: i + 1,
        ...r,
      })),
    });
    created.push('loss_reasons');
  }
  if (!(await tx.recoveryPolicy.findUnique({ where: { brandId } }))) {
    await tx.recoveryPolicy.create({
      data: { organizationId, brandId, ...DEFAULT_RECOVERY_POLICY },
    });
    created.push('recovery_policy');
  }
  if ((await tx.documentType.count({ where: { brandId } })) === 0) {
    await tx.documentType.createMany({
      data: DEFAULT_DOCUMENT_TYPES.map((d, i) => ({
        organizationId,
        brandId,
        position: i + 1,
        ...d,
      })),
    });
    created.push('document_types');
  }
  if (!(await tx.admissionSettings.findUnique({ where: { brandId } }))) {
    await tx.admissionSettings.create({ data: { organizationId, brandId } });
    created.push('admission_settings');
  }
  if (!(await tx.financeSettings.findUnique({ where: { brandId } }))) {
    await tx.financeSettings.create({ data: { organizationId, brandId } });
    created.push('finance_settings');
  }
  if (!(await tx.aiSettings.findUnique({ where: { brandId } }))) {
    // AI assistance is off until an administrator switches it on (A-045).
    await tx.aiSettings.create({ data: { organizationId, brandId } });
    created.push('ai_settings');
  }
  return { created };
}

/** Starter sources per brand (renamable/archivable). */
export const DEFAULT_LEAD_SOURCES = [
  { name: 'Website', channel: 'WEBSITE' as const, isPaid: false },
  { name: 'Google Ads', channel: 'GOOGLE_ADS' as const, isPaid: true },
  { name: 'Meta Ads', channel: 'META_ADS' as const, isPaid: true },
  { name: 'WhatsApp', channel: 'WHATSAPP' as const, isPaid: false },
  { name: 'Walk-in / Phone call', channel: 'CALL' as const, isPaid: false },
  { name: 'Referral', channel: 'REFERRAL' as const, isPaid: false },
  { name: 'Events', channel: 'EVENT' as const, isPaid: false },
  { name: 'Imported list', channel: 'IMPORT' as const, isPaid: false },
  { name: 'Manual entry', channel: 'MANUAL' as const, isPaid: false },
];
