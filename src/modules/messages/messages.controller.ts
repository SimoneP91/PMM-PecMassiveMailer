import { Controller, Get, Param, Query, Res, StreamableFile } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';

import { ProblemDetailsDto } from '../../common/errors/problem-details.dto';
import { CurrentTenant } from '../auth/current-tenant.decorator';
import type { TenantContext } from '../auth/tenant-context';
import {
  BatchMessagesQueryDto,
  MessageDetailDto,
  MessageListDto,
  MessageSearchQueryDto,
  ReceiptListDto,
  RenderedMessageDto,
} from './message-read.dto';
import { MessageQueryService, type FileDownload } from './message-query.service';

function download(reply: FastifyReply, file: FileDownload): StreamableFile {
  void reply.header('repr-digest', `sha-256=:${Buffer.from(file.sha256, 'hex').toString('base64')}:`);

  return new StreamableFile(file.stream, {
    type: file.contentType,
    disposition: `attachment; filename="${file.filename}"`,
    length: file.size,
  });
}

const LIST_DESCRIPTION =
  'Filters combine with AND; a multi-value filter matches any of its values. Cursor pagination: ' +
  'pass the nextCursor of a page as ?cursor= to get the next one; no nextCursor means the end.';

@ApiTags('messages')
@ApiBearerAuth('apiKey')
@Controller('v1')
export class MessagesController {
  public constructor(private readonly messages: MessageQueryService) {}

  @Get('batches/:batchId/messages')
  @ApiOperation({
    summary: 'The messages of a batch, in the order you submitted them',
    description: LIST_DESCRIPTION,
  })
  @ApiParam({ name: 'batchId' })
  @ApiOkResponse({ type: MessageListDto })
  @ApiBadRequestResponse({ type: ProblemDetailsDto, description: 'VALIDATION_FAILED, INVALID_CURSOR' })
  @ApiNotFoundResponse({
    type: ProblemDetailsDto,
    description: 'BATCH_NOT_FOUND (also for a batch of another tenant)',
  })
  public listInBatch(
    @CurrentTenant() tenant: TenantContext,
    @Param('batchId') batchId: string,
    @Query() query: BatchMessagesQueryDto,
  ): Promise<MessageListDto> {
    return this.messages.listInBatch(tenant.tenantId, batchId, query);
  }

  @Get('messages')
  @ApiOperation({
    summary: 'Search your messages across every batch, newest first',
    description: `Typical use: find a message by your ref or by recipient without knowing its batch. ${LIST_DESCRIPTION}`,
  })
  @ApiOkResponse({ type: MessageListDto })
  @ApiBadRequestResponse({ type: ProblemDetailsDto, description: 'VALIDATION_FAILED, INVALID_CURSOR' })
  public search(
    @CurrentTenant() tenant: TenantContext,
    @Query() query: MessageSearchQueryDto,
  ): Promise<MessageListDto> {
    return this.messages.search(tenant.tenantId, query);
  }

  @Get('messages/:messageId')
  @ApiOperation({
    summary: 'A message: state, every attempt, the digests of what was sent',
    description:
      'rfcMessageId is the Message-ID of the PEC as it left; the receipts quote it. The content itself is ' +
      'available from /rendered (as built) and /eml (as transmitted).',
  })
  @ApiParam({ name: 'messageId', example: 'm_9aB3xKq8LpQ2Zt7W' })
  @ApiOkResponse({ type: MessageDetailDto })
  @ApiNotFoundResponse({
    type: ProblemDetailsDto,
    description: 'MESSAGE_NOT_FOUND (also for a message of another tenant)',
  })
  public get(
    @CurrentTenant() tenant: TenantContext,
    @Param('messageId') messageId: string,
  ): Promise<MessageDetailDto> {
    return this.messages.get(tenant.tenantId, messageId);
  }

  @Get('messages/:messageId/rendered')
  @ApiOperation({ summary: 'Subject and HTML body as rendered for this recipient' })
  @ApiParam({ name: 'messageId' })
  @ApiOkResponse({ type: RenderedMessageDto })
  @ApiNotFoundResponse({ type: ProblemDetailsDto, description: 'MESSAGE_NOT_FOUND' })
  public rendered(
    @CurrentTenant() tenant: TenantContext,
    @Param('messageId') messageId: string,
  ): Promise<RenderedMessageDto> {
    return this.messages.rendered(tenant.tenantId, messageId);
  }

  @Get('messages/:messageId/eml')
  @ApiOperation({
    summary: 'The PEC exactly as transmitted (message/rfc822)',
    description:
      'Byte for byte what was handed to the provider. The Repr-Digest header (RFC 9530) carries the SHA-256 ' +
      'recorded when the file was written: compare it with the digest of what you received.',
  })
  @ApiParam({ name: 'messageId' })
  @ApiProduces('message/rfc822')
  @ApiOkResponse({ description: 'The .eml file', schema: { type: 'string', format: 'binary' } })
  @ApiConflictResponse({
    type: ProblemDetailsDto,
    description: 'EML_NOT_AVAILABLE: nothing was transmitted yet',
  })
  @ApiNotFoundResponse({ type: ProblemDetailsDto, description: 'MESSAGE_NOT_FOUND' })
  public async eml(
    @CurrentTenant() tenant: TenantContext,
    @Param('messageId') messageId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<StreamableFile> {
    return download(reply, await this.messages.eml(tenant.tenantId, messageId));
  }

  @Get('messages/:messageId/receipts')
  @ApiOperation({
    summary: 'The PEC receipts of a message, oldest first',
    description:
      'Read from the mailbox by the worker and matched on the Message-ID they quote. Each one can be ' +
      'downloaded as the provider sent it (signed) and as its daticert.xml.',
  })
  @ApiParam({ name: 'messageId' })
  @ApiOkResponse({ type: ReceiptListDto })
  @ApiNotFoundResponse({ type: ProblemDetailsDto, description: 'MESSAGE_NOT_FOUND' })
  public receipts(
    @CurrentTenant() tenant: TenantContext,
    @Param('messageId') messageId: string,
  ): Promise<ReceiptListDto> {
    return this.messages.listReceipts(tenant.tenantId, messageId);
  }

  @Get('receipts/:receiptId/eml')
  @ApiTags('receipts')
  @ApiOperation({
    summary: 'A receipt exactly as the provider delivered it (message/rfc822, signed)',
    description: 'The legal proof. Repr-Digest carries the SHA-256 recorded when it was read.',
  })
  @ApiParam({ name: 'receiptId', example: 'r_Kq8aZt7W9aB3xKq8' })
  @ApiProduces('message/rfc822')
  @ApiOkResponse({ description: 'The .eml file', schema: { type: 'string', format: 'binary' } })
  @ApiNotFoundResponse({ type: ProblemDetailsDto, description: 'RECEIPT_NOT_FOUND' })
  public async receiptEml(
    @CurrentTenant() tenant: TenantContext,
    @Param('receiptId') receiptId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<StreamableFile> {
    return download(reply, await this.messages.receiptEml(tenant.tenantId, receiptId));
  }

  @Get('receipts/:receiptId/daticert')
  @ApiTags('receipts')
  @ApiOperation({ summary: 'The daticert.xml of a receipt (application/xml)' })
  @ApiParam({ name: 'receiptId' })
  @ApiProduces('application/xml')
  @ApiOkResponse({ description: 'daticert.xml', schema: { type: 'string', format: 'binary' } })
  @ApiNotFoundResponse({ type: ProblemDetailsDto, description: 'RECEIPT_NOT_FOUND, DATICERT_NOT_FOUND' })
  public async receiptDaticert(
    @CurrentTenant() tenant: TenantContext,
    @Param('receiptId') receiptId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<StreamableFile> {
    return download(reply, await this.messages.receiptDaticert(tenant.tenantId, receiptId));
  }
}
