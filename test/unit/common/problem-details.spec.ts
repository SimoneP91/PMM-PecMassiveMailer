import { NotFoundException } from '@nestjs/common';
import { ZodValidationException } from 'nestjs-zod';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AppError } from '../../../src/common/errors/app-error';
import { toProblemDetails } from '../../../src/common/errors/problem-details';

describe('toProblemDetails', () => {
  it('renders an AppError with code, detail and field errors', () => {
    const error = AppError.unprocessable('TEMPLATE_REJECTED', 'Template rejected', {
      detail: 'forbidden elements',
      errors: [{ path: 'template.html', code: 'FORBIDDEN_ELEMENT', detail: '<script>' }],
    });

    expect(toProblemDetails(error, 'req-1')).toEqual({
      type: 'urn:pecmailer:error:template-rejected',
      title: 'Template rejected',
      status: 422,
      detail: 'forbidden elements',
      code: 'TEMPLATE_REJECTED',
      errors: [{ path: 'template.html', code: 'FORBIDDEN_ELEMENT', detail: '<script>' }],
      requestId: 'req-1',
    });
  });

  it('omits detail and errors when absent', () => {
    const problem = toProblemDetails(AppError.notFound('BATCH_NOT_FOUND', 'Batch not found'), 'r');

    expect(problem).not.toHaveProperty('detail');
    expect(problem).not.toHaveProperty('errors');
    expect(problem.status).toBe(404);
  });

  it('turns a zod validation failure into 400 with one entry per issue', () => {
    const schema = z.object({ to: z.email(), n: z.number() });
    const result = schema.safeParse({ to: 'nope', n: 'x' });
    if (result.success) {
      throw new Error('expected failure');
    }

    const problem = toProblemDetails(new ZodValidationException(result.error), 'r');

    expect(problem.status).toBe(400);
    expect(problem.code).toBe('VALIDATION_FAILED');
    expect(problem.errors?.map((e) => e.path)).toEqual(['to', 'n']);
  });

  it('maps a Nest HttpException by status', () => {
    const problem = toProblemDetails(new NotFoundException('Cannot GET /nope'), 'r');

    expect(problem).toMatchObject({ status: 404, code: 'NOT_FOUND', title: 'Not found' });
  });

  it('maps a Fastify error carrying statusCode and keeps a 4xx message', () => {
    const fastifyError = Object.assign(new Error('Request body is too large'), { statusCode: 413 });

    expect(toProblemDetails(fastifyError, 'r')).toMatchObject({
      status: 413,
      code: 'REQUEST_TOO_LARGE',
      detail: 'Request body is too large',
    });
  });

  it('never leaks a 5xx message, whatever the source', () => {
    const fastifyError = Object.assign(new Error('ECONNREFUSED mongo:27017'), { statusCode: 500 });

    for (const exception of [new Error('db password is x'), fastifyError, 'string', undefined]) {
      const problem = toProblemDetails(exception, 'r');
      expect(problem.status).toBe(500);
      expect(problem.code).toBe('INTERNAL_ERROR');
      expect(problem).not.toHaveProperty('detail');
      expect(JSON.stringify(problem)).not.toMatch(/password|ECONNREFUSED/);
    }
  });
});
