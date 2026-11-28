import { All, Controller, Get, Headers, HttpCode, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiExcludeController } from '@nestjs/swagger';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Public } from '../auth/decorators';
import { unauthorized } from '../common/errors';
import { APP_CONFIG, AppConfig } from '../config';
import { StatusService } from './status.service';
import { WorkerService } from './worker.service';

const digest = (s: string) => createHash('sha256').update(s).digest();

/** Scheduler entry point for serverless hosting (Vercel Cron sends `Authorization: Bearer $CRON_SECRET`). */
@ApiExcludeController()
@Controller('internal')
export class InternalController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly worker: WorkerService,
    private readonly statusService: StatusService,
  ) {}

  private authorize(auth?: string) {
    const secret = this.config.CRON_SECRET;
    if (!secret || !auth || !timingSafeEqual(digest(auth), digest(`Bearer ${secret}`)))
      throw unauthorized('INVALID_CRON_SECRET', 'Invalid scheduler credentials');
  }

  /** Monitoring (docs/RUNBOOK.md): 200 when healthy, 503 with the problems otherwise. Counts only. */
  @Public()
  @Get('status')
  async status(
    @Headers('authorization') auth: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.authorize(auth);
    const s = await this.statusService.status();
    res.status(s.ok ? 200 : 503);
    return s;
  }

  @Public()
  @All('tick')
  @HttpCode(200)
  tick(@Headers('authorization') auth?: string) {
    this.authorize(auth);
    return this.worker.tick();
  }
}
