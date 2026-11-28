import { Controller, Get, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AssistantAskSchema, AssistantSettingsSchema, InsightQuerySchema, z } from '@crm/contracts';
import { AssistantService } from '../assistant/assistant.service';
import { CurrentPrincipal } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { requireOrg } from '../common/scope';
import { ApiZodBody, ZBody, ZQuery } from '../common/zod';
import { InsightsService } from './insights.service';

const HistoryQ = z.object({ all: z.enum(['true', 'false']).default('false') });

@ApiTags('insights')
@Controller()
export class InsightsController {
  constructor(
    private readonly insights: InsightsService,
    private readonly assistant: AssistantService,
  ) {}

  /** Management insights in the caller's report scope (A-051). */
  @Get('insights')
  list(
    @CurrentPrincipal() p: Principal,
    @ZQuery(InsightQuerySchema) q: z.infer<typeof InsightQuerySchema>,
  ) {
    return this.insights.compute(requireOrg(p), q);
  }

  /** Assistant status for the page: on/off, configured, sandbox, usage (A-052). */
  @Get('assistant')
  status(@CurrentPrincipal() p: Principal) {
    return this.assistant.status(requireOrg(p));
  }

  @Patch('assistant/settings')
  @ApiZodBody(AssistantSettingsSchema)
  settings(
    @CurrentPrincipal() p: Principal,
    @ZBody(AssistantSettingsSchema) body: z.infer<typeof AssistantSettingsSchema>,
  ) {
    return this.assistant.updateSettings(requireOrg(p), body);
  }

  @Post('assistant/ask')
  @ApiZodBody(AssistantAskSchema)
  ask(
    @CurrentPrincipal() p: Principal,
    @ZBody(AssistantAskSchema) body: z.infer<typeof AssistantAskSchema>,
  ) {
    return this.assistant.ask(requireOrg(p), body);
  }

  @Get('assistant/questions')
  history(@CurrentPrincipal() p: Principal, @ZQuery(HistoryQ) q: z.infer<typeof HistoryQ>) {
    return this.assistant.history(requireOrg(p), q.all === 'true');
  }
}
