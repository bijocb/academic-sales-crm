import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  AllocationRuleSchema,
  AllocationSettingsSchema,
  AssignLeadSchema,
  AvailabilitySchema,
  CreateLeaveSchema,
  ReorderRulesSchema,
  UpdateAllocationRuleSchema,
  z,
} from '@crm/contracts';
import { CurrentPrincipal, RequirePermission } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { forbidden } from '../common/errors';
import { requireOrg } from '../common/scope';
import { ApiZodBody, ZBody, ZQuery } from '../common/zod';
import { AllocationAdminService } from './allocation-admin.service';
import { AllocationService } from './allocation.service';
import { NotificationsService } from './notifications.service';

const BrandQ = z.object({ brandId: z.uuid() });
const RunsQ = z.object({ brandId: z.uuid().optional(), leadId: z.uuid().optional() });
const DrainQ = z.object({
  brandId: z.uuid(),
  ignoreWorkingHours: z.enum(['true', 'false']).optional(),
});
const NotifQ = z.object({ unread: z.enum(['true', 'false']).optional() });

@ApiTags('allocation')
@Controller()
export class AllocationController {
  constructor(
    private readonly admin: AllocationAdminService,
    private readonly engine: AllocationService,
    private readonly notifications: NotificationsService,
  ) {}

  @Get('allocation/settings')
  settings(@CurrentPrincipal() p: Principal, @ZQuery(BrandQ) q: z.infer<typeof BrandQ>) {
    return this.admin.getSettings(requireOrg(p), q.brandId);
  }

  @Patch('allocation/settings')
  @RequirePermission('allocation.manage')
  @ApiZodBody(AllocationSettingsSchema)
  updateSettings(
    @CurrentPrincipal() p: Principal,
    @ZQuery(BrandQ) q: z.infer<typeof BrandQ>,
    @ZBody(AllocationSettingsSchema) body: z.infer<typeof AllocationSettingsSchema>,
  ) {
    return this.admin.updateSettings(requireOrg(p), q.brandId, body);
  }

  @Get('allocation/rules')
  rules(@CurrentPrincipal() p: Principal, @ZQuery(BrandQ) q: z.infer<typeof BrandQ>) {
    return this.admin.listRules(requireOrg(p), q.brandId);
  }

  @Post('allocation/rules')
  @RequirePermission('allocation.manage')
  @ApiZodBody(AllocationRuleSchema)
  createRule(
    @CurrentPrincipal() p: Principal,
    @ZBody(AllocationRuleSchema) body: z.infer<typeof AllocationRuleSchema>,
  ) {
    return this.admin.createRule(requireOrg(p), body);
  }

  @Patch('allocation/rules/:id')
  @RequirePermission('allocation.manage')
  @ApiZodBody(UpdateAllocationRuleSchema)
  updateRule(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(UpdateAllocationRuleSchema) body: z.infer<typeof UpdateAllocationRuleSchema>,
  ) {
    return this.admin.updateRule(requireOrg(p), id, body);
  }

  @Delete('allocation/rules/:id')
  @HttpCode(204)
  @RequirePermission('allocation.manage')
  deleteRule(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.admin.deleteRule(requireOrg(p), id);
  }

  @Put('allocation/rules/order')
  @RequirePermission('allocation.manage')
  @ApiZodBody(ReorderRulesSchema)
  reorder(
    @CurrentPrincipal() p: Principal,
    @ZBody(ReorderRulesSchema) body: z.infer<typeof ReorderRulesSchema>,
  ) {
    return this.admin.reorderRules(requireOrg(p), body.brandId, body.ruleIds);
  }

  @Get('allocation/queue')
  queue(@CurrentPrincipal() p: Principal, @ZQuery(BrandQ) q: z.infer<typeof BrandQ>) {
    return this.admin.queue(requireOrg(p), q.brandId);
  }

  @Post('allocation/queue/allocate')
  @HttpCode(200)
  drain(@CurrentPrincipal() p: Principal, @ZQuery(DrainQ) q: z.infer<typeof DrainQ>) {
    return this.admin.drain(requireOrg(p), q.brandId, q.ignoreWorkingHours === 'true');
  }

  @Get('allocation/executives')
  executives(@CurrentPrincipal() p: Principal, @ZQuery(BrandQ) q: z.infer<typeof BrandQ>) {
    return this.admin.executives(requireOrg(p), q.brandId);
  }

  @Get('allocation/runs')
  runs(@CurrentPrincipal() p: Principal, @ZQuery(RunsQ) q: z.infer<typeof RunsQ>) {
    return this.admin.runs(requireOrg(p), q);
  }

  @Post('leads/:id/allocate')
  @HttpCode(200)
  retry(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZQuery(z.object({ ignoreWorkingHours: z.enum(['true', 'false']).optional() }))
    q: { ignoreWorkingHours?: string },
  ) {
    return this.admin.retry(requireOrg(p), id, q.ignoreWorkingHours === 'true');
  }

  @Post('leads/:id/assign')
  @HttpCode(200)
  @ApiZodBody(AssignLeadSchema)
  assign(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(AssignLeadSchema) body: z.infer<typeof AssignLeadSchema>,
  ) {
    const o = requireOrg(p);
    if (!o.authz.has('lead.assign') && !o.authz.has('lead.reassign')) throw forbidden();
    return this.engine.manualAssign(o, id, body.userId, body.reason);
  }

  @Get('leads/:id/assignments')
  history(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.admin.history(requireOrg(p), id);
  }

  @Get('me/availability')
  myAvailability(@CurrentPrincipal() p: Principal) {
    return this.admin.myAvailability(requireOrg(p));
  }

  @Put('me/availability')
  @ApiZodBody(AvailabilitySchema)
  setAvailability(
    @CurrentPrincipal() p: Principal,
    @ZBody(AvailabilitySchema) body: z.infer<typeof AvailabilitySchema>,
  ) {
    return this.admin.setAvailability(requireOrg(p), body.isAvailable);
  }

  @Get('users/:id/leaves')
  leaves(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.admin.listLeaves(requireOrg(p), id);
  }

  @Post('users/:id/leaves')
  @ApiZodBody(CreateLeaveSchema)
  addLeave(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(CreateLeaveSchema) body: z.infer<typeof CreateLeaveSchema>,
  ) {
    return this.admin.addLeave(requireOrg(p), id, body);
  }

  @Delete('leaves/:id')
  @HttpCode(204)
  cancelLeave(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.admin.cancelLeave(requireOrg(p), id);
  }

  @Get('notifications')
  notificationsList(@CurrentPrincipal() p: Principal, @ZQuery(NotifQ) q: z.infer<typeof NotifQ>) {
    return this.notifications.list(requireOrg(p), q.unread === 'true');
  }

  @Post('notifications/read')
  @HttpCode(200)
  readAll(@CurrentPrincipal() p: Principal) {
    return this.notifications.markRead(requireOrg(p));
  }

  @Post('notifications/:id/read')
  @HttpCode(200)
  readOne(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.notifications.markRead(requireOrg(p), id);
  }
}
