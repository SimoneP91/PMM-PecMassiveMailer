import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Prefix that makes a leaked key recognisable in logs, repositories and secret scanners. */
export const API_KEY_PREFIX = 'pm_';

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Compares two hex digests without leaking, through timing, how many leading
 * characters match. Lengths are compared as part of the check because
 * timingSafeEqual requires equal buffers.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length || bufA.length === 0) {
    return false;
  }

  return timingSafeEqual(bufA, bufB);
}

export interface GeneratedApiKey {
  /** Shown once to the person generating it, never stored. */
  readonly key: string;
  /** What goes in the configuration file. */
  readonly sha256: string;
}

/**
 * 256 bits of randomness, base64url: a key that cannot be guessed and does
 * not need a slow hash. SHA-256 is the right function for high-entropy tokens;
 * bcrypt/argon2 exist to protect low-entropy passwords, which this is not.
 */
export function generateApiKey(): GeneratedApiKey {
  const key = API_KEY_PREFIX + randomBytes(32).toString('base64url');

  return { key, sha256: sha256Hex(key) };
}
