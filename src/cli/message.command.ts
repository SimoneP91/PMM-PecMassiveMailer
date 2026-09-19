import { hostname, userInfo } from 'node:os';

import type { INestApplicationContext } from '@nestjs/common';

import { asMessageId } from '../common/types/branded';
import { MessageQueueRepository, type StuckResolution } from '../modules/sending/message-queue.repository';

export async function runMessageStuck(app: INestApplicationContext): Promise<number> {
  const stuck = await app.get(MessageQueueRepository).listStuck();
  if (stuck.length === 0) {
    console.log('no STUCK message');

    return 0;
  }
  console.log(
    `${String(stuck.length)} STUCK message(s). Check the mailbox's Sent folder / webmail, then resolve each:`,
  );
  console.log('  message resolve <id> --as sent | requeue | failed\n');
  for (const message of stuck) {
    console.log(
      `${message._id}  batch=${message.batchId}  mailbox=${message.mailbox}  ref=${message.ref}  to=${message.to}\n` +
        `    since ${message.stuckAt?.toISOString() ?? '?'}  message-id ${message.messageIdHeader ?? '(none)'}\n` +
        `    ${message.lastError?.code ?? ''}: ${message.lastError?.detail ?? ''}`,
    );
  }

  return 0;
}

export async function runMessageResolve(
  app: INestApplicationContext,
  id: string,
  as: string | undefined,
): Promise<number> {
  if (as !== 'sent' && as !== 'requeue' && as !== 'failed') {
    console.error(
      '--as must be one of: sent (it left, count it as sent), requeue (it did not leave, send it again), failed',
    );

    return 1;
  }
  const resolution: StuckResolution = as;
  const queue = app.get(MessageQueueRepository);
  const by = `${userInfo().username}@${hostname()}`;
  const moved = await queue.resolveStuck(asMessageId(id), resolution, by, new Date());
  if (!moved) {
    const current = await queue.findById(asMessageId(id));
    console.error(
      current === null ? `unknown message "${id}"` : `message ${id} is ${current.status}, not STUCK`,
    );

    return 1;
  }
  console.log(`${id}: resolved as ${resolution}`);

  return 0;
}
