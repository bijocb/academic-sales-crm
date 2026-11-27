import { Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  CreateBatchSchema,
  CreateCourseCategorySchema,
  CreateCourseSchema,
  UpdateBatchSchema,
  UpdateCourseCategorySchema,
  UpdateCourseSchema,
  z,
} from '@crm/contracts';
import { CurrentPrincipal, RequirePermission } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { requireOrg } from '../common/scope';
import { ApiZodBody, ZBody, ZQuery } from '../common/zod';
import { CatalogService } from './catalog.service';

const BrandQuery = z.object({ brandId: z.uuid().optional() });
const CourseQuery = BrandQuery.extend({
  status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
  q: z.string().trim().max(100).optional(),
});
const BatchQuery = BrandQuery.extend({
  courseId: z.uuid().optional(),
  status: z.enum(['PLANNED', 'OPEN', 'CLOSED', 'CANCELLED']).optional(),
});

@ApiTags('catalog')
@Controller()
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('course-categories')
  @RequirePermission('course.read')
  listCategories(
    @CurrentPrincipal() p: Principal,
    @ZQuery(BrandQuery) q: z.infer<typeof BrandQuery>,
  ) {
    return this.catalog.listCategories(requireOrg(p), q.brandId);
  }

  @Post('course-categories')
  @RequirePermission('course.manage')
  @ApiZodBody(CreateCourseCategorySchema)
  createCategory(
    @CurrentPrincipal() p: Principal,
    @ZBody(CreateCourseCategorySchema) body: z.infer<typeof CreateCourseCategorySchema>,
  ) {
    return this.catalog.createCategory(requireOrg(p), body);
  }

  @Patch('course-categories/:id')
  @RequirePermission('course.manage')
  @ApiZodBody(UpdateCourseCategorySchema)
  updateCategory(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(UpdateCourseCategorySchema) body: z.infer<typeof UpdateCourseCategorySchema>,
  ) {
    return this.catalog.updateCategory(requireOrg(p), id, body);
  }

  @Get('courses')
  @RequirePermission('course.read')
  listCourses(
    @CurrentPrincipal() p: Principal,
    @ZQuery(CourseQuery) q: z.infer<typeof CourseQuery>,
  ) {
    return this.catalog.listCourses(requireOrg(p), q);
  }

  @Get('courses/:id')
  @RequirePermission('course.read')
  getCourse(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.catalog.getCourse(requireOrg(p), id);
  }

  @Post('courses')
  @RequirePermission('course.manage')
  @ApiZodBody(CreateCourseSchema)
  createCourse(
    @CurrentPrincipal() p: Principal,
    @ZBody(CreateCourseSchema) body: z.infer<typeof CreateCourseSchema>,
  ) {
    return this.catalog.createCourse(requireOrg(p), body);
  }

  @Patch('courses/:id')
  @RequirePermission('course.manage')
  @ApiZodBody(UpdateCourseSchema)
  updateCourse(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(UpdateCourseSchema) body: z.infer<typeof UpdateCourseSchema>,
  ) {
    return this.catalog.updateCourse(requireOrg(p), id, body);
  }

  @Get('batches')
  @RequirePermission('course.read')
  listBatches(@CurrentPrincipal() p: Principal, @ZQuery(BatchQuery) q: z.infer<typeof BatchQuery>) {
    return this.catalog.listBatches(requireOrg(p), q);
  }

  @Get('batches/:id')
  @RequirePermission('course.read')
  getBatch(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.catalog.getBatch(requireOrg(p), id);
  }

  @Post('batches')
  @RequirePermission('course.manage')
  @ApiZodBody(CreateBatchSchema)
  createBatch(
    @CurrentPrincipal() p: Principal,
    @ZBody(CreateBatchSchema) body: z.infer<typeof CreateBatchSchema>,
  ) {
    return this.catalog.createBatch(requireOrg(p), body);
  }

  @Patch('batches/:id')
  @RequirePermission('course.manage')
  @ApiZodBody(UpdateBatchSchema)
  updateBatch(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(UpdateBatchSchema) body: z.infer<typeof UpdateBatchSchema>,
  ) {
    return this.catalog.updateBatch(requireOrg(p), id, body);
  }
}
