import { Inject, Injectable } from '@nestjs/common';

import type { MailboxCode, TenantId } from '../../common/types/branded';
import { PECMAILER_CONFIG } from '../../config/config.module';
import type { ResolvedConfig, ResolvedMailbox } from '../../config/config.loader';

/**
 * Read-only view of the mailboxes declared in the configuration file.
 *
 * Every lookup a request path uses is scoped by tenant: a mailbox code is
 * resolved *for* a tenant, never on its own, so a client cannot send through
 * another client's mailbox by guessing its code.
 */
@Injectable()
export class MailboxRegistry {
  private readonly byCode: ReadonlyMap<MailboxCode, ResolvedMailbox>;

  public constructor(@Inject(PECMAILER_CONFIG) config: ResolvedConfig) {
    this.byCode = new Map(config.mailboxes.map((mailbox) => [mailbox.code, mailbox]));
  }

  public all(): readonly ResolvedMailbox[] {
    return [...this.byCode.values()];
  }

  public forTenant(tenantId: TenantId): readonly ResolvedMailbox[] {
    return this.all().filter((mailbox) => mailbox.tenantId === tenantId);
  }

  public getForTenant(tenantId: TenantId, code: MailboxCode): ResolvedMailbox | undefined {
    const mailbox = this.byCode.get(code);

    return mailbox?.tenantId === tenantId ? mailbox : undefined;
  }

  /** Worker-side lookup, not tenant scoped: the worker serves every mailbox. */
  public get(code: MailboxCode): ResolvedMailbox | undefined {
    return this.byCode.get(code);
  }
}
