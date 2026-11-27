import { HttpStatus } from '@nestjs/common';

export class AppError extends Error {
  constructor(
    public readonly status: HttpStatus,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (entity = 'Resource') =>
  new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', `${entity} not found`);
export const forbidden = (message = 'You do not have permission to perform this action') =>
  new AppError(HttpStatus.FORBIDDEN, 'FORBIDDEN', message);
export const badRequest = (code: string, message: string, details?: unknown) =>
  new AppError(HttpStatus.BAD_REQUEST, code, message, details);
export const conflict = (code: string, message: string) =>
  new AppError(HttpStatus.CONFLICT, code, message);
export const unauthorized = (code = 'UNAUTHENTICATED', message = 'Authentication required') =>
  new AppError(HttpStatus.UNAUTHORIZED, code, message);
