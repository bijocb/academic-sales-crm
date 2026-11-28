import { Controller, Get, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  AI_SUGGESTION_KINDS,
  AiSettingsSchema,
  DismissSuggestionSchema,
  ScoreOverrideSchema,
  z,
} from '@crm/contracts';
import { CurrentPrincipal } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { badRequest } from '../common/errors';
import { requireOrg } from '../common/scope';
import { ApiZodBody, ZBody, ZQuery } from '../common/zod';
import { AiService } from './ai.service';

const BrandQ = z.object({ brandId: z.uuid() });
const kindOf = (k: string) => {
  if (!(AI_SUGGESTION_KINDS as readonly string[]).includes(k))
    throw badRequest('UNKNOWN_SUGGESTION', 'Unknown suggestion');
  return k as (typeof AI_SUGGESTION_KINDS)[number];
};

/** AI assistance (FR-006, FR-021). Advisory, explainable, in-house (A-045). */
@ApiTags('ai')
@Controller()
export class AiController {
  constructor(private readonly ai: AiService) {}

  @Get('leads/:id/ai')
  forLead(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.ai.forLead(requireOrg(p), id);
  }

  @Post('leads/:id/ai/override')
  @ApiZodBody(ScoreOverrideSchema)
  override(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(ScoreOverrideSchema) body: z.infer<typeof ScoreOverrideSchema>,
  ) {
    return this.ai.override(requireOrg(p), id, body);
  }

  @Post('leads/:id/ai/suggestions/:kind/accept')
  accept(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('kind') kind: string,
  ) {
    return this.ai.accept(requireOrg(p), id, kindOf(kind));
  }

  @Post('leads/:id/ai/suggestions/:kind/dismiss')
  @ApiZodBody(DismissSuggestionSchema)
  dismiss(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('kind') kind: string,
    @ZBody(DismissSuggestionSchema) body: z.infer<typeof DismissSuggestionSchema>,
  ) {
    return this.ai.dismiss(requireOrg(p), id, kindOf(kind), body);
  }

  @Get('ai-settings')
  settings(@CurrentPrincipal() p: Principal, @ZQuery(BrandQ) q: z.infer<typeof BrandQ>) {
    return this.ai.getSettings(requireOrg(p), q.brandId);
  }

  @Put('ai-settings')
  @ApiZodBody(AiSettingsSchema)
  updateSettings(
    @CurrentPrincipal() p: Principal,
    @ZQuery(BrandQ) q: z.infer<typeof BrandQ>,
    @ZBody(AiSettingsSchema) body: z.infer<typeof AiSettingsSchema>,
  ) {
    return this.ai.updateSettings(requireOrg(p), q.brandId, body);
  }

  @Post('ai-settings/:brandId/train')
  train(@CurrentPrincipal() p: Principal, @Param('brandId', ParseUUIDPipe) brandId: string) {
    return this.ai.trainNow(requireOrg(p), brandId);
  }

  @Get('ai-models')
  models(@CurrentPrincipal() p: Principal, @ZQuery(BrandQ) q: z.infer<typeof BrandQ>) {
    return this.ai.listModels(requireOrg(p), q.brandId);
  }
}
