import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from './prisma.service';

export type Tx = Prisma.TransactionClient;

interface TxOptions {
  isolationLevel?: Prisma.TransactionIsolationLevel;
  timeout?: number;
  maxWait?: number;
}

/**
 * Under bursts, requests wait up to 8 s for a pooled connection instead of failing after Prisma's 2 s default
 * (Phase 15 load test); transactions may run up to 15 s (large reports). Callers can override both.
 */
const DEFAULTS: TxOptions = { maxWait: 8_000, timeout: 15_000 };

/**
 * The only sanctioned way to reach the database (CLAUDE.md rule 5).
 *
 * - `tenant(orgId, fn)` runs `fn` in a transaction where PostgreSQL row-level security
 *   only exposes rows of `orgId`. Use for everything an organization user does.
 * - `system(fn)` bypasses RLS. Only for authentication (before a tenant is known) and
 *   platform-admin operations. Every call site must be justified in a comment.
 */
@Injectable()
export class Db {
  constructor(private readonly prisma: PrismaService) {}

  tenant<T>(organizationId: string, fn: (tx: Tx) => Promise<T>, options?: TxOptions): Promise<T> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.org_id', ${organizationId}, true)`;
        return fn(tx);
      },
      { ...DEFAULTS, ...options },
    );
  }

  system<T>(fn: (tx: Tx) => Promise<T>, options?: TxOptions): Promise<T> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
        return fn(tx);
      },
      { ...DEFAULTS, ...options },
    );
  }

  /** Connectivity probe for health checks (no tenant data touched). */
  async ping(): Promise<void> {
    await this.prisma.$queryRaw`SELECT 1`;
  }
}
