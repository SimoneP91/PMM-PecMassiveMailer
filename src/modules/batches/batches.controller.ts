import { Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiExtraModels,
  ApiForbiddenResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
  ApiUnprocessableEntityResponse,
  ApiUnsupportedMediaTypeResponse,
  getSchemaPath,
} from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { ProblemDetailsDto } from '../../common/errors/problem-details.dto';
import { CurrentTenant } from '../auth/current-tenant.decorator';
import type { TenantContext } from '../auth/tenant-context';
import { BatchIntakeService } from './batch-intake.service';
import { BatchRequestDto } from './batch-request.schema';
import { BatchAcceptedDto, DryRunResultDto } from './batch-response.dto';

const DESCRIPTION = `
One call submits one batch: a template, a mailbox and N recipients, each with its own placeholder values and attachments.

**Request**: \`multipart/form-data\` with
- a part named \`batch\` carrying the JSON described by *BatchRequest* (schemas below);
- one file part per attachment or inline image, named as the JSON references it (\`messages[].attachments[].part\`, \`defaults.attachments[].part\`, \`template.inlineImages[].part\`). A file shared by every message is sent once. Every file part must carry a filename with an accepted extension; the type is verified from the content.

**Validation** happens before anything is stored: the template (closed list of HTML elements and attributes, \`{{name}}\` text and \`{{{name}}}\` HTML placeholders, inline images only), every recipient (must be served by an accredited PEC provider), every row (placeholders, attachments, size), every \`dedupKey\`.

**Outcome**: \`202\` with the batch id, the \`ref -> messageId\` map of accepted rows and the list of rejected rows with a stable code each. A batch-level problem (\`4xx\`) creates nothing. With \`options.atomic\` one bad row rejects everything; with \`options.dryRun\` the answer is \`200\` with a rendered preview and nothing is created.

**Idempotency**: the \`Idempotency-Key\` header is required (except for dry runs). Repeating a request with the same key and the same content returns the original answer with \`Idempotent-Replayed: true\`; the same key with different content is a \`409\`.
`.trim();

@ApiTags('batches')
@ApiBearerAuth('apiKey')
@ApiExtraModels(BatchRequestDto)
@Controller('v1/batches')
export class BatchesController {
  public constructor(private readonly intake: BatchIntakeService) {}

  @Post()
  @HttpCode(202)
  @ApiOperation({ summary: 'Submit a batch of PEC messages', description: DESCRIPTION })
  @ApiConsumes('multipart/form-data')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      'Unique per batch, chosen by you (a UUID is fine). Letters, digits, ".", "_", ":" and "-", up to 200 characters.',
  })
  @ApiBody({
    description:
      'The "batch" JSON part plus one binary part per file. Part names must match the references in the JSON.',
    schema: {
      type: 'object',
      required: ['batch'],
      properties: {
        batch: {
          allOf: [{ $ref: getSchemaPath(BatchRequestDto) }],
          description:
            'JSON: see the BatchRequestDto schema. Sent as a text field or as a part with content type application/json.',
        },
        'doc-4521': {
          type: 'string',
          format: 'binary',
          description: 'Example file part, referenced by a message as { "part": "doc-4521" }',
        },
        logo: {
          type: 'string',
          format: 'binary',
          description: 'Example inline image, referenced by template.inlineImages',
        },
      },
    },
  })
  @ApiAcceptedResponse({
    type: BatchAcceptedDto,
    description: 'Batch created and queued. Location: /v1/batches/{batchId}',
  })
  @ApiOkResponse({
    type: DryRunResultDto,
    description: 'options.dryRun = true: validated and previewed, nothing created',
  })
  @ApiBadRequestResponse({
    type: ProblemDetailsDto,
    description:
      'Malformed multipart or JSON; missing Idempotency-Key; a referenced part is missing or a part is unreferenced',
  })
  @ApiForbiddenResponse({
    type: ProblemDetailsDto,
    description: 'MAILBOX_NOT_AVAILABLE: the mailbox is not one of yours',
  })
  @ApiConflictResponse({
    type: ProblemDetailsDto,
    description: 'Idempotency-Key reused with different content, or still in progress',
  })
  @ApiResponse({
    status: 413,
    type: ProblemDetailsDto,
    description: 'REQUEST_TOO_LARGE: over the per-call limit, split the batch',
  })
  @ApiUnsupportedMediaTypeResponse({
    type: ProblemDetailsDto,
    description: 'Not multipart, or a file whose content is not an accepted type',
  })
  @ApiUnprocessableEntityResponse({
    type: ProblemDetailsDto,
    description:
      'TEMPLATE_REJECTED, EMPTY_BATCH, TOO_MANY_MESSAGES, DUPLICATE_REF, BATCH_REJECTED (atomic), ALL_MESSAGES_REJECTED',
  })
  @ApiResponse({
    status: 423,
    type: ProblemDetailsDto,
    description: 'MAILBOX_SUSPENDED: the provider refused the credentials',
  })
  @ApiResponse({
    status: 429,
    type: ProblemDetailsDto,
    description: 'Too many requests for this tenant; see Retry-After',
  })
  public async submit(
    @CurrentTenant() tenant: TenantContext,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<BatchAcceptedDto | DryRunResultDto> {
    const outcome = await this.intake.submit(tenant, request);
    if (outcome.kind === 'dryRun') {
      void reply.status(200);

      return outcome.body;
    }

    void reply.status(202).header('location', outcome.location);
    if (outcome.replayed) {
      void reply.header('idempotent-replayed', 'true');
    }

    return outcome.body;
  }
}
