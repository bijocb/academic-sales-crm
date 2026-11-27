import { Controller, Get, Inject, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type Redis from 'ioredis';
import { Public } from '../auth/decorators';
import { Db } from '../db/db.service';
import { REDIS } from '../redis.module';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly db: Db,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Public()
  @Get()
  async check(@Res({ passthrough: true }) res: Response) {
    const [database, redis] = await Promise.all([
      this.db.ping().then(
        () => 'up' as const,
        () => 'down' as const,
      ),
      this.redis.ping().then(
        () => 'up' as const,
        () => 'down' as const,
      ),
    ]);
    const ok = database === 'up' && redis === 'up';
    res.status(ok ? 200 : 503);
    return { status: ok ? 'ok' : 'degraded', database, redis };
  }
}
