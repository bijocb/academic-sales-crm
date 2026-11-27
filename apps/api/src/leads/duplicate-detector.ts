import { Injectable } from '@nestjs/common';
import type { Tx } from '../db/db.service';
import { nameKey, scorePair, SUGGESTION_THRESHOLD } from './duplicate-rules';

/** Finds and records duplicate suggestions for one person. Runs inside the caller's transaction. */
@Injectable()
export class DuplicateDetector {
  async detectFor(tx: Tx, personId: string, now: Date): Promise<number> {
    const p = await tx.person.findUnique({ where: { id: personId } });
    if (!p || p.mergedIntoId) return 0;
    const key = p.nameKey ?? nameKey(p.fullName);
    const or = [];
    if (p.email) or.push({ email: p.email });
    if (key) or.push({ nameKey: key });
    if (p.phoneE164 && p.phoneE164.length > 8)
      or.push({ phoneE164: { startsWith: p.phoneE164.slice(0, p.phoneE164.length - 4) } });
    // Word overlap is only scored for people already found by phone prefix or email; name keys of
    // the candidate's individual words are not searched (too noisy for common names).
    if (!or.length) return 0;
    const others = await tx.person.findMany({
      where: { id: { not: p.id }, mergedIntoId: null, OR: or },
      take: 100,
    });
    let created = 0;
    for (const o of others) {
      const { score, reasons } = scorePair(p, o);
      if (score < SUGGESTION_THRESHOLD) continue;
      const [a, b] = p.id < o.id ? [p.id, o.id] : [o.id, p.id];
      const existing = await tx.duplicateCandidate.findUnique({
        where: { personAId_personBId: { personAId: a, personBId: b } },
      });
      if (existing) continue; // dismissed pairs are never re-raised
      await tx.duplicateCandidate.create({
        data: {
          organizationId: p.organizationId,
          personAId: a,
          personBId: b,
          score,
          reasons,
          detectedAt: now,
        },
      });
      created++;
    }
    return created;
  }
}
