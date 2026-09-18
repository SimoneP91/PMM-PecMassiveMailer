import { inspect } from 'node:util';

import { describe, expect, it } from 'vitest';

import { Secret } from '../../../src/common/security/secret';

describe('Secret', () => {
  const secret = new Secret('hunter2');

  it('reveals only on request', () => {
    expect(secret.reveal()).toBe('hunter2');
  });

  it('hides the value from every accidental rendering', () => {
    expect(String(secret)).toBe('[redacted]');
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions -- the very accident this guards against
    expect(`${secret}`).toBe('[redacted]');
    expect(JSON.stringify({ secret })).toBe('{"secret":"[redacted]"}');
    expect(inspect(secret)).not.toContain('hunter2');
    expect(Object.keys(secret)).toEqual([]);
  });
});
