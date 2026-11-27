import { applyDecorators, Body, PipeTransform, Query } from '@nestjs/common';
import { ApiBody } from '@nestjs/swagger';
import { z } from '@crm/contracts';
import { badRequest } from './errors';

export class ZodValidationPipe<S extends z.ZodType> implements PipeTransform {
  constructor(private readonly schema: S) {}
  transform(value: unknown): z.output<S> {
    const result = this.schema.safeParse(value ?? {});
    if (!result.success) {
      throw badRequest(
        'VALIDATION_ERROR',
        'Request validation failed',
        result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    return result.data;
  }
}

/** Validated request body. Pair with @ApiZodBody(schema) for OpenAPI docs. */
export const ZBody = (schema: z.ZodType) => Body(new ZodValidationPipe(schema));
export const ZQuery = (schema: z.ZodType) => Query(new ZodValidationPipe(schema));

export const ApiZodBody = (schema: z.ZodType) =>
  applyDecorators(
    ApiBody({
      schema: z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<
        string,
        unknown
      >,
    }),
  );
