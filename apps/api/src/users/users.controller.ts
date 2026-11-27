import {
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  CreateRoleAssignmentSchema,
  CreateUserSchema,
  PageQuerySchema,
  ReasonSchema,
  UpdateUserSchema,
  UserStatusChangeSchema,
  z,
} from '@crm/contracts';
import { CurrentPrincipal, RequirePermission } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { requireOrg } from '../common/scope';
import { ApiZodBody, ZBody, ZQuery } from '../common/zod';
import { UsersService } from './users.service';

const UserListQuery = PageQuerySchema.extend({
  status: z.enum(['INVITED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED']).optional(),
});

@ApiTags('users')
@Controller()
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('users')
  @RequirePermission('user.read')
  list(@CurrentPrincipal() p: Principal, @ZQuery(UserListQuery) q: z.infer<typeof UserListQuery>) {
    return this.users.list(requireOrg(p), q);
  }

  @Get('users/:id')
  @RequirePermission('user.read')
  get(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.users.get(requireOrg(p), id);
  }

  @Post('users')
  @RequirePermission('user.manage')
  @ApiZodBody(CreateUserSchema)
  create(
    @CurrentPrincipal() p: Principal,
    @ZBody(CreateUserSchema) body: z.infer<typeof CreateUserSchema>,
  ) {
    return this.users.create(requireOrg(p), body);
  }

  @Patch('users/:id')
  @RequirePermission('user.manage')
  @ApiZodBody(UpdateUserSchema)
  update(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(UpdateUserSchema) body: z.infer<typeof UpdateUserSchema>,
  ) {
    return this.users.update(requireOrg(p), id, body);
  }

  @Post('users/:id/status')
  @HttpCode(200)
  @RequirePermission('user.manage')
  @ApiZodBody(UserStatusChangeSchema)
  setStatus(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(UserStatusChangeSchema) body: z.infer<typeof UserStatusChangeSchema>,
  ) {
    return this.users.setStatus(requireOrg(p), id, body.status, body.reason);
  }

  @Post('users/:id/resend-invite')
  @HttpCode(204)
  @RequirePermission('user.manage')
  resendInvite(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.users.resendInvite(requireOrg(p), id);
  }

  @Get('users/:id/role-assignments')
  @RequirePermission('user.read')
  listAssignments(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('includeRevoked') includeRevoked?: string,
  ) {
    return this.users.listAssignments(requireOrg(p), id, includeRevoked === 'true');
  }

  @Post('users/:id/role-assignments')
  @RequirePermission('role.assign')
  @ApiZodBody(CreateRoleAssignmentSchema)
  grant(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(CreateRoleAssignmentSchema) body: z.infer<typeof CreateRoleAssignmentSchema>,
  ) {
    return this.users.grant(requireOrg(p), id, body);
  }

  @Post('role-assignments/:id/revoke')
  @HttpCode(200)
  @RequirePermission('role.assign')
  @ApiZodBody(ReasonSchema)
  revoke(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(ReasonSchema) body: z.infer<typeof ReasonSchema>,
  ) {
    return this.users.revoke(requireOrg(p), id, body.reason);
  }
}
