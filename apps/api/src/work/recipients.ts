import type { Permission } from '@crm/contracts';
import { Tx } from '../db/db.service';

/** Active users holding `permission` over the whole brand (organization- or brand-scoped grants). */
export async function brandManagers(
  tx: Tx,
  brandId: string,
  permission: Permission,
): Promise<string[]> {
  const rows = await tx.roleAssignment.findMany({
    where: {
      revokedAt: null,
      OR: [{ scopeType: 'ORGANIZATION' }, { scopeType: 'BRAND', brandId }],
      role: { permissions: { some: { permission } } },
      user: { status: 'ACTIVE' },
    },
    select: { userId: true },
  });
  return [...new Set(rows.map((r) => r.userId))];
}

/** Leaders of the active teams (in this brand) that `userId` belongs to, excluding the user. */
export async function teamLeadersOf(tx: Tx, userId: string, brandId: string): Promise<string[]> {
  const rows = await tx.teamMember.findMany({
    where: { userId, leftAt: null, team: { brandId, status: 'ACTIVE', leaderId: { not: null } } },
    select: { team: { select: { leaderId: true } } },
  });
  return [
    ...new Set(rows.map((r) => r.team.leaderId).filter((x): x is string => !!x && x !== userId)),
  ];
}
