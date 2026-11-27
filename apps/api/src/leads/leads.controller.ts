import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  CreateCampaignSchema,
  DismissDuplicateSchema,
  LeadNoteSchema,
  MergeDuplicateSchema,
  UpdateLeadProfileSchema,
  CreateImportSchema,
  CreateIntakeKeySchema,
  CreateLeadSourceSchema,
  DiscardExceptionSchema,
  ImportRowsSchema,
  LeadListQuerySchema,
  ManualLeadSchema,
  PageQuerySchema,
  ResolveExceptionSchema,
  UpdateCampaignSchema,
  UpdateLeadSourceSchema,
  ValidateImportSchema,
  z,
} from '@crm/contracts';
import { CurrentPrincipal, RequirePermission } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { badRequest, forbidden } from '../common/errors';
import { requireOrg } from '../common/scope';
import { ApiZodBody, ZBody, ZQuery } from '../common/zod';
import { IntakeAdminService } from './intake-admin.service';
import { LeadConfigService } from './lead-config.service';
import { LeadsService } from './leads.service';
import { DuplicatesService } from './duplicates.service';

const BrandQuery = z.object({ brandId: z.uuid().optional() });
const DuplicateQuery = z.object({
  status: z.enum(['OPEN', 'MERGED', 'DISMISSED']).default('OPEN'),
});
const PreviewQuery = z.object({ survivor: z.enum(['A', 'B']).default('A') });
const ExceptionQuery = PageQuerySchema.extend({
  brandId: z.uuid().optional(),
  status: z.enum(['OPEN', 'RESOLVED', 'DISCARDED']).optional(),
});

@ApiTags('leads')
@Controller()
export class LeadsController {
  constructor(
    private readonly leads: LeadsService,
    private readonly config: LeadConfigService,
    private readonly admin: IntakeAdminService,
    private readonly duplicates: DuplicatesService,
  ) {}

  // ------------------------------------------------------ lead workspace
  @Get('leads/:id/timeline')
  timeline(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.leads.timeline(requireOrg(p), id);
  }

  @Post('leads/:id/notes')
  @ApiZodBody(LeadNoteSchema)
  note(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(LeadNoteSchema) body: z.infer<typeof LeadNoteSchema>,
  ) {
    return this.leads.addNote(requireOrg(p), id, body.body);
  }

  @Patch('leads/:id/profile')
  @ApiZodBody(UpdateLeadProfileSchema)
  profile(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(UpdateLeadProfileSchema) body: z.infer<typeof UpdateLeadProfileSchema>,
  ) {
    return this.leads.updateProfile(requireOrg(p), id, body);
  }

  // ------------------------------------------------------------ duplicates
  @Get('duplicates')
  @RequirePermission('lead.merge')
  duplicateList(
    @CurrentPrincipal() p: Principal,
    @ZQuery(DuplicateQuery) q: z.infer<typeof DuplicateQuery>,
  ) {
    return this.duplicates.list(requireOrg(p), q.status);
  }

  @Post('duplicates/scan')
  @HttpCode(200)
  @RequirePermission('lead.merge')
  scan(@CurrentPrincipal() p: Principal) {
    return this.duplicates.scan(requireOrg(p));
  }

  @Get('duplicates/:id')
  @RequirePermission('lead.merge')
  duplicatePreview(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZQuery(PreviewQuery) q: z.infer<typeof PreviewQuery>,
  ) {
    return this.duplicates.preview(requireOrg(p), id, q.survivor);
  }

  @Post('duplicates/:id/merge')
  @HttpCode(200)
  @RequirePermission('lead.merge')
  @ApiZodBody(MergeDuplicateSchema)
  merge(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(MergeDuplicateSchema) body: z.infer<typeof MergeDuplicateSchema>,
  ) {
    return this.duplicates.merge(requireOrg(p), id, body);
  }

  @Post('duplicates/:id/dismiss')
  @HttpCode(200)
  @RequirePermission('lead.merge')
  @ApiZodBody(DismissDuplicateSchema)
  dismissDuplicate(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(DismissDuplicateSchema) body: z.infer<typeof DismissDuplicateSchema>,
  ) {
    return this.duplicates.dismiss(requireOrg(p), id, body.note);
  }

  // ---------------------------------------------------------------- leads
  @Get('leads')
  list(
    @CurrentPrincipal() p: Principal,
    @ZQuery(LeadListQuerySchema) q: z.infer<typeof LeadListQuerySchema>,
  ) {
    const o = requireOrg(p);
    if (!o.authz.has('lead.read') && !o.authz.has('lead.read_own')) throw forbidden();
    return this.leads.list(o, q);
  }

  @Get('leads/:id')
  get(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.leads.get(requireOrg(p), id);
  }

  @Post('leads')
  @RequirePermission('lead.create')
  @ApiZodBody(ManualLeadSchema)
  async create(
    @CurrentPrincipal() p: Principal,
    @ZBody(ManualLeadSchema) body: z.infer<typeof ManualLeadSchema>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.leads.createManual(requireOrg(p), body);
    if (result.outcome === 'INVALID')
      throw badRequest('VALIDATION_ERROR', 'The lead could not be saved', result.errors);
    res.status(result.outcome === 'DUPLICATE_REPLAY' ? 200 : 201);
    return result;
  }

  // ----------------------------------------------------- sources/campaigns
  @Get('lead-sources')
  sources(@CurrentPrincipal() p: Principal, @ZQuery(BrandQuery) q: z.infer<typeof BrandQuery>) {
    return this.config.listSources(requireOrg(p), q.brandId);
  }

  @Post('lead-sources')
  @RequirePermission('campaign.manage')
  @ApiZodBody(CreateLeadSourceSchema)
  createSource(
    @CurrentPrincipal() p: Principal,
    @ZBody(CreateLeadSourceSchema) body: z.infer<typeof CreateLeadSourceSchema>,
  ) {
    return this.config.createSource(requireOrg(p), body);
  }

  @Patch('lead-sources/:id')
  @RequirePermission('campaign.manage')
  @ApiZodBody(UpdateLeadSourceSchema)
  updateSource(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(UpdateLeadSourceSchema) body: z.infer<typeof UpdateLeadSourceSchema>,
  ) {
    return this.config.updateSource(requireOrg(p), id, body);
  }

  @Get('campaigns')
  campaigns(@CurrentPrincipal() p: Principal, @ZQuery(BrandQuery) q: z.infer<typeof BrandQuery>) {
    return this.config.listCampaigns(requireOrg(p), q.brandId);
  }

  @Post('campaigns')
  @RequirePermission('campaign.manage')
  @ApiZodBody(CreateCampaignSchema)
  createCampaign(
    @CurrentPrincipal() p: Principal,
    @ZBody(CreateCampaignSchema) body: z.infer<typeof CreateCampaignSchema>,
  ) {
    return this.config.createCampaign(requireOrg(p), body);
  }

  @Patch('campaigns/:id')
  @RequirePermission('campaign.manage')
  @ApiZodBody(UpdateCampaignSchema)
  updateCampaign(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(UpdateCampaignSchema) body: z.infer<typeof UpdateCampaignSchema>,
  ) {
    return this.config.updateCampaign(requireOrg(p), id, body);
  }

  // ------------------------------------------------------------ intake keys
  @Get('intake-keys')
  @RequirePermission('integration.manage')
  keys(@CurrentPrincipal() p: Principal, @ZQuery(BrandQuery) q: z.infer<typeof BrandQuery>) {
    return this.config.listKeys(requireOrg(p), q.brandId);
  }

  @Post('intake-keys')
  @RequirePermission('integration.manage')
  @ApiZodBody(CreateIntakeKeySchema)
  createKey(
    @CurrentPrincipal() p: Principal,
    @ZBody(CreateIntakeKeySchema) body: z.infer<typeof CreateIntakeKeySchema>,
  ) {
    return this.config.createKey(requireOrg(p), body);
  }

  @Delete('intake-keys/:id')
  @HttpCode(204)
  @RequirePermission('integration.manage')
  revokeKey(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.config.revokeKey(requireOrg(p), id);
  }

  // ------------------------------------------------------------- exceptions
  @Get('intake-exceptions')
  @RequirePermission('lead.import')
  exceptions(
    @CurrentPrincipal() p: Principal,
    @ZQuery(ExceptionQuery) q: z.infer<typeof ExceptionQuery>,
  ) {
    return this.admin.listExceptions(requireOrg(p), q);
  }

  @Post('intake-exceptions/:id/resolve')
  @HttpCode(200)
  @RequirePermission('lead.import')
  @ApiZodBody(ResolveExceptionSchema)
  resolve(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(ResolveExceptionSchema) body: z.infer<typeof ResolveExceptionSchema>,
  ) {
    return this.admin.resolveException(requireOrg(p), id, body.lead, body.note);
  }

  @Post('intake-exceptions/:id/discard')
  @HttpCode(200)
  @RequirePermission('lead.import')
  @ApiZodBody(DiscardExceptionSchema)
  discard(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(DiscardExceptionSchema) body: z.infer<typeof DiscardExceptionSchema>,
  ) {
    return this.admin.discardException(requireOrg(p), id, body.reason);
  }

  // ---------------------------------------------------------------- imports
  @Get('lead-imports')
  @RequirePermission('lead.import')
  imports(@CurrentPrincipal() p: Principal, @ZQuery(BrandQuery) q: z.infer<typeof BrandQuery>) {
    return this.admin.listImports(requireOrg(p), q.brandId);
  }

  @Post('lead-imports/validate')
  @HttpCode(200)
  @RequirePermission('lead.import')
  @ApiZodBody(ValidateImportSchema)
  validate(
    @CurrentPrincipal() p: Principal,
    @ZBody(ValidateImportSchema) body: z.infer<typeof ValidateImportSchema>,
  ) {
    return this.admin.validateRows(requireOrg(p), body.brandId, body.rows);
  }

  @Post('lead-imports')
  @RequirePermission('lead.import')
  @ApiZodBody(CreateImportSchema)
  createImport(
    @CurrentPrincipal() p: Principal,
    @ZBody(CreateImportSchema) body: z.infer<typeof CreateImportSchema>,
  ) {
    return this.admin.createImport(requireOrg(p), body);
  }

  @Post('lead-imports/:id/rows')
  @HttpCode(200)
  @RequirePermission('lead.import')
  @ApiZodBody(ImportRowsSchema)
  rows(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(ImportRowsSchema) body: z.infer<typeof ImportRowsSchema>,
  ) {
    return this.admin.importRows(requireOrg(p), id, body.rows);
  }

  @Post('lead-imports/:id/complete')
  @HttpCode(200)
  @RequirePermission('lead.import')
  complete(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.admin.completeImport(requireOrg(p), id);
  }
}
