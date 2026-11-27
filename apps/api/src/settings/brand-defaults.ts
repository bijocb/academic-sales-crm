import type { Prisma } from '@prisma/client';
import { DEFAULT_PIPELINE, DEFAULT_SLA_POLICY, DEFAULT_WORKING_HOURS } from '@crm/contracts';

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
  return { created };
}
