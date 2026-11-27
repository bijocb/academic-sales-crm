import { Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CreateRoleSchema, PERMISSIONS, UpdateRoleSchema, z } from '@crm/contracts';
import { CurrentPrincipal, RequirePermission } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { requireOrg } from '../common/scope';
import { ApiZodBody, ZBody } from '../common/zod';
import { RolesService } from './roles.service';

@ApiTags('roles')
@Controller()
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get('permissions')
  catalog() {
    return Object.entries(PERMISSIONS).map(([key, v]) => ({ key, ...v }));
  }

  @Get('roles')
  list(@CurrentPrincipal() p: Principal) {
    return this.roles.list(requireOrg(p));
  }

  @Post('roles')
  @RequirePermission('role.manage')
  @ApiZodBody(CreateRoleSchema)
  create(
    @CurrentPrincipal() p: Principal,
    @ZBody(CreateRoleSchema) body: z.infer<typeof CreateRoleSchema>,
  ) {
    return this.roles.create(requireOrg(p), body);
  }

  @Patch('roles/:id')
  @RequirePermission('role.manage')
  @ApiZodBody(UpdateRoleSchema)
  update(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(UpdateRoleSchema) body: z.infer<typeof UpdateRoleSchema>,
  ) {
    return this.roles.update(requireOrg(p), id, body);
  }
}
