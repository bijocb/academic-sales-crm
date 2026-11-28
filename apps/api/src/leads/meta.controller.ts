import {
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  type RawBodyRequest,
} from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { MetaConnectionSchema, UpdateMetaConnectionSchema, z } from '@crm/contracts';
import { CurrentPrincipal, Public } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { requireOrg } from '../common/scope';
import { ApiZodBody, ZBody, ZQuery } from '../common/zod';
import { MetaService } from './meta.service';

const BrandQ = z.object({ brandId: z.uuid() });

/** Facebook / Instagram Lead Ads (A-047). */
@ApiTags('intake')
@Controller()
export class MetaController {
  constructor(private readonly meta: MetaService) {}

  /** Meta's webhook subscription check (hub.challenge). */
  @Public()
  @ApiExcludeEndpoint()
  @Get('webhooks/meta')
  verify(@Query() q: Record<string, string | undefined>, @Res() res: Response) {
    res.type('text/plain').send(this.meta.verify(q));
  }

  /** Lead notifications; the X-Hub-Signature-256 over the raw body is the only authentication. */
  @Public()
  @ApiExcludeEndpoint()
  @Post('webhooks/meta')
  @HttpCode(200)
  receive(@Req() req: RawBodyRequest<Request>, @Headers('x-hub-signature-256') signature?: string) {
    return this.meta.receive(req.rawBody, signature);
  }

  @Get('meta-connections')
  list(@CurrentPrincipal() p: Principal, @ZQuery(BrandQ) q: z.infer<typeof BrandQ>) {
    return this.meta.list(requireOrg(p), q.brandId);
  }

  @Post('meta-connections')
  @ApiZodBody(MetaConnectionSchema)
  create(
    @CurrentPrincipal() p: Principal,
    @ZBody(MetaConnectionSchema) body: z.infer<typeof MetaConnectionSchema>,
  ) {
    return this.meta.create(requireOrg(p), body);
  }

  @Patch('meta-connections/:id')
  @ApiZodBody(UpdateMetaConnectionSchema)
  update(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @ZBody(UpdateMetaConnectionSchema) body: z.infer<typeof UpdateMetaConnectionSchema>,
  ) {
    return this.meta.update(requireOrg(p), id, body);
  }
}
