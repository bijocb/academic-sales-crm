import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';
import { ThrottlerException } from '@nestjs/throttler';
import { AppError } from './errors';
import { requestContext } from './request-context';

interface ErrorBody {
  error: { code: string; message: string; details?: unknown; correlationId?: string };
}

/** Consistent error format: { error: { code, message, details?, correlationId } } */
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpErrorFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const correlationId = requestContext.get()?.correlationId;
    const [status, body] = this.map(exception);
    body.error.correlationId = correlationId;
    if (status >= 500) this.logger.error({ err: exception, correlationId }, 'Unhandled error');
    res.status(status).json(body);
  }

  private map(e: unknown): [number, ErrorBody] {
    if (e instanceof AppError)
      return [e.status, { error: { code: e.code, message: e.message, details: e.details } }];
    if (e instanceof ThrottlerException)
      return [
        HttpStatus.TOO_MANY_REQUESTS,
        { error: { code: 'RATE_LIMITED', message: 'Too many requests' } },
      ];
    if (e instanceof HttpException) {
      const status = e.getStatus();
      const code =
        status === 404
          ? 'NOT_FOUND'
          : status === 401
            ? 'UNAUTHENTICATED'
            : status === 403
              ? 'FORBIDDEN'
              : 'HTTP_ERROR';
      return [status, { error: { code, message: e.message } }];
    }
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      if (e.code === 'P2002')
        return [
          HttpStatus.CONFLICT,
          {
            error: {
              code: 'ALREADY_EXISTS',
              message: 'A record with these values already exists',
              details: e.meta?.target,
            },
          },
        ];
      if (e.code === 'P2025')
        return [
          HttpStatus.NOT_FOUND,
          { error: { code: 'NOT_FOUND', message: 'Resource not found' } },
        ];
      if (e.code === 'P2003')
        return [
          HttpStatus.BAD_REQUEST,
          { error: { code: 'INVALID_REFERENCE', message: 'A referenced record does not exist' } },
        ];
    }
    return [
      HttpStatus.INTERNAL_SERVER_ERROR,
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
    ];
  }
}
