import { Controller, Get, Inject, Optional, Res } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { ApiOkResponse, ApiOperation, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { Connection, ConnectionStates } from 'mongoose';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { isWritableDirectory } from '../../common/fs/ensure-dir';
import { ENV } from '../../config/config.module';
import type { Env } from '../../config/env.schema';
import { Public } from '../auth/public.decorator';

const checkState = z.enum(['up', 'down']);

export class LivenessDto extends createZodDto(z.object({ status: z.literal('ok') })) {}

export class ReadinessDto extends createZodDto(
  z.object({
    status: z.enum(['ok', 'degraded']),
    checks: z.object({
      mongodb: checkState,
      storage: checkState,
    }),
  }),
) {}

/**
 * Liveness answers "is the process alive"; readiness answers "can it serve".
 * The orchestrator restarts on the first and withholds traffic on the second,
 * which is why readiness looks at the database and the storage volume.
 */
@ApiTags('health')
@Public()
@Controller('health')
export class HealthController {
  public constructor(
    @Inject(ENV) private readonly env: Env,
    @Optional() @InjectConnection() private readonly mongo: Connection | null,
  ) {}

  @Get('live')
  @ApiOperation({ summary: 'Liveness probe' })
  @ApiOkResponse({ type: LivenessDto })
  public live(): LivenessDto {
    return { status: 'ok' };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Readiness probe: MongoDB reachable and storage writable' })
  @ApiOkResponse({ type: ReadinessDto })
  @ApiServiceUnavailableResponse({ type: ReadinessDto })
  public async ready(@Res({ passthrough: true }) reply: FastifyReply): Promise<ReadinessDto> {
    // Anything but "connected" means queries would queue or fail.
    const mongodb = this.mongo?.readyState === ConnectionStates.connected ? 'up' : 'down';
    const storage = (await isWritableDirectory(this.env.STORAGE_DIR)) ? 'up' : 'down';
    const healthy = mongodb === 'up' && storage === 'up';

    if (!healthy) {
      void reply.status(503);
    }

    return { status: healthy ? 'ok' : 'degraded', checks: { mongodb, storage } };
  }
}
