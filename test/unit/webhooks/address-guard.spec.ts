import type { LookupAddress } from 'node:dns';

import { describe, expect, it } from 'vitest';

import { guardedLookup, isForbiddenAddress } from '../../../src/modules/webhooks/address-guard';

describe('isForbiddenAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.10',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::',
    'fd00::1',
    'fe80::1',
    '::ffff:10.0.0.1',
    '::ffff:127.0.0.1',
    '::ffff:a00:1', // what a URL parser makes of [::ffff:10.0.0.1]
    '::ffff:7f00:1',
    '0:0:0:0:0:ffff:169.254.169.254',
    '::a00:1', // IPv4-compatible, deprecated
    '64:ff9b::a00:1', // NAT64 towards 10.0.0.1
    '64:ff9b::169.254.169.254',
    '64:ff9b:1::1', // local-use NAT64
    'not-an-ip',
  ])('refuses %s', (address) => {
    expect(isForbiddenAddress(address)).toBe(true);
  });

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '172.32.0.1',
    '93.184.216.34',
    '2606:4700:4700::1111',
    '::ffff:8.8.8.8',
    '::ffff:808:808',
    '64:ff9b::808:808',
  ])('allows %s', (address) => {
    expect(isForbiddenAddress(address)).toBe(false);
  });
});

describe('guardedLookup', () => {
  it('refuses a name that resolves to loopback', async () => {
    const error = await new Promise<Error | null>((resolve) => {
      guardedLookup('localhost', {}, (err) => {
        resolve(err);
      });
    });

    expect(error?.message).toMatch(/private or reserved/);
  });

  it('answers in the shape the caller asked for', async () => {
    // "localhost" is the one name resolvable everywhere; allow it by checking the shape only through a public IP literal.
    const result = await new Promise<{ error: Error | null; address: string | LookupAddress[] }>(
      (resolve) => {
        guardedLookup('8.8.8.8', { all: true }, (error, address) => {
          resolve({ error, address });
        });
      },
    );

    expect(result.error).toBeNull();
    expect(result.address).toEqual([{ address: '8.8.8.8', family: 4 }]);
  });
});
