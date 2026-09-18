/**
 * How big the encoded message will be, the way a provider counts it: every
 * binary part base64-encoded (4 bytes for 3), plus MIME headers and
 * boundaries. Slightly pessimistic on purpose; a message refused at intake
 * costs nothing, one refused by the SMTP server after the batch was accepted
 * costs a support ticket.
 */
const PART_OVERHEAD = 1024;
const MESSAGE_OVERHEAD = 4096;

export function base64Size(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

export function estimateMessageBytes(input: {
  readonly subject: string;
  readonly html: string;
  readonly partSizes: readonly number[];
}): number {
  const body =
    base64Size(Buffer.byteLength(input.html, 'utf8')) + Buffer.byteLength(input.subject, 'utf8') * 3;
  const parts = input.partSizes.reduce((sum, size) => sum + base64Size(size) + PART_OVERHEAD, 0);

  return MESSAGE_OVERHEAD + body + parts;
}
