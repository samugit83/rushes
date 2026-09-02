// Egress control. A TypeScript port of the rule the monorepo already settled on
// in `recon_orchestrator/ip_denylist.py` (imported by
// `scanners/capture_proxy/egress.py`), NOT a new one (SP3). Behaviour must match
// so an operator does not learn two different rules.
//
// The load-bearing decisions, all inherited:
//   - Classify the RESOLVED IP, never the hostname. An in-scope-looking name can
//     point at 169.254.169.254 (cloud metadata) or 127.0.0.1:7474 (an
//     unauthenticated database console), and DNS rebinding defeats name checks
//     by construction.
//   - EVERY resolved address must clear the policy. A name that returns one
//     public and one internal address is hostile, and taking the first would let
//     it through half the time.
//   - Pin the address that passed, and connect to that. A re-resolve between
//     check and connect is the TOCTOU hole.
//   - Fail closed: unparseable, unresolvable and IDNA errors are all refusals.
//
// Two allowlists, two purposes (CF9). `allowHosts` governs the APPLICATION
// origin. `external.allow` (P16) governs off-origin navigation. Neither widens
// the other: an external host must pass this classification AND be listed.

import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

export interface IpPolicy {
  blockPrivate: boolean;
  blockLoopback: boolean;
  blockLinkLocal: boolean;
  blockCgnat: boolean;
  blockReserved: boolean;
  blockMulticast: boolean;
  blockUnspecified: boolean;
}

/** Every field defaults to block, so a forgotten field can never open a hole. */
export const STRICT_POLICY: IpPolicy = {
  blockPrivate: true,
  blockLoopback: true,
  blockLinkLocal: true,
  blockCgnat: true,
  blockReserved: true,
  blockMulticast: true,
  blockUnspecified: true,
};

/**
 * Filming a local development server is the normal case for this tool, so
 * loopback and RFC1918 are reachable by default for the APPLICATION origin.
 * Link-local (cloud metadata) and CGNAT stay blocked at every profile: nothing
 * a demo needs lives at 169.254.169.254.
 */
export const LOCAL_APP_POLICY: IpPolicy = {
  ...STRICT_POLICY,
  blockPrivate: false,
  blockLoopback: false,
};

/**
 * Address classification is delegated to `net.BlockList`, which does real prefix
 * matching for both families.
 *
 * The hand-rolled string matcher this replaces got IPv4 right and IPv6 wrong in
 * two ways that matter: `0:0:0:0:0:0:0:1` is loopback written the long way and
 * was read as public, and a NAT64 prefix carries an IPv4 address inside an IPv6
 * one, so `64:ff9b::7f00:1` reached 127.0.0.1 while classifying as public.
 * Matching on the text of an address is the wrong shape of solution; the stdlib
 * matches on the bits.
 */
type Category = 'private' | 'loopback' | 'linkLocal' | 'cgnat' | 'reserved' | 'multicast' | 'unspecified';

const RANGES: { category: Category; net: string; prefix: number; family: 'ipv4' | 'ipv6' }[] = [
  { category: 'unspecified', net: '0.0.0.0', prefix: 32, family: 'ipv4' },
  { category: 'loopback', net: '127.0.0.0', prefix: 8, family: 'ipv4' },
  { category: 'linkLocal', net: '169.254.0.0', prefix: 16, family: 'ipv4' },
  { category: 'cgnat', net: '100.64.0.0', prefix: 10, family: 'ipv4' },
  { category: 'private', net: '10.0.0.0', prefix: 8, family: 'ipv4' },
  { category: 'private', net: '172.16.0.0', prefix: 12, family: 'ipv4' },
  { category: 'private', net: '192.168.0.0', prefix: 16, family: 'ipv4' },
  { category: 'multicast', net: '224.0.0.0', prefix: 4, family: 'ipv4' },
  { category: 'reserved', net: '240.0.0.0', prefix: 4, family: 'ipv4' },
  { category: 'reserved', net: '192.0.0.0', prefix: 24, family: 'ipv4' },
  { category: 'reserved', net: '192.0.2.0', prefix: 24, family: 'ipv4' },
  { category: 'reserved', net: '198.18.0.0', prefix: 15, family: 'ipv4' },
  { category: 'reserved', net: '198.51.100.0', prefix: 24, family: 'ipv4' },
  { category: 'reserved', net: '203.0.113.0', prefix: 24, family: 'ipv4' },
  { category: 'unspecified', net: '::', prefix: 128, family: 'ipv6' },
  { category: 'loopback', net: '::1', prefix: 128, family: 'ipv6' },
  { category: 'linkLocal', net: 'fe80::', prefix: 10, family: 'ipv6' },
  { category: 'private', net: 'fc00::', prefix: 7, family: 'ipv6' },
  { category: 'multicast', net: 'ff00::', prefix: 8, family: 'ipv6' },
  { category: 'reserved', net: '2001:db8::', prefix: 32, family: 'ipv6' },
];

const BLOCKS = new Map<Category, BlockList>();
for (const r of RANGES) {
  let list = BLOCKS.get(r.category);
  if (!list) { list = new BlockList(); BLOCKS.set(r.category, list); }
  list.addSubnet(r.net, r.prefix, r.family);
}

/** The IPv4 embedded in a well-known IPv6 transition address, if there is one. */
function embeddedIpv4(ip: string): string | null {
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return mapped[1];
  // NAT64 (RFC 6052) carries the four IPv4 bytes in the last 32 bits. A name
  // that resolves to 64:ff9b::7f00:1 reaches 127.0.0.1, and classifying the
  // outer address as public would let it through.
  const nat64 = ip.match(/^64:ff9b:(?::0*)*:?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (nat64) {
    const hi = parseInt(nat64[1], 16);
    const lo = parseInt(nat64[2], 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  const mappedHex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return null;
}

function normalise(ipRaw: string): string {
  return ipRaw.split('%')[0].trim().toLowerCase();
}

const POLICY_CATEGORY: [keyof IpPolicy, Category][] = [
  ['blockUnspecified', 'unspecified'],
  ['blockLoopback', 'loopback'],
  ['blockLinkLocal', 'linkLocal'],
  ['blockCgnat', 'cgnat'],
  ['blockPrivate', 'private'],
  ['blockMulticast', 'multicast'],
  ['blockReserved', 'reserved'],
];

/** True when `ipStr` must not be reached under `policy`. Unparseable -> refuse. */
export function isInternalIp(ipStr: string, policy: IpPolicy = STRICT_POLICY, extraBlocked: string[] = []): boolean {
  const ip = normalise(ipStr);
  const version = isIP(ip);
  if (version === 0) return true; // fail closed

  // Classify the embedded IPv4 too, so a transition address cannot smuggle an
  // internal destination inside a public-looking outer address.
  const inner = version === 6 ? embeddedIpv4(ip) : null;
  const targets: [string, 'ipv4' | 'ipv6'][] = [[ip, version === 4 ? 'ipv4' : 'ipv6']];
  if (inner && isIP(inner) === 4) targets.push([inner, 'ipv4']);

  for (const [flag, category] of POLICY_CATEGORY) {
    if (!policy[flag]) continue;
    const list = BLOCKS.get(category);
    if (!list) continue;
    for (const [addr, family] of targets) {
      if (list.check(addr, family)) return true;
    }
  }

  for (const entry of extraBlocked) {
    const e = entry.trim();
    if (!e) continue;
    try {
      const list = new BlockList();
      if (e.includes('/')) {
        const [net, bits] = e.split('/');
        const fam = isIP(net) === 6 ? 'ipv6' : 'ipv4';
        list.addSubnet(net, Number(bits), fam);
      } else {
        list.addAddress(e, isIP(e) === 6 ? 'ipv6' : 'ipv4');
      }
      for (const [addr, family] of targets) if (list.check(addr, family)) return true;
    } catch {
      continue; // an unparseable denylist entry is skipped, never a pass
    }
  }
  return false;
}

/** Every A/AAAA address for `host`. A bare IP passes through. [] on any failure. */
export async function resolveHost(host: string): Promise<string[]> {
  if (isIP(host)) return [host];
  try {
    const infos = await lookup(host, { all: true, verbatim: true });
    return [...new Set(infos.map((i) => i.address))];
  } catch {
    return []; // unresolvable / bad IDNA -> refuse
  }
}

// Government, military, education and intergovernmental TLDs. Mirrors
// `recon_orchestrator/hard_guardrail.py`; this tool ships from an offensive
// security monorepo and must not be mistakable for reconnaissance.
const HARD_TLD_RE = new RegExp(
  [
    '\\.gov$', '\\.gov\\.[a-z]{2,3}$', '\\.gob\\.[a-z]{2,3}$', '\\.gouv\\.[a-z]{2,3}$',
    '\\.govt\\.[a-z]{2,3}$', '\\.go\\.[a-z]{2}$', '\\.gv\\.[a-z]{2}$', '\\.government\\.[a-z]{2,3}$',
    '\\.mil$', '\\.mil\\.[a-z]{2,3}$',
    '\\.edu$', '\\.edu\\.[a-z]{2,3}$', '\\.ac\\.[a-z]{2,3}$',
    '\\.int$',
  ].map((p) => `(?:${p})`).join('|'),
  'i',
);

export function isHardBlocked(host: string): { blocked: boolean; reason: string } {
  const d = (host || '').trim().replace(/\.+$/, '').toLowerCase();
  if (!d) return { blocked: false, reason: '' };
  if (HARD_TLD_RE.test(d)) {
    return { blocked: true, reason: `'${d}' is a government, military, educational or intergovernmental domain` };
  }
  return { blocked: false, reason: '' };
}

export interface Classification {
  allowed: boolean;
  /** The address that passed. Connect to THIS, never re-resolve (TOCTOU). */
  pinnedIp: string | null;
  reason: string;
  host: string;
}

/**
 * Resolve `host` and decide whether it may be reached. `allowed` is true only
 * with a concrete pinned IP, so an empty or unresolvable host is never approved
 * regardless of the policy toggles.
 */
export async function classifyHost(
  host: string,
  policy: IpPolicy = STRICT_POLICY,
  extraBlocked: string[] = [],
): Promise<Classification> {
  const h = (host || '').trim().replace(/\.+$/, '').toLowerCase();
  if (!h) return { allowed: false, pinnedIp: null, reason: 'empty host', host: h };

  const hard = isHardBlocked(h);
  if (hard.blocked) return { allowed: false, pinnedIp: null, reason: `hard-guardrail: ${hard.reason}`, host: h };

  const resolved = await resolveHost(h);
  if (!resolved.length) return { allowed: false, pinnedIp: null, reason: 'unresolvable', host: h };

  for (const ip of resolved) {
    if (isInternalIp(ip, policy, extraBlocked)) {
      return { allowed: false, pinnedIp: null, reason: `internal-ip:${ip}`, host: h };
    }
  }
  return { allowed: true, pinnedIp: resolved[0], reason: 'ok', host: h };
}

/**
 * `allowHosts` narrows; it never widens. An empty list means "no name
 * restriction beyond the IP classification"; a non-empty one means the host must
 * also match an entry (exact, or a leading-dot suffix).
 */
export function hostAllowed(host: string, allowHosts: string[]): boolean {
  if (!allowHosts.length) return true;
  const h = host.trim().toLowerCase();
  return allowHosts.some((a) => {
    const e = a.trim().toLowerCase().replace(/^\./, '');
    return h === e || h.endsWith(`.${e}`);
  });
}
