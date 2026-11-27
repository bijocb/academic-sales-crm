import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { LeadInput, LeadInputSchema, z } from '@crm/contracts';
import { Public } from '../auth/decorators';
import { ApiZodBody, ZBody } from '../common/zod';
import { IntakeKeyResolver } from './intake-keys';
import { IngestResult, IntakeService } from './intake.service';

function bearer(req: Request): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7).trim() : undefined;
}

/** What external callers learn: never details of existing people or leads. */
function publicResult(r: IngestResult) {
  return {
    outcome: r.outcome,
    reference: r.enquiryId ?? r.exceptionId,
    errors: r.errors,
    warnings: r.warnings,
  };
}

const INTAKE_THROTTLE = { default: { limit: 120, ttl: 60_000 } };

@ApiTags('intake')
@Controller()
export class IntakeController {
  constructor(
    private readonly keys: IntakeKeyResolver,
    private readonly intake: IntakeService,
  ) {}

  /**
   * Website / landing page / automation intake. `Authorization: Bearer crmk_…` (intake key).
   * 201 created or added · 200 replay of an earlier submission · 202 accepted into the exception queue.
   */
  @Public()
  @Throttle(INTAKE_THROTTLE)
  @Post('intake/leads')
  @ApiZodBody(LeadInputSchema)
  async submit(
    @Req() req: Request,
    @ZBody(LeadInputSchema) body: LeadInput,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ctx = await this.keys.resolve(bearer(req));
    const result = await this.intake.ingest(
      {
        organizationId: ctx.organizationId,
        brandId: ctx.brandId,
        channel: ctx.channel,
        sourceId: ctx.sourceId,
        exceptionOnInvalid: true,
        extra: { intakeKeyId: ctx.keyId },
      },
      body,
    );
    res.status(
      result.outcome === 'INVALID' ? 202 : result.outcome === 'DUPLICATE_REPLAY' ? 200 : 201,
    );
    return publicResult(result);
  }

  /**
   * Google Ads lead-form webhook. In Google Ads set the webhook URL to
   * /api/v1/webhooks/google-ads/<keyId> and the "key" to the intake key.
   * Always answers 200 for authenticated calls so Google does not retry valid deliveries.
   */
  @Public()
  @Throttle(INTAKE_THROTTLE)
  @Post('webhooks/google-ads/:keyId')
  @HttpCode(200)
  async googleAds(@Param('keyId', ParseUUIDPipe) keyId: string, @Body() body: unknown) {
    const parsed = GoogleLeadSchema.safeParse(body);
    const ctx = await this.keys.resolve(parsed.success ? parsed.data.google_key : undefined, keyId);
    if (!parsed.success) return { outcome: 'IGNORED', reason: 'Unrecognised payload' };
    const result = await this.intake.ingest(
      {
        organizationId: ctx.organizationId,
        brandId: ctx.brandId,
        channel: 'GOOGLE_ADS',
        sourceId: ctx.sourceId,
        exceptionOnInvalid: true,
        extra: {
          isTest: parsed.data.is_test ?? false,
          gclid: parsed.data.gcl_id,
          googleCampaignId: parsed.data.campaign_id,
        },
      },
      googleToLead(parsed.data),
    );
    return publicResult(result);
  }
}

const GoogleLeadSchema = z.object({
  lead_id: z.string().min(1),
  google_key: z.string().min(1),
  user_column_data: z
    .array(
      z.object({
        column_id: z.string().optional(),
        column_name: z.string().optional(),
        string_value: z.string().optional(),
      }),
    )
    .default([]),
  form_id: z.union([z.string(), z.number()]).optional(),
  campaign_id: z.union([z.string(), z.number()]).optional(),
  adgroup_id: z.union([z.string(), z.number()]).optional(),
  creative_id: z.union([z.string(), z.number()]).optional(),
  gcl_id: z.string().optional(),
  is_test: z.boolean().optional(),
});

/** Maps Google lead-form columns (FULL_NAME, PHONE_NUMBER, EMAIL, CITY, …) to LeadInput. */
export function googleToLead(g: z.infer<typeof GoogleLeadSchema>): LeadInput {
  const col = (id: string) =>
    g.user_column_data.find((c) => c.column_id === id)?.string_value?.trim();
  const name = col('FULL_NAME') ?? [col('FIRST_NAME'), col('LAST_NAME')].filter(Boolean).join(' ');
  const known = new Set(['FULL_NAME', 'FIRST_NAME', 'LAST_NAME', 'PHONE_NUMBER', 'EMAIL', 'CITY']);
  const answers = g.user_column_data
    .filter((c) => !c.column_id || !known.has(c.column_id))
    .map((c) => `${c.column_name ?? c.column_id}: ${c.string_value ?? ''}`)
    .join('\n');
  return {
    name: name || undefined,
    phone: col('PHONE_NUMBER'),
    email: col('EMAIL'),
    city: col('CITY'),
    message: answers || undefined,
    externalId: g.lead_id,
    formId: g.form_id !== undefined ? String(g.form_id) : undefined,
    adId: g.creative_id !== undefined ? String(g.creative_id) : undefined,
    adsetId: g.adgroup_id !== undefined ? String(g.adgroup_id) : undefined,
    utm_source: 'google',
    utm_medium: 'cpc',
    utm_campaign: g.campaign_id !== undefined ? String(g.campaign_id) : undefined,
  };
}
