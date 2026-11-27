import { Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  CloseRecoverySchema,
  LossReasonSchema,
  MarkLostSchema,
  RecoveryAttemptSchema,
  RecoveryPolicySchema,
  RecoveryQueueQuerySchema,
  UpdateLossReasonSchema,
  z,
} from '@crm/contracts';
import { CurrentPrincipal } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { requireOrg } from '../common/scope';
import { ApiZodBody, ZBody, ZQuery } from '../common/zod';
import { RecoveryService } from './recovery.service';

const BrandQ = z.object({ brandId: z.uuid() });

@ApiTags('recovery')
@Controller()
export class RecoveryController {
  constructor(private readonly recovery: RecoveryService) {}

  @Post('leads/:id/lost')
  @ApiZodBody(MarkLostSchema)
  markLost(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(MarkLostSchema) body: z.infer<typeof MarkLostSchema>,
  ) {
    return this.recovery.markLost(requireOrg(p), id, body);
  }

  @Get('leads/:id/recovery')
  forLead(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.recovery.forLead(requireOrg(p), id);
  }

  @Get('recovery')
  queue(
    @CurrentPrincipal() p: Principal,
    @ZQuery(RecoveryQueueQuerySchema) q: z.infer<typeof RecoveryQueueQuerySchema>,
  ) {
    return this.recovery.queue(requireOrg(p), q);
  }

  @Get('recovery/policy')
  policy(@CurrentPrincipal() p: Principal, @ZQuery(BrandQ) q: z.infer<typeof BrandQ>) {
    return this.recovery.getPolicy(requireOrg(p), q.brandId);
  }

  @Put('recovery/policy')
  @ApiZodBody(RecoveryPolicySchema)
  updatePolicy(
    @CurrentPrincipal() p: Principal,
    @ZQuery(BrandQ) q: z.infer<typeof BrandQ>,
    @ZBody(RecoveryPolicySchema) body: z.infer<typeof RecoveryPolicySchema>,
  ) {
    return this.recovery.updatePolicy(requireOrg(p), q.brandId, body);
  }

  @Post('recovery/:id/start')
  start(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.recovery.startNow(requireOrg(p), id);
  }

  @Post('recovery/:id/attempts')
  @ApiZodBody(RecoveryAttemptSchema)
  attempt(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(RecoveryAttemptSchema) body: z.infer<typeof RecoveryAttemptSchema>,
  ) {
    return this.recovery.attempt(requireOrg(p), id, body);
  }

  @Post('recovery/:id/close')
  @ApiZodBody(CloseRecoverySchema)
  close(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(CloseRecoverySchema) body: z.infer<typeof CloseRecoverySchema>,
  ) {
    return this.recovery.close(requireOrg(p), id, body);
  }

  @Get('loss-reasons')
  lossReasons(@CurrentPrincipal() p: Principal, @ZQuery(BrandQ) q: z.infer<typeof BrandQ>) {
    return this.recovery.lossReasons(requireOrg(p), q.brandId);
  }

  @Post('loss-reasons')
  @ApiZodBody(LossReasonSchema)
  createLossReason(
    @CurrentPrincipal() p: Principal,
    @ZBody(LossReasonSchema) body: z.infer<typeof LossReasonSchema>,
  ) {
    return this.recovery.createLossReason(requireOrg(p), body);
  }

  @Patch('loss-reasons/:id')
  @ApiZodBody(UpdateLossReasonSchema)
  updateLossReason(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(UpdateLossReasonSchema) body: z.infer<typeof UpdateLossReasonSchema>,
  ) {
    return this.recovery.updateLossReason(requireOrg(p), id, body);
  }
}
