import { describe, expect, it } from 'vitest';

import {
  API_KEY_PREFIX,
  generateApiKey,
  sha256Hex,
  timingSafeEqualHex,
} from '../../../src/common/security/hash';

describe('sha256Hex', () => {
  it('matches a known digest', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('timingSafeEqualHex', () => {
  it('is true only for identical digests', () => {
    const a = sha256Hex('x');
    expect(timingSafeEqualHex(a, a)).toBe(true);
    expect(timingSafeEqualHex(a, sha256Hex('y'))).toBe(false);
  });

  it('is false for different lengths and empty input without throwing', () => {
    expect(timingSafeEqualHex('ab', 'abcd')).toBe(false);
    expect(timingSafeEqualHex('', '')).toBe(false);
  });
});

describe('generateApiKey', () => {
  it('produces a prefixed, high-entropy key and its hash', () => {
    const { key, sha256 } = generateApiKey();

    expect(key.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(key.length).toBeGreaterThanOrEqual(API_KEY_PREFIX.length + 43);
    expect(sha256).toBe(sha256Hex(key));
  });

  it('never repeats', () => {
    const keys = new Set(Array.from({ length: 100 }, () => generateApiKey().key));
    expect(keys.size).toBe(100);
  });
});
