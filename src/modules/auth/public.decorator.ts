import { type CustomDecorator, SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'pecmailer:isPublic';

/**
 * Opts a route out of API key authentication. Health probes are the only
 * intended users: everything under /v1 requires a tenant.
 */
export const Public = (): CustomDecorator => SetMetadata(IS_PUBLIC, true);
