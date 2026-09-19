import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { Connection, type SyncMessage } from 'rabbitmq-client';

import type { QueueSettings } from '../config/config';
import { parseBody } from '../queue/queues';
import { declarations } from '../queue/rabbit-queues';

/**
 * Development tools: play the CRM without writing it. `publish` puts a PEC in
 * the input queue from a JSON file; `outcomes` prints (and optionally saves)
 * what the container reported. Both talk to RabbitMQ directly, with the
 * queue names the container itself uses.
 */

type Json = Record<string, unknown>;

function connect(settings: QueueSettings): Connection {
  return new Connection({
    url: settings.url.reveal(),
    connectionName: 'pecmailer cli',
    retryLow: 500,
    retryHigh: 2000,
  });
}

async function readSource(file: string): Promise<{ text: string; base: string }> {
  if (file === '-') {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }

    return { text: Buffer.concat(chunks).toString('utf8'), base: process.cwd() };
  }

  return { text: await readFile(file, 'utf8'), base: dirname(resolve(file)) };
}

/**
 * A convenience of this tool only, not of the contract: a file entry with
 * `path` instead of `content` is read from disk (relative to the JSON file)
 * and encoded, so a test PEC can point at a real PDF.
 */
async function inlineFiles(entries: unknown, base: string): Promise<unknown> {
  if (!Array.isArray(entries)) {
    return entries;
  }

  return Promise.all(
    entries.map(async (entry: unknown) => {
      if (typeof entry !== 'object' || entry === null || !('path' in entry) || 'content' in entry) {
        return entry;
      }
      const { path, ...rest } = entry as Json;
      const content = await readFile(join(base, String(path)));

      return { filename: String(path).split(/[\\/]/).at(-1), ...rest, content: content.toString('base64') };
    }),
  );
}

export async function runPublish(settings: QueueSettings, file: string): Promise<number> {
  const { text, base } = await readSource(file);
  const pec = JSON.parse(text) as Json;
  pec['version'] ??= 1;
  pec['id'] ??= randomUUID().replaceAll('-', '');
  if (pec['attachments'] !== undefined) {
    pec['attachments'] = await inlineFiles(pec['attachments'], base);
  }
  if (pec['inlineImages'] !== undefined) {
    pec['inlineImages'] = await inlineFiles(pec['inlineImages'], base);
  }

  const rabbit = connect(settings);
  const queues = declarations(settings);
  const publisher = rabbit.createPublisher({
    confirm: true,
    queues: settings.declare ? [queues.dead, queues.output, queues.input] : [],
  });
  try {
    await publisher.send({ routingKey: settings.input, durable: true, messageId: String(pec['id']) }, pec);
    console.log(`queued in ${settings.input}: id ${String(pec['id'])}`);

    return 0;
  } finally {
    await publisher.close();
    await rabbit.close();
  }
}

/** A field of an event as text: strings and numbers as they are, anything else as JSON. */
function text(value: unknown, fallback = ''): string {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return JSON.stringify(value);
}

function kb(base64: unknown): string {
  return typeof base64 === 'string' ? `${String(Math.round((base64.length * 3) / 4 / 1024))} KB` : '-';
}

/** One line per event, without the heavy base64 fields. */
export function summarise(event: Json): string {
  const id = text(event['id']);
  switch (event['event']) {
    case 'sent':
      return `sent       ${id}  ${String(event['messageId'])} via ${String(event['confirmedBy'])}, Sent copy ${String(event['sentCopy'])}`;
    case 'rejected':
      return `rejected   ${id}  ${((event['errors'] as Json[] | undefined) ?? []).map((e) => `${String(e['code'])} ${text(e['field'])}: ${String(e['detail'])}`).join('; ')}`;
    case 'failed':
      return `failed     ${id}  ${String(event['code'])}: ${String(event['detail'])}`;
    case 'uncertain':
      return `uncertain  ${id}  ${String(event['reason'])}: ${String(event['detail'])}`;
    case 'receipt':
      return `receipt    ${id}  ${String(event['receiptType'])}${event['final'] === true ? ' (final)' : ''} from ${text(event['provider'], '?')}, eml ${kb(event['eml'])}${event['error'] === undefined ? '' : `, ${JSON.stringify(event['error'])}`}`;
    case 'mailbox.suspended':
      return `suspended  ${String(event['cause'])}: ${String(event['detail'])}`;
    default:
      return JSON.stringify(event);
  }
}

async function save(dir: string, event: Json): Promise<void> {
  await mkdir(dir, { recursive: true });
  const name = String(event['eventId']).replace(/[^A-Za-z0-9._-]/g, '_');
  const { eml, daticert, ...rest } = event;
  await writeFile(join(dir, `${name}.json`), JSON.stringify(rest, null, 2));
  if (typeof eml === 'string') {
    await writeFile(join(dir, `${name}.eml`), Buffer.from(eml, 'base64'));
  }
  if (typeof daticert === 'string') {
    await writeFile(join(dir, `${name}.daticert.xml`), Buffer.from(daticert, 'base64'));
  }
}

/**
 * Empties the output queue, printing each event; with `follow`, keeps waiting
 * for new ones until Ctrl+C. The events are acknowledged: like a real
 * consumer, this tool takes them away.
 */
export async function runOutcomes(
  settings: QueueSettings,
  options: { follow: boolean; saveTo?: string },
): Promise<number> {
  const rabbit = connect(settings);
  const channel = await rabbit.acquire();
  // An object, not a let: the signal handler flips it between two awaits of the loop.
  const state = { stop: false };
  process.once('SIGINT', () => {
    state.stop = true;
  });
  try {
    for (;;) {
      const message: SyncMessage | undefined = await channel.basicGet({ queue: settings.output });
      if (message === undefined) {
        if (!options.follow || state.stop) {
          return 0;
        }
        await new Promise((done) => setTimeout(done, 1000));
        continue;
      }
      const event = parseBody(message.body);
      if (typeof event === 'object' && event !== null) {
        console.log(summarise(event as Json));
        if (options.saveTo !== undefined) {
          await save(options.saveTo, event as Json);
        }
      } else {
        console.log(`(not JSON) ${String(message.body)}`);
      }
      channel.basicAck({ deliveryTag: message.deliveryTag });
    }
  } finally {
    await channel.close();
    await rabbit.close();
  }
}
