import { Global, Inject, Module, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { APP_CONFIG, AppConfig } from './config';

export const REDIS = Symbol('REDIS');

/** Redis client, or null when REDIS_URL is not configured (not required until Phase 6/7). */
@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): Redis | null =>
        config.REDIS_URL
          ? new Redis(config.REDIS_URL, {
              maxRetriesPerRequest: 1,
              enableOfflineQueue: false,
              family: 0, // IPv4 or IPv6 (private networks are often IPv6)
            })
          : null,
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnModuleDestroy {
  constructor(@Inject(REDIS) private readonly redis: Redis | null) {}
  async onModuleDestroy(): Promise<void> {
    this.redis?.disconnect();
  }
}
