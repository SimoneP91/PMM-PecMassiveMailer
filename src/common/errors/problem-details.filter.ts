import { type ArgumentsHost, Catch, type ExceptionFilter } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { PinoLogger } from 'nestjs-pino';

import { AppError } from './app-error';
import { PROBLEM_JSON, toProblemDetails } from './problem-details';

/**
 * Turns every exception into an RFC 9457 document. 5xx are logged with the
 * original error and the request id, which is the only thing the client
 * receives - the message stays in the log where it belongs.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  public constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(ProblemDetailsFilter.name);
  }

  public catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const problem = toProblemDetails(exception, request.id);

    if (problem.status >= 500) {
      this.logger.error({ err: exception, requestId: request.id }, 'unhandled error');
    } else if (problem.status === 401) {
      void reply.header('www-authenticate', 'Bearer');
    }
    if (exception instanceof AppError) {
      for (const [name, value] of Object.entries(exception.headers)) {
        void reply.header(name, value);
      }
    }

    void reply.status(problem.status).header('content-type', PROBLEM_JSON).send(problem);
  }
}
