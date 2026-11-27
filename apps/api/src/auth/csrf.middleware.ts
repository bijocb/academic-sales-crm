import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

export const CSRF_HEADER = 'x-crm-client';
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Machine endpoints authenticate with their own keys and never rely on cookies. */
const MACHINE_PATHS = ['/api/v1/webhooks/', '/api/v1/intake/'];

/**
 * Cookie-authenticated writes must carry a custom header. Browsers cannot attach custom
 * headers cross-site without a CORS preflight (which this API never approves), so this
 * blocks CSRF. Requests authenticated with a Bearer token and machine endpoints are exempt.
 */
@Injectable()
export class CsrfMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const path = req.originalUrl ?? req.url;
    if (
      SAFE.has(req.method) ||
      MACHINE_PATHS.some((p) => path.startsWith(p)) ||
      req.headers.authorization?.startsWith('Bearer ') ||
      req.headers[CSRF_HEADER]
    ) {
      return next();
    }
    res
      .status(403)
      .json({ error: { code: 'CSRF_HEADER_MISSING', message: `Missing ${CSRF_HEADER} header` } });
  }
}
