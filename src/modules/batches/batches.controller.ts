import { Controller, Get, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
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
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiParam,
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
import { BatchQueryService } from './batch-query.service';
import {
  BatchDetailDto,
  BatchListDto,
  BatchListQueryDto,
  BatchSummaryDto,
  BatchSummaryQueryDto,
  CancelResultDto,
} from './batch-read.dto';
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
  public constructor(
    private readonly intake: BatchIntakeService,
    private readonly query: BatchQueryService,
  ) {}

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

  @Get()
  @ApiOperation({
    summary: 'List your batches, newest first',
    description:
      'Filters combine with AND; a multi-value filter matches any of its values. Cursor pagination: ' +
      'pass the nextCursor of a page as ?cursor= to get the next one; no nextCursor means the end.',
  })
  @ApiOkResponse({ type: BatchListDto })
  @ApiBadRequestResponse({ type: ProblemDetailsDto, description: 'VALIDATION_FAILED, INVALID_CURSOR' })
  public list(
    @CurrentTenant() tenant: TenantContext,
    @Query() query: BatchListQueryDto,
  ): Promise<BatchListDto> {
    return this.query.list(tenant.tenantId, query);
  }

  @Get(':batchId')
  @ApiOperation({
    summary: 'A batch: state, counters per message status, rejected rows',
    description:
      'Light enough to poll. counters always sum to total; stuck > 0 means an operator must decide ' +
      'about some messages, and the batch stays SENDING until then.',
  })
  @ApiParam({ name: 'batchId', example: 'b_7Hk2mQ9aB3xK1LpQ' })
  @ApiOkResponse({ type: BatchDetailDto })
  @ApiNotFoundResponse({
    type: ProblemDetailsDto,
    description: 'BATCH_NOT_FOUND (also for a batch of another tenant)',
  })
  public get(
    @CurrentTenant() tenant: TenantContext,
    @Param('batchId') batchId: string,
  ): Promise<BatchDetailDto> {
    return this.query.get(tenant.tenantId, batchId);
  }

  @Get(':batchId/summary')
  @ApiOperation({
    summary: 'Counters of a batch grouped by subTenant',
    description:
      'One group per subTenant value found in the batch; messages without one form the null group.',
  })
  @ApiParam({ name: 'batchId' })
  @ApiOkResponse({ type: BatchSummaryDto })
  @ApiNotFoundResponse({ type: ProblemDetailsDto, description: 'BATCH_NOT_FOUND' })
  public summary(
    @CurrentTenant() tenant: TenantContext,
    @Param('batchId') batchId: string,
    @Query() _query: BatchSummaryQueryDto,
  ): Promise<BatchSummaryDto> {
    return this.query.summary(tenant.tenantId, batchId);
  }

  @Post(':batchId/cancel')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Cancel what has not left yet',
    description:
      'Messages PENDING or RETRY_SCHEDULED become CANCELLED. A message being sent at that moment is ' +
      'finished, and anything already sent stays sent: a PEC that left cannot be recalled. ' +
      'Idempotent: calling it again cancels nothing more and returns the same picture.',
  })
  @ApiParam({ name: 'batchId' })
  @ApiOkResponse({ type: CancelResultDto })
  @ApiNotFoundResponse({ type: ProblemDetailsDto, description: 'BATCH_NOT_FOUND' })
  public cancel(
    @CurrentTenant() tenant: TenantContext,
    @Param('batchId') batchId: string,
  ): Promise<CancelResultDto> {
    return this.query.cancel(tenant.tenantId, batchId);
  }
}
