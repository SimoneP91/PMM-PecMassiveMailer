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
  // ::/96 (with :: and ::1) and ::ffff:0:0/96 are not listed: they carry an IPv4 address,
  // judged as such below. Listed here, BlockList would also match every IPv4 address against them.
  ['64:ff9b:1::', 48], // local-use NAT64
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const) {
  FORBIDDEN.addSubnet(network, prefix, 'ipv6');
}

/** The eight 16-bit groups of an IPv6 address; undefined when it is not one. */
function groupsOf(address: string): number[] | undefined {
  let text = address.toLowerCase();
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted !== null) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) {
    return undefined;
  }
  const [first = '', second] = halves;
  const head = first === '' ? [] : first.split(':');
  const tail = second === undefined || second === '' ? [] : second.split(':');
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (second === undefined && missing !== 0)) {
    return undefined;
  }
  const groups = [...head, ...Array<string>(missing).fill('0'), ...tail].map((group) =>
    /^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : Number.NaN,
  );

  return groups.every((group) => !Number.isNaN(group)) ? groups : undefined;
}

/**
 * The IPv4 address an IPv6 address carries: IPv4-mapped (::ffff:a.b.c.d,
 * which a URL parser rewrites as ::ffff:xxxx:xxxx), IPv4-compatible
 * (::a.b.c.d, deprecated; :: and ::1 fall here too, as 0.0.0.0 and 0.0.0.1)
 * or NAT64 (64:ff9b::a.b.c.d, how an IPv6-only cluster reaches IPv4 hosts).
 */
function embeddedIpv4(address: string): string | undefined {
  const g = groupsOf(address);
  if (g === undefined) {
    return undefined;
  }
  const zeros = (from: number, to: number): boolean => g.slice(from, to).every((group) => group === 0);
  const mapped = zeros(0, 5) && (g[5] === 0xffff || g[5] === 0);
  const nat64 = g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6);
  if (!mapped && !nat64) {
    return undefined;
  }
  const high = g[6] ?? 0;
  const low = g[7] ?? 0;

  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

export function isForbiddenAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) {
    return true;
  }
  if (family === 6) {
    const carried = embeddedIpv4(address);
    if (carried !== undefined) {
      return FORBIDDEN.check(carried, 'ipv4');
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
