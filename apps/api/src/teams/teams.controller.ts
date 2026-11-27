import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AddTeamMemberSchema, CreateTeamSchema, UpdateTeamSchema, z } from '@crm/contracts';
import { CurrentPrincipal, RequirePermission } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { requireOrg } from '../common/scope';
import { ApiZodBody, ZBody } from '../common/zod';
import { TeamsService } from './teams.service';

@ApiTags('teams')
@Controller('teams')
export class TeamsController {
  constructor(private readonly teams: TeamsService) {}

  @Get()
  @RequirePermission('team.read')
  async list(@CurrentPrincipal() p: Principal, @Query('brandId') brandId?: string) {
    if (brandId !== undefined) await new ParseUUIDPipe().transform(brandId, { type: 'query' });
    return this.teams.list(requireOrg(p), brandId);
  }

  @Get(':id')
  @RequirePermission('team.read')
  get(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.teams.get(requireOrg(p), id);
  }

  @Post()
  @RequirePermission('team.manage')
  @ApiZodBody(CreateTeamSchema)
  create(
    @CurrentPrincipal() p: Principal,
    @ZBody(CreateTeamSchema) body: z.infer<typeof CreateTeamSchema>,
  ) {
    return this.teams.create(requireOrg(p), body);
  }

  @Patch(':id')
  @RequirePermission('team.manage')
  @ApiZodBody(UpdateTeamSchema)
  update(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(UpdateTeamSchema) body: z.infer<typeof UpdateTeamSchema>,
  ) {
    return this.teams.update(requireOrg(p), id, body);
  }

  @Post(':id/members')
  @RequirePermission('team.manage')
  @ApiZodBody(AddTeamMemberSchema)
  addMember(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(AddTeamMemberSchema) body: z.infer<typeof AddTeamMemberSchema>,
  ) {
    return this.teams.addMember(requireOrg(p), id, body.userId);
  }

  @Delete(':id/members/:userId')
  @HttpCode(204)
  @RequirePermission('team.manage')
  removeMember(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.teams.removeMember(requireOrg(p), id, userId);
  }
}
