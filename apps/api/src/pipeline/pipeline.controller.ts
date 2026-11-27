import { Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  BulkTransitionSchema,
  CounsellingRecordSchema,
  CreateQuotationSchema,
  PipelineQuerySchema,
  QualificationSchema,
  QuotationDecisionSchema,
  RejectQuotationSchema,
  SavedViewSchema,
  StageTransitionSchema,
  z,
} from '@crm/contracts';
import { CurrentPrincipal } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { requireOrg } from '../common/scope';
import { ApiZodBody, ZBody, ZQuery } from '../common/zod';
import { AppointmentsService } from '../engagement/appointments.service';
import { PipelineService } from './pipeline.service';
import { QuotationsService } from './quotations.service';

const ViewsQ = z.object({ page: z.enum(['leads', 'pipeline']).optional() });

@ApiTags('pipeline')
@Controller()
export class PipelineController {
  constructor(
    private readonly pipeline: PipelineService,
    private readonly quotations: QuotationsService,
    private readonly appointments: AppointmentsService,
  ) {}

  @Get('pipeline')
  board(
    @CurrentPrincipal() p: Principal,
    @ZQuery(PipelineQuerySchema) q: z.infer<typeof PipelineQuerySchema>,
  ) {
    return this.pipeline.board(requireOrg(p), q);
  }

  @Get('leads/:id/stage')
  stage(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.pipeline.stageInfo(requireOrg(p), id);
  }

  @Post('leads/:id/stage-transitions')
  @ApiZodBody(StageTransitionSchema)
  transition(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(StageTransitionSchema) body: z.infer<typeof StageTransitionSchema>,
  ) {
    return this.pipeline.transition(requireOrg(p), id, body);
  }

  @Post('leads/bulk-transition')
  @ApiZodBody(BulkTransitionSchema)
  bulk(
    @CurrentPrincipal() p: Principal,
    @ZBody(BulkTransitionSchema) body: z.infer<typeof BulkTransitionSchema>,
  ) {
    return this.pipeline.bulkTransition(requireOrg(p), body);
  }

  @Get('leads/:id/qualification')
  qualification(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.pipeline.qualification(requireOrg(p), id);
  }

  @Put('leads/:id/qualification')
  @ApiZodBody(QualificationSchema)
  updateQualification(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(QualificationSchema) body: z.infer<typeof QualificationSchema>,
  ) {
    return this.pipeline.updateQualification(requireOrg(p), id, body);
  }

  @Post('leads/:id/counselling')
  @ApiZodBody(CounsellingRecordSchema)
  counselling(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(CounsellingRecordSchema) body: z.infer<typeof CounsellingRecordSchema>,
  ) {
    return this.appointments.record(requireOrg(p), id, body);
  }

  @Get('leads/:id/quotations')
  listQuotations(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.quotations.list(requireOrg(p), id);
  }

  @Post('leads/:id/quotations')
  @ApiZodBody(CreateQuotationSchema)
  quote(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(CreateQuotationSchema) body: z.infer<typeof CreateQuotationSchema>,
  ) {
    return this.quotations.create(requireOrg(p), id, body);
  }

  @Post('quotations/:id/accept')
  @ApiZodBody(QuotationDecisionSchema)
  accept(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(QuotationDecisionSchema) body: z.infer<typeof QuotationDecisionSchema>,
  ) {
    return this.quotations.accept(requireOrg(p), id, body);
  }

  @Post('quotations/:id/reject')
  @ApiZodBody(RejectQuotationSchema)
  reject(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(RejectQuotationSchema) body: z.infer<typeof RejectQuotationSchema>,
  ) {
    return this.quotations.reject(requireOrg(p), id, body);
  }

  @Get('saved-views')
  views(@CurrentPrincipal() p: Principal, @ZQuery(ViewsQ) q: z.infer<typeof ViewsQ>) {
    return this.pipeline.listViews(requireOrg(p), q.page);
  }

  @Post('saved-views')
  @ApiZodBody(SavedViewSchema)
  createView(
    @CurrentPrincipal() p: Principal,
    @ZBody(SavedViewSchema) body: z.infer<typeof SavedViewSchema>,
  ) {
    return this.pipeline.createView(requireOrg(p), body);
  }

  @Delete('saved-views/:id')
  @HttpCode(204)
  deleteView(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.pipeline.deleteView(requireOrg(p), id);
  }
}
