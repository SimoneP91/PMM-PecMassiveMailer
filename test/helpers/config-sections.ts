import type { ResolvedConfig } from '../../src/config/config.loader';
import {
  receiptsConfigSchema,
  recipientsConfigSchema,
  sendingConfigSchema,
  webhooksConfigSchema,
} from '../../src/config/pecmailer-config.schema';

/** The global sections of a ResolvedConfig at their defaults, for fixtures built by hand. */
export function defaultSections(): Pick<ResolvedConfig, 'recipients' | 'sending' | 'receipts' | 'webhooks'> {
  return {
    recipients: recipientsConfigSchema.parse({}),
    sending: sendingConfigSchema.parse({}),
    receipts: receiptsConfigSchema.parse({}),
    webhooks: webhooksConfigSchema.parse({}),
  };
}
