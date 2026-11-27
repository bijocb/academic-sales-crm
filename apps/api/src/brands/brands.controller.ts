import { Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  CreateBranchSchema,
  CreateBrandSchema,
  UpdateBranchSchema,
  UpdateBrandSchema,
  z,
} from '@crm/contracts';
import { CurrentPrincipal, RequirePermission } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { requireOrg } from '../common/scope';
import { ApiZodBody, ZBody } from '../common/zod';
import { BrandsService } from './brands.service';

@ApiTags('brands')
@Controller()
export class BrandsController {
  constructor(private readonly brands: BrandsService) {}

  @Get('brands')
  @RequirePermission('brand.read')
  list(@CurrentPrincipal() p: Principal) {
    return this.brands.listBrands(requireOrg(p));
  }

  @Get('brands/:id')
  @RequirePermission('brand.read')
  get(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.brands.getBrand(requireOrg(p), id);
  }

  @Post('brands')
  @RequirePermission('brand.manage')
  @ApiZodBody(CreateBrandSchema)
  create(
    @CurrentPrincipal() p: Principal,
    @ZBody(CreateBrandSchema) body: z.infer<typeof CreateBrandSchema>,
  ) {
    return this.brands.createBrand(requireOrg(p), body);
  }

  @Patch('brands/:id')
  @RequirePermission('brand.manage')
  @ApiZodBody(UpdateBrandSchema)
  update(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(UpdateBrandSchema) body: z.infer<typeof UpdateBrandSchema>,
  ) {
    return this.brands.updateBrand(requireOrg(p), id, body);
  }

  @Get('branches')
  @RequirePermission('brand.read')
  async listBranches(@CurrentPrincipal() p: Principal, @Query('brandId') brandId?: string) {
    if (brandId !== undefined) await new ParseUUIDPipe().transform(brandId, { type: 'query' });
    return this.brands.listBranches(requireOrg(p), brandId);
  }

  @Post('branches')
  @RequirePermission('branch.manage')
  @ApiZodBody(CreateBranchSchema)
  createBranch(
    @CurrentPrincipal() p: Principal,
    @ZBody(CreateBranchSchema) body: z.infer<typeof CreateBranchSchema>,
  ) {
    return this.brands.createBranch(requireOrg(p), body);
  }

  @Patch('branches/:id')
  @RequirePermission('branch.manage')
  @ApiZodBody(UpdateBranchSchema)
  updateBranch(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(UpdateBranchSchema) body: z.infer<typeof UpdateBranchSchema>,
  ) {
    return this.brands.updateBranch(requireOrg(p), id, body);
  }
}
