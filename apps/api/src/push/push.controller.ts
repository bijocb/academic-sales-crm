import { Controller, HttpCode, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from '@crm/contracts';
import { CurrentPrincipal } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { requireOrg } from '../common/scope';
import { ApiZodBody, ZBody } from '../common/zod';
import { PushService } from './push.service';

const RegisterSchema = z.object({
  token: z.string().trim().min(10).max(200),
  platform: z.enum(['ios', 'android', 'web']),
  appVersion: z.string().trim().max(40).optional(),
});
const RemoveSchema = z.object({ token: z.string().trim().min(10).max(200) });

/** The mobile app registers the phone for push notifications after sign-in, and removes it on sign-out. */
@ApiTags('mobile')
@Controller('me/push-devices')
export class PushController {
  constructor(private readonly push: PushService) {}

  @Post()
  @ApiZodBody(RegisterSchema)
  register(
    @CurrentPrincipal() p: Principal,
    @ZBody(RegisterSchema) body: z.infer<typeof RegisterSchema>,
  ) {
    return this.push.register(requireOrg(p), body);
  }

  @Post('remove')
  @HttpCode(200)
  @ApiZodBody(RemoveSchema)
  remove(
    @CurrentPrincipal() p: Principal,
    @ZBody(RemoveSchema) body: z.infer<typeof RemoveSchema>,
  ) {
    return this.push.unregister(requireOrg(p), body.token);
  }
}
