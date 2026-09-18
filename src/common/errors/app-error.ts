/**
 * The one error type the HTTP layer knows how to present.
 *
 * Every failure a client may see carries a stable machine-readable `code`
 * (what integrations branch on), an HTTP status and a human-readable detail.
 * Field-level problems - a bad address on row 37, a placeholder missing from a
 * template - are listed in `errors`, each with a JSON path into the request.
 *
 * Anything that is NOT an AppError reaching the HTTP layer is a bug and is
 * presented as a bare 500: the client gets an id to quote, never the message.
 */

export interface FieldError {
  /** JSON path into the request, e.g. "messages[37].to" or "template.html". */
  readonly path: string;
  readonly code: string;
  readonly detail: string;
}

export interface AppErrorOptions {
  readonly detail?: string;
  readonly errors?: readonly FieldError[];
  readonly cause?: unknown;
  /** Response headers the status calls for (Retry-After, Location...). */
  readonly headers?: Readonly<Record<string, string>>;
}

export class AppError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly title: string;
  public readonly detail: string | undefined;
  public readonly errors: readonly FieldError[];
  public readonly headers: Readonly<Record<string, string>>;

  public constructor(status: number, code: string, title: string, options: AppErrorOptions = {}) {
    super(options.detail ?? title, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.title = title;
    this.detail = options.detail;
    this.errors = options.errors ?? [];
    this.headers = options.headers ?? {};
  }

  public static badRequest(code: string, title: string, options?: AppErrorOptions): AppError {
    return new AppError(400, code, title, options);
  }

  public static unauthorized(detail?: string): AppError {
    return new AppError(
      401,
      'UNAUTHORIZED',
      'Authentication required',
      detail === undefined ? {} : { detail },
    );
  }

  public static forbidden(code: string, detail?: string): AppError {
    return new AppError(403, code, 'Forbidden', detail === undefined ? {} : { detail });
  }

  public static notFound(code: string, title: string): AppError {
    return new AppError(404, code, title);
  }

  public static unprocessable(code: string, title: string, options?: AppErrorOptions): AppError {
    return new AppError(422, code, title, options);
  }

  public static conflict(code: string, title: string, options?: AppErrorOptions): AppError {
    return new AppError(409, code, title, options);
  }

  public static payloadTooLarge(code: string, title: string, options?: AppErrorOptions): AppError {
    return new AppError(413, code, title, options);
  }

  public static unsupportedMediaType(code: string, title: string, options?: AppErrorOptions): AppError {
    return new AppError(415, code, title, options);
  }

  public static locked(code: string, title: string, options?: AppErrorOptions): AppError {
    return new AppError(423, code, title, options);
  }

  public static tooManyRequests(detail: string, retryAfterSeconds: number): AppError {
    return new AppError(429, 'TOO_MANY_REQUESTS', 'Too many requests', {
      detail,
      headers: { 'retry-after': String(retryAfterSeconds) },
    });
  }
}
