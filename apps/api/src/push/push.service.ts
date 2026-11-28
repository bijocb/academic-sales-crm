import { Injectable } from '@nestjs/common';
import type { OrgPrincipal } from '../auth/principal';
import { Clock } from '../common/clock';
import { badRequest } from '../common/errors';
import { Db } from '../db/db.service';
import { JobsService } from '../jobs/jobs.service';
import { EXPO_TOKEN, PushProvider } from './push';

/**
 * Phones registered by the mobile app, and the `push.send` job that mirrors each new in-app notification to them
 * (queued by NotificationsService). Retried like every job; uninstalled devices are switched off.
 */
@Injectable()
export class PushService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly jobs: JobsService,
    private readonly provider: PushProvider,
  ) {
    this.jobs.register('push.send', (j) => this.sendJob(j.organizationId!, j.payload));
  }

  register(p: OrgPrincipal, input: { token: string; platform: string; appVersion?: string }) {
    if (!EXPO_TOKEN.test(input.token))
      throw badRequest('INVALID_PUSH_TOKEN', 'Not an Expo push token');
    const now = this.clock.now();
    return this.db.tenant(p.organizationId, async (tx) => {
      // A phone handed to another colleague moves with the new sign-in.
      const d = await tx.pushDevice.upsert({
        where: { token: input.token },
        create: {
          organizationId: p.organizationId,
          userId: p.userId,
          token: input.token,
          platform: input.platform,
          appVersion: input.appVersion ?? null,
          createdAt: now,
          lastSeenAt: now,
        },
        update: {
          userId: p.userId,
          platform: input.platform,
          appVersion: input.appVersion ?? null,
          lastSeenAt: now,
          disabledAt: null,
        },
      });
      return { id: d.id, registered: true };
    });
  }

  unregister(p: OrgPrincipal, token: string) {
    return this.db.tenant(p.organizationId, async (tx) => {
      const r = await tx.pushDevice.updateMany({
        where: { token, userId: p.userId, disabledAt: null },
        data: { disabledAt: this.clock.now() },
      });
      return { removed: r.count };
    });
  }

  private async sendJob(organizationId: string, payload: unknown) {
    const { notificationId } = payload as { notificationId: string };
    const loaded = await this.db.tenant(organizationId, async (tx) => {
      const n = await tx.notification.findUnique({ where: { id: notificationId } });
      if (!n) return null;
      const devices = await tx.pushDevice.findMany({
        where: { userId: n.userId, disabledAt: null },
      });
      return { n, devices };
    });
    if (!loaded || !loaded.devices.length) return;
    const { n, devices } = loaded;
    const tickets = await this.provider.send(
      devices.map((d) => ({
        to: d.token,
        title: n.title,
        ...(n.body ? { body: n.body } : {}),
        data: { type: n.type, ...(n.link ? { link: n.link } : {}) },
      })),
    );
    const gone = devices.filter((_, i) => tickets[i]?.error === 'DeviceNotRegistered');
    if (gone.length)
      await this.db.tenant(organizationId, (tx) =>
        tx.pushDevice.updateMany({
          where: { id: { in: gone.map((d) => d.id) } },
          data: { disabledAt: this.clock.now() },
        }),
      );
    const failed = tickets.filter((t, i) => !t.ok && !gone.includes(devices[i]));
    if (failed.length === devices.length)
      throw new Error(`Push failed: ${failed[0]?.error ?? 'unknown'}`);
  }
}
