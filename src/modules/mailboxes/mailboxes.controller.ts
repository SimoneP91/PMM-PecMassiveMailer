import { Controller, Get } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { ProblemDetailsDto } from '../../common/errors/problem-details.dto';
import { CurrentTenant } from '../auth/current-tenant.decorator';
import type { TenantContext } from '../auth/tenant-context';
import { MailboxListDto } from './mailbox.dto';
import { MailboxRegistry } from './mailbox.registry';
import { MailboxStateStore } from './mailbox-state.store';

@ApiTags('mailboxes')
@ApiBearerAuth('apiKey')
@Controller('v1/mailboxes')
export class MailboxesController {
  public constructor(
    private readonly mailboxes: MailboxRegistry,
    private readonly states: MailboxStateStore,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List the mailboxes of the calling tenant',
    description:
      'Returns every mailbox the tenant may send from, with its state and limits. ' +
      'Use it before submitting a batch to check that the mailbox is active.',
  })
  @ApiOkResponse({ type: MailboxListDto })
  @ApiUnauthorizedResponse({ type: ProblemDetailsDto, description: 'Missing or unknown API key' })
  public async list(@CurrentTenant() tenant: TenantContext): Promise<MailboxListDto> {
    const mailboxes = this.mailboxes.forTenant(tenant.tenantId);
    const states = await this.states.getMany(mailboxes.map((mailbox) => mailbox.code));

    return {
      items: mailboxes.map((mailbox) => ({
        mailbox: mailbox.code,
        from: mailbox.from,
        provider: mailbox.provider,
        status: states.get(mailbox.code)?.status ?? 'ACTIVE',
        archivesSentCopy: mailbox.imap !== null,
        limits: mailbox.limits,
      })),
    };
  }
}
