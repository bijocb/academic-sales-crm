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
  CalendarPreviewQuerySchema,
  CreateHolidaySchema,
  SlaPolicySchema,
  UpdatePipelineStageSchema,
  WorkingHoursSchema,
  z,
} from '@crm/contracts';
import { CurrentPrincipal, RequirePermission } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { requireOrg } from '../common/scope';
import { ApiZodBody, ZBody, ZQuery } from '../common/zod';
import { SettingsService } from './settings.service';

@ApiTags('settings')
@Controller()
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get('brands/:id/working-hours')
  @RequirePermission('brand.read')
  getHours(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.settings.getWorkingHours(requireOrg(p), id);
  }

  @Put('brands/:id/working-hours')
  @RequirePermission('settings.manage')
  @ApiZodBody(WorkingHoursSchema)
  setHours(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(WorkingHoursSchema) body: z.infer<typeof WorkingHoursSchema>,
  ) {
    return this.settings.setWorkingHours(requireOrg(p), id, body);
  }

  @Get('brands/:id/holidays')
  @RequirePermission('brand.read')
  holidays(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.settings.listHolidays(requireOrg(p), id);
  }

  @Post('brands/:id/holidays')
  @RequirePermission('settings.manage')
  @ApiZodBody(CreateHolidaySchema)
  addHoliday(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(CreateHolidaySchema) body: z.infer<typeof CreateHolidaySchema>,
  ) {
    return this.settings.addHoliday(requireOrg(p), id, body);
  }

  @Delete('holidays/:id')
  @HttpCode(204)
  @RequirePermission('settings.manage')
  removeHoliday(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.settings.removeHoliday(requireOrg(p), id);
  }

  @Get('brands/:id/sla-policy')
  @RequirePermission('brand.read')
  getSla(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.settings.getSlaPolicy(requireOrg(p), id);
  }

  @Put('brands/:id/sla-policy')
  @RequirePermission('settings.manage')
  @ApiZodBody(SlaPolicySchema)
  setSla(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(SlaPolicySchema) body: z.infer<typeof SlaPolicySchema>,
  ) {
    return this.settings.setSlaPolicy(requireOrg(p), id, body);
  }

  @Get('brands/:id/pipeline-stages')
  @RequirePermission('brand.read')
  stages(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.settings.listStages(requireOrg(p), id);
  }

  @Patch('pipeline-stages/:id')
  @RequirePermission('settings.manage')
  @ApiZodBody(UpdatePipelineStageSchema)
  updateStage(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(UpdatePipelineStageSchema) body: z.infer<typeof UpdatePipelineStageSchema>,
  ) {
    return this.settings.updateStage(requireOrg(p), id, body);
  }

  @Get('brands/:id/calendar/preview')
  @RequirePermission('brand.read')
  preview(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZQuery(CalendarPreviewQuerySchema) q: z.infer<typeof CalendarPreviewQuerySchema>,
  ) {
    return this.settings.preview(requireOrg(p), id, new Date(q.start), q.minutes);
  }
}
