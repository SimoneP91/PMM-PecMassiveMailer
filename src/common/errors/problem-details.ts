import { HttpException } from '@nestjs/common';
import { ZodValidationException } from 'nestjs-zod';

import { AppError, type FieldError } from './app-error';
import { formatPath } from './zod-errors';

/**
 * RFC 9457 "Problem Details for HTTP APIs": one error shape for every
 * endpoint, so a client handles failures in one place.
 */
export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
  readonly code: string;
  readonly errors?: readonly FieldError[];
  readonly requestId: string;
}

export const PROBLEM_JSON = 'application/problem+json';

const STATUS_CODES: Readonly<Record<number, readonly [code: string, title: string]>> = {
  400: ['BAD_REQUEST', 'Bad request'],
  401: ['UNAUTHORIZED', 'Authentication required'],
  403: ['FORBIDDEN', 'Forbidden'],
  404: ['NOT_FOUND', 'Not found'],
  405: ['METHOD_NOT_ALLOWED', 'Method not allowed'],
  406: ['NOT_ACCEPTABLE', 'Not acceptable'],
  408: ['REQUEST_TIMEOUT', 'Request timeout'],
  409: ['CONFLICT', 'Conflict'],
  413: ['REQUEST_TOO_LARGE', 'Request entity too large'],
  415: ['UNSUPPORTED_MEDIA_TYPE', 'Unsupported media type'],
  422: ['UNPROCESSABLE', 'Unprocessable content'],
  423: ['LOCKED', 'Locked'],
  429: ['TOO_MANY_REQUESTS', 'Too many requests'],
  503: ['SERVICE_UNAVAILABLE', 'Service unavailable'],
};

const GENERIC_500: readonly [string, string] = ['INTERNAL_ERROR', 'Internal server error'];

export function problemType(code: string): string {
  return `urn:pecmailer:error:${code.toLowerCase().replace(/_/g, '-')}`;
}

function fromStatus(
  status: number,
  detail?: string,
): { status: number; code: string; title: string; detail?: string } {
  const known = STATUS_CODES[status];
  if (known !== undefined) {
    return detail === undefined
      ? { status, code: known[0], title: known[1] }
      : { status, code: known[0], title: known[1], detail };
  }
  if (status >= 400 && status < 500) {
    return detail === undefined
      ? { status, code: 'CLIENT_ERROR', title: 'Client error' }
      : { status, code: 'CLIENT_ERROR', title: 'Client error', detail };
  }

  // Never forward a 5xx detail: it is ours, and it may contain what the
  // client must not see.
  return { status: 500, code: GENERIC_500[0], title: GENERIC_500[1] };
}

interface WithStatusCode {
  readonly statusCode: number;
  readonly message?: unknown;
  readonly code?: unknown;
}

function hasStatusCode(value: unknown): value is WithStatusCode {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { statusCode?: unknown }).statusCode === 'number'
  );
}

interface ZodLikeIssue {
  readonly path: readonly PropertyKey[];
  readonly code: string;
  readonly message: string;
}

/** nestjs-zod types the wrapped error as unknown; it is checked structurally rather than trusted. */
function isZodLikeIssue(value: unknown): value is ZodLikeIssue {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { path?: unknown }).path) &&
    typeof (value as { code?: unknown }).code === 'string' &&
    typeof (value as { message?: unknown }).message === 'string'
  );
}

function zodIssuesToFieldErrors(exception: ZodValidationException): FieldError[] {
  const zodError: unknown = exception.getZodError();
  const rawIssues =
    typeof zodError === 'object' && zodError !== null ? (zodError as { issues?: unknown }).issues : undefined;
  const issues = Array.isArray(rawIssues) ? rawIssues.filter(isZodLikeIssue) : [];

  return issues.map((issue) => ({
    path: formatPath(issue.path),
    code: issue.code.toUpperCase(),
    detail: issue.message,
  }));
}

/**
 * Maps whatever reached the HTTP layer to a problem document. Pure, so the
 * mapping is unit-tested without an HTTP server.
 */
export function toProblemDetails(exception: unknown, requestId: string): ProblemDetails {
  if (exception instanceof AppError) {
    return {
      type: problemType(exception.code),
      title: exception.title,
      status: exception.status,
      ...(exception.detail === undefined ? {} : { detail: exception.detail }),
      code: exception.code,
      ...(exception.errors.length === 0 ? {} : { errors: exception.errors }),
      requestId,
    };
  }

  if (exception instanceof ZodValidationException) {
    return {
      type: problemType('VALIDATION_FAILED'),
      title: 'Request validation failed',
      status: 400,
      code: 'VALIDATION_FAILED',
      errors: zodIssuesToFieldErrors(exception),
      requestId,
    };
  }

  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const response = exception.getResponse();
    const detail = typeof response === 'string' ? response : undefined;
    const mapped = fromStatus(status, detail);

    return { type: problemType(mapped.code), ...mapped, requestId };
  }

  // Fastify raises plain errors carrying statusCode (body too large, bad
  // content type, malformed JSON...). Their message is safe for 4xx.
  if (hasStatusCode(exception)) {
    const detail =
      typeof exception.message === 'string' && exception.statusCode < 500 ? exception.message : undefined;
    const mapped = fromStatus(exception.statusCode, detail);

    return { type: problemType(mapped.code), ...mapped, requestId };
  }

  const mapped = fromStatus(500);

  return { type: problemType(mapped.code), ...mapped, requestId };
}
