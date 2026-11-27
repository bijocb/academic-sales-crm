import { Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  CancelTaskSchema,
  CompleteTaskSchema,
  CreateTaskSchema,
  HoldLeadSchema,
  RescheduleTaskSchema,
  ResumeLeadSchema,
  TaskListQuerySchema,
  z,
} from '@crm/contracts';
import { CurrentPrincipal } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { requireOrg } from '../common/scope';
import { ApiZodBody, ZBody, ZQuery } from '../common/zod';
import { WorkService } from './work.service';

const BrandQ = z.object({ brandId: z.uuid().optional() });
const JobsQ = z.object({
  status: z.enum(['PENDING', 'RUNNING', 'DONE', 'DEAD', 'CANCELLED']).optional(),
});

@ApiTags('tasks')
@Controller()
export class WorkController {
  constructor(private readonly work: WorkService) {}

  @Get('tasks')
  list(
    @CurrentPrincipal() p: Principal,
    @ZQuery(TaskListQuerySchema) q: z.infer<typeof TaskListQuerySchema>,
  ) {
    return this.work.list(requireOrg(p), q);
  }

  @Get('leads/:id/tasks')
  forLead(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.work.forLead(requireOrg(p), id);
  }

  @Post('leads/:id/tasks')
  @ApiZodBody(CreateTaskSchema)
  create(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(CreateTaskSchema) body: z.infer<typeof CreateTaskSchema>,
  ) {
    return this.work.create(requireOrg(p), id, body);
  }

  @Post('tasks/:id/complete')
  @ApiZodBody(CompleteTaskSchema)
  complete(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(CompleteTaskSchema) body: z.infer<typeof CompleteTaskSchema>,
  ) {
    return this.work.complete(requireOrg(p), id, body);
  }

  @Post('tasks/:id/reschedule')
  @ApiZodBody(RescheduleTaskSchema)
  reschedule(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(RescheduleTaskSchema) body: z.infer<typeof RescheduleTaskSchema>,
  ) {
    return this.work.reschedule(requireOrg(p), id, body);
  }

  @Post('tasks/:id/cancel')
  @ApiZodBody(CancelTaskSchema)
  cancel(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(CancelTaskSchema) body: z.infer<typeof CancelTaskSchema>,
  ) {
    return this.work.cancel(requireOrg(p), id, body);
  }

  @Post('leads/:id/hold')
  @ApiZodBody(HoldLeadSchema)
  hold(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(HoldLeadSchema) body: z.infer<typeof HoldLeadSchema>,
  ) {
    return this.work.hold(requireOrg(p), id, body);
  }

  @Post('leads/:id/resume')
  @ApiZodBody(ResumeLeadSchema)
  resume(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(ResumeLeadSchema) body: z.infer<typeof ResumeLeadSchema>,
  ) {
    return this.work.resume(requireOrg(p), id, body);
  }

  @Get('leads/:id/sla')
  leadSla(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.work.leadSla(requireOrg(p), id);
  }

  @Get('sla/overview')
  overview(@CurrentPrincipal() p: Principal, @ZQuery(BrandQ) q: z.infer<typeof BrandQ>) {
    return this.work.overview(requireOrg(p), q.brandId);
  }

  @Get('ops/jobs')
  jobs(@CurrentPrincipal() p: Principal, @ZQuery(JobsQ) q: z.infer<typeof JobsQ>) {
    return this.work.jobsList(requireOrg(p), q.status);
  }

  @Post('ops/jobs/:id/retry')
  retryJob(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.work.retryJob(requireOrg(p), id);
  }
}
