import { All, Controller, Headers, HttpCode, Inject } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Public } from '../auth/decorators';
import { unauthorized } from '../common/errors';
import { APP_CONFIG, AppConfig } from '../config';
import { WorkerService } from './worker.service';

const digest = (s: string) => createHash('sha256').update(s).digest();

/** Scheduler entry point for serverless hosting (Vercel Cron sends `Authorization: Bearer $CRON_SECRET`). */
@ApiExcludeController()
@Controller('internal')
export class InternalController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly worker: WorkerService,
  ) {}

  @Public()
  @All('tick')
  @HttpCode(200)
  tick(@Headers('authorization') auth?: string) {
    const secret = this.config.CRON_SECRET;
    if (!secret || !auth || !timingSafeEqual(digest(auth), digest(`Bearer ${secret}`)))
      throw unauthorized('INVALID_CRON_SECRET', 'Invalid scheduler credentials');
    return this.worker.tick();
  }
}
