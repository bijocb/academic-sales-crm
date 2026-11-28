import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Inject,
} from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import {
  AppointmentListQuerySchema,
  CancelAppointmentSchema,
  CompleteAppointmentSchema,
  ContactPreferenceSchema,
  CreateAppointmentSchema,
  LogCallSchema,
  RescheduleAppointmentSchema,
  QuickSendSchema,
  SendMessageSchema,
  TEMPLATE_CATEGORIES,
  TemplateSchema,
  UpdateTemplateSchema,
  z,
} from '@crm/contracts';
import { CurrentPrincipal, Public } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { requireOrg } from '../common/scope';
import { ApiZodBody, ZBody, ZQuery } from '../common/zod';
import { AppointmentsService } from './appointments.service';
import { EngagementService } from './engagement.service';
import { ProviderRegistry } from './providers';
import { TemplatesService } from './templates.service';

const BrandQ = z.object({ brandId: z.uuid().optional() });
const SandboxWebhook = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('status'),
    providerRef: z.string().min(1),
    status: z.enum(['DELIVERED', 'READ', 'FAILED']),
    error: z.string().optional(),
  }),
  z.object({
    type: z.literal('inbound'),
    brandId: z.uuid(),
    from: z.string().min(5),
    text: z.string().min(1).max(4000),
    providerRef: z.string().optional(),
  }),
]);

const QuickCategoryQuery = z.object({ category: z.enum(TEMPLATE_CATEGORIES) });

@ApiTags('engagement')
@Controller()
export class EngagementController {
  constructor(
    private readonly engagement: EngagementService,
    private readonly appointments: AppointmentsService,
    private readonly templates: TemplatesService,
    @Inject(ProviderRegistry) private readonly providers: ProviderRegistry,
  ) {}

  @Get('engagement/providers')
  providersStatus() {
    return this.engagement.providersStatus();
  }

  @Post('leads/:id/calls')
  @ApiZodBody(LogCallSchema)
  logCall(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(LogCallSchema) body: z.infer<typeof LogCallSchema>,
  ) {
    return this.engagement.logCall(requireOrg(p), id, body);
  }

  @Post('leads/:id/calls/dial')
  dial(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.engagement.dial(requireOrg(p), id);
  }

  @Get('leads/:id/messages')
  messages(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.engagement.messages(requireOrg(p), id);
  }

  @Post('leads/:id/messages')
  @ApiZodBody(SendMessageSchema)
  send(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(SendMessageSchema) body: z.infer<typeof SendMessageSchema>,
  ) {
    return this.engagement.send(requireOrg(p), id, body);
  }

  /** Quick messages: what one click would send for a situation, per channel. */
  @Get('leads/:id/messages/quick')
  quickPreview(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZQuery(QuickCategoryQuery) q: z.infer<typeof QuickCategoryQuery>,
  ) {
    return this.engagement.quickPreview(requireOrg(p), id, q.category);
  }

  /** Quick messages: send the situation's approved templates on the chosen channels in one click. */
  @Post('leads/:id/messages/quick')
  @ApiZodBody(QuickSendSchema)
  quickSend(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(QuickSendSchema) body: z.infer<typeof QuickSendSchema>,
  ) {
    return this.engagement.quickSend(requireOrg(p), id, body);
  }

  @Post('leads/:id/contact-preference')
  @ApiZodBody(ContactPreferenceSchema)
  contactPreference(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(ContactPreferenceSchema) body: z.infer<typeof ContactPreferenceSchema>,
  ) {
    return this.engagement.setContactPreference(requireOrg(p), id, body);
  }

  // ------------------------------------------------------------ templates
  @Get('message-templates')
  listTemplates(@CurrentPrincipal() p: Principal, @ZQuery(BrandQ) q: z.infer<typeof BrandQ>) {
    return this.templates.list(requireOrg(p), q.brandId);
  }

  @Post('message-templates')
  @ApiZodBody(TemplateSchema)
  createTemplate(
    @CurrentPrincipal() p: Principal,
    @ZBody(TemplateSchema) body: z.infer<typeof TemplateSchema>,
  ) {
    return this.templates.create(requireOrg(p), body);
  }

  @Patch('message-templates/:id')
  @ApiZodBody(UpdateTemplateSchema)
  updateTemplate(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(UpdateTemplateSchema) body: z.infer<typeof UpdateTemplateSchema>,
  ) {
    return this.templates.update(requireOrg(p), id, body);
  }

  // --------------------------------------------------------- appointments
  @Get('appointments')
  listAppointments(
    @CurrentPrincipal() p: Principal,
    @ZQuery(AppointmentListQuerySchema) q: z.infer<typeof AppointmentListQuerySchema>,
  ) {
    return this.appointments.list(requireOrg(p), q);
  }

  @Get('leads/:id/appointments')
  leadAppointments(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.appointments.forLead(requireOrg(p), id);
  }

  @Get('leads/:id/counsellors')
  counsellors(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.appointments.counsellors(requireOrg(p), id);
  }

  @Post('leads/:id/appointments')
  @ApiZodBody(CreateAppointmentSchema)
  book(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(CreateAppointmentSchema) body: z.infer<typeof CreateAppointmentSchema>,
  ) {
    return this.appointments.create(requireOrg(p), id, body);
  }

  @Post('appointments/:id/complete')
  @ApiZodBody(CompleteAppointmentSchema)
  completeAppointment(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(CompleteAppointmentSchema) body: z.infer<typeof CompleteAppointmentSchema>,
  ) {
    return this.appointments.complete(requireOrg(p), id, body);
  }

  @Post('appointments/:id/reschedule')
  @ApiZodBody(RescheduleAppointmentSchema)
  rescheduleAppointment(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(RescheduleAppointmentSchema) body: z.infer<typeof RescheduleAppointmentSchema>,
  ) {
    return this.appointments.reschedule(requireOrg(p), id, body);
  }

  @Post('appointments/:id/cancel')
  @ApiZodBody(CancelAppointmentSchema)
  cancelAppointment(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(CancelAppointmentSchema) body: z.infer<typeof CancelAppointmentSchema>,
  ) {
    return this.appointments.cancel(requireOrg(p), id, body);
  }

  // ------------------------------------------------ sandbox provider hook
  /** SANDBOX — dev/test only: simulates WhatsApp delivery receipts and inbound replies. 404 in production. */
  @Public()
  @ApiExcludeEndpoint()
  @Post('webhooks/sandbox/whatsapp')
  async sandboxWhatsApp(@ZBody(SandboxWebhook) body: z.infer<typeof SandboxWebhook>) {
    if (!this.providers.sandbox || !this.providers.whatsapp) throw new NotFoundException();
    if (body.type === 'status')
      return this.engagement.applyReceipt(
        this.providers.whatsapp.name,
        body.providerRef,
        body.status,
        body.error,
      );
    return this.engagement.inbound(body.brandId, body.from, body.text, body.providerRef);
  }
}
