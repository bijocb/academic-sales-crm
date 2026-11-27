import { Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CreateOrganizationSchema, ReasonSchema, z } from '@crm/contracts';
import { PlatformAdminOnly } from '../auth/decorators';
import { ApiZodBody, ZBody } from '../common/zod';
import { OrganizationsAdminService } from './organizations.service';

@ApiTags('platform')
@PlatformAdminOnly()
@Controller('platform/organizations')
export class OrganizationsAdminController {
  constructor(private readonly orgs: OrganizationsAdminService) {}

  @Get()
  list() {
    return this.orgs.list();
  }

  @Post()
  @ApiZodBody(CreateOrganizationSchema)
  create(@ZBody(CreateOrganizationSchema) body: z.infer<typeof CreateOrganizationSchema>) {
    return this.orgs.create(body);
  }

  @Post(':id/suspend')
  @ApiZodBody(ReasonSchema)
  suspend(@Param('id', ParseUUIDPipe) id: string, @ZBody(ReasonSchema) body: { reason: string }) {
    return this.orgs.setStatus(id, 'SUSPENDED', body.reason);
  }

  @Post(':id/activate')
  @ApiZodBody(ReasonSchema)
  activate(@Param('id', ParseUUIDPipe) id: string, @ZBody(ReasonSchema) body: { reason: string }) {
    return this.orgs.setStatus(id, 'ACTIVE', body.reason);
  }
}
