import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { BlockList, isIP } from 'node:net';

/**
 * Anti-SSRF: the addresses a webhook may not reach unless the tenant's
 * configuration says allowPrivateNetwork. Checked on the address the socket
 * actually connects to (after DNS), so a name that resolves - or later
 * re-resolves - to an internal address is refused just the same.
 */
const FORBIDDEN = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata endpoints
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
] as const) {
  FORBIDDEN.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const) {
  FORBIDDEN.addSubnet(network, prefix, 'ipv6');
}

export function isForbiddenAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) {
    return true;
  }
  if (family === 6) {
    // IPv4-mapped (::ffff:10.0.0.1) is judged as the IPv4 address it carries.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped?.[1] !== undefined) {
      return FORBIDDEN.check(mapped[1], 'ipv4');
    }

    return FORBIDDEN.check(address, 'ipv6');
  }

  return FORBIDDEN.check(address, 'ipv4');
}

export class ForbiddenAddressError extends Error {
  public readonly code = 'EFORBIDDENADDRESS';

  public constructor(host: string, address: string) {
    super(`${host} resolves to ${address}, a private or reserved address`);
    this.name = 'ForbiddenAddressError';
  }
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/** A drop-in `lookup` for http(s).request that refuses forbidden addresses. */
export function guardedLookup(hostname: string, options: LookupOptions, callback: LookupCallback): void {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error !== null) {
      callback(error, '');

      return;
    }
    const list = addresses;
    const bad = list.find((entry) => isForbiddenAddress(entry.address));
    if (bad !== undefined || list.length === 0) {
      callback(new ForbiddenAddressError(hostname, bad?.address ?? 'nothing'), '');

      return;
    }
    if (options.all === true) {
      callback(null, list);
    } else {
      const first = list[0];
      callback(null, first?.address ?? '', first?.family);
    }
  });
}
