import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UploadedFile as UploadedFileParam,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  AdmissionListQuerySchema,
  AdmissionReasonSchema,
  AdmissionSettingsSchema,
  ApproveAdmissionSchema,
  ChangeBatchSchema,
  CourseRequirementsSchema,
  DeferAdmissionSchema,
  DocumentTypeSchema,
  MAX_DOCUMENT_BYTES,
  RejectDocumentSchema,
  StartAdmissionSchema,
  StudentProfileSchema,
  UpdateDocumentTypeSchema,
  z,
} from '@crm/contracts';
import { CurrentPrincipal, Public } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { badRequest } from '../common/errors';
import { requireOrg } from '../common/scope';
import { ApiZodBody, ZBody, ZQuery } from '../common/zod';
import { AdmissionConfigService } from './admission-config.service';
import { AdmissionsService, UploadedFile } from './admissions.service';

const BrandQ = z.object({ brandId: z.uuid() });

@ApiTags('admissions')
@Controller()
export class AdmissionsController {
  constructor(
    private readonly admissions: AdmissionsService,
    private readonly config: AdmissionConfigService,
  ) {}

  @Post('leads/:id/admission')
  @ApiZodBody(StartAdmissionSchema)
  start(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(StartAdmissionSchema) body: z.infer<typeof StartAdmissionSchema>,
  ) {
    return this.admissions.start(requireOrg(p), id, body);
  }

  @Get('leads/:id/admission')
  forLead(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.admissions.forLead(requireOrg(p), id);
  }

  @Get('admissions')
  list(
    @CurrentPrincipal() p: Principal,
    @ZQuery(AdmissionListQuerySchema) q: z.infer<typeof AdmissionListQuerySchema>,
  ) {
    return this.admissions.list(requireOrg(p), q);
  }

  @Get('admissions/:id')
  get(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.admissions.get(requireOrg(p), id);
  }

  @Patch('admissions/:id/student')
  @ApiZodBody(StudentProfileSchema)
  student(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(StudentProfileSchema) body: z.infer<typeof StudentProfileSchema>,
  ) {
    return this.admissions.updateStudent(requireOrg(p), id, body);
  }

  @Post('admissions/:id/approve')
  @ApiZodBody(ApproveAdmissionSchema)
  approve(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(ApproveAdmissionSchema) body: z.infer<typeof ApproveAdmissionSchema>,
  ) {
    return this.admissions.approve(requireOrg(p), id, body);
  }

  @Patch('admissions/:id/batch')
  @ApiZodBody(ChangeBatchSchema)
  batch(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(ChangeBatchSchema) body: z.infer<typeof ChangeBatchSchema>,
  ) {
    return this.admissions.changeBatch(requireOrg(p), id, body);
  }

  @Post('admissions/:id/defer')
  @ApiZodBody(DeferAdmissionSchema)
  defer(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(DeferAdmissionSchema) body: z.infer<typeof DeferAdmissionSchema>,
  ) {
    return this.admissions.defer(requireOrg(p), id, body);
  }

  @Post('admissions/:id/resume')
  resume(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.admissions.resume(requireOrg(p), id);
  }

  @Post('admissions/:id/cancel')
  @ApiZodBody(AdmissionReasonSchema)
  cancel(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(AdmissionReasonSchema) body: z.infer<typeof AdmissionReasonSchema>,
  ) {
    return this.admissions.cancel(requireOrg(p), id, body);
  }

  @Post('admissions/:id/documents/:typeId')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_DOCUMENT_BYTES + 1, files: 1 } }),
  )
  upload(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('typeId', ParseUUIDPipe) typeId: string,
    @UploadedFileParam() file: UploadedFile | undefined,
  ) {
    return this.admissions.upload(requireOrg(p), id, typeId, file);
  }

  @Post('admission-documents/:id/verify')
  verify(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.admissions.verify(requireOrg(p), id);
  }

  @Post('admission-documents/:id/reject')
  @ApiZodBody(RejectDocumentSchema)
  reject(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(RejectDocumentSchema) body: z.infer<typeof RejectDocumentSchema>,
  ) {
    return this.admissions.reject(requireOrg(p), id, body);
  }

  @Post('document-files/:id/link')
  link(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.admissions.link(requireOrg(p), id);
  }

  /** Signed-link download (no session needed: the token is the authorization, valid 5 minutes). */
  @Public()
  @Get('documents/download')
  async download(@Query('token') token: string | undefined, @Res() res: Response) {
    if (!token) throw badRequest('TOKEN_REQUIRED', 'Missing download token');
    const f = await this.admissions.download(token);
    res.setHeader('Content-Type', f.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${f.fileName.replace(/"/g, '')}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(f.content);
  }

  @Post('lms-handovers/:id/mark-done')
  markDone(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.admissions.markHandedOver(requireOrg(p), id);
  }

  @Get('batches/:id/seats')
  seats(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.admissions.seatInfo(requireOrg(p), id);
  }

  // --------------------------------------------------------------- config
  @Get('document-types')
  documentTypes(@CurrentPrincipal() p: Principal, @ZQuery(BrandQ) q: z.infer<typeof BrandQ>) {
    return this.config.documentTypes(requireOrg(p), q.brandId);
  }

  @Post('document-types')
  @ApiZodBody(DocumentTypeSchema)
  createDocumentType(
    @CurrentPrincipal() p: Principal,
    @ZBody(DocumentTypeSchema) body: z.infer<typeof DocumentTypeSchema>,
  ) {
    return this.config.createDocumentType(requireOrg(p), body);
  }

  @Patch('document-types/:id')
  @ApiZodBody(UpdateDocumentTypeSchema)
  updateDocumentType(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(UpdateDocumentTypeSchema) body: z.infer<typeof UpdateDocumentTypeSchema>,
  ) {
    return this.config.updateDocumentType(requireOrg(p), id, body);
  }

  @Get('courses/:id/document-requirements')
  requirements(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.config.courseRequirements(requireOrg(p), id);
  }

  @Put('courses/:id/document-requirements')
  @ApiZodBody(CourseRequirementsSchema)
  setRequirements(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(CourseRequirementsSchema) body: z.infer<typeof CourseRequirementsSchema>,
  ) {
    return this.config.setCourseRequirements(requireOrg(p), id, body);
  }

  @Get('admission-settings')
  settings(@CurrentPrincipal() p: Principal, @ZQuery(BrandQ) q: z.infer<typeof BrandQ>) {
    return this.config.settings(requireOrg(p), q.brandId);
  }

  @Put('admission-settings')
  @ApiZodBody(AdmissionSettingsSchema)
  updateSettings(
    @CurrentPrincipal() p: Principal,
    @ZQuery(BrandQ) q: z.infer<typeof BrandQ>,
    @ZBody(AdmissionSettingsSchema) body: z.infer<typeof AdmissionSettingsSchema>,
  ) {
    return this.config.updateSettings(requireOrg(p), q.brandId, body);
  }
}
