/**
 * IP address parsing and the per-client accounting key.
 *
 * Every per-client bound on the SMTP edge (concurrent connections, the
 * AUTH throttle) needs a key that names the party on the other end. The
 * full address is the wrong key for IPv6: a routine allocation is a /64,
 * so one attacker has 2^64 distinct addresses and a cap "per address"
 * never bites. Postfix aggregates at `smtpd_client_ipv6_prefix_length`
 * (default /84); we use /64, the allocation boundary, and the exact
 * address for IPv4. Everything that keys on a client goes through
 * {@link clientKey} so the two can never disagree.
 */

/** IPv6 prefix length one client key covers. */
export const CLIENT_KEY_IPV6_PREFIX = 64;

/**
 * Parse an IPv6 text address into its 16 bytes; null when it is not one.
 * Handles `::` compression and a dotted-IPv4 tail (`::ffff:10.0.0.1`).
 * Written out rather than relying on `net.isIPv6` alone because callers
 * must classify the NUMBER, not the spelling — `0:0:0:0:0:0:0:1`,
 * `::ffff:7f00:1` and `::ffff:127.0.0.1` are the same addresses.
 */
export function parseIpv6(text: string): Uint8Array | null {
  let s = text.trim().toLowerCase();
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);
  if (s === "" || !/^[0-9a-f:.]+$/.test(s)) return null;
  // Dotted IPv4 tail → two hextets.
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const octets = tail.split(".").map((o) => (/^\d{1,3}$/.test(o) ? Number(o) : Number.NaN));
    if (octets.length !== 4 || octets.some((o) => Number.isNaN(o) || o > 255)) return null;
    const [o0, o1, o2, o3] = octets as [number, number, number, number];
    s = `${s.slice(0, lastColon + 1)}${((o0 << 8) | o1).toString(16)}:${((o2 << 8) | o3).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parseGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(Number.parseInt(g, 16));
    }
    return out;
  };
  const head = parseGroups(halves[0]!);
  const rest = halves.length === 2 ? parseGroups(halves[1]!) : [];
  if (head === null || rest === null) return null;
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...new Array<number>(missing).fill(0), ...rest];
  const bytes = new Uint8Array(16);
  groups.forEach((g, i) => {
    bytes[2 * i] = g >> 8;
    bytes[2 * i + 1] = g & 0xff;
  });
  return bytes;
}

/** True for `::ffff:a.b.c.d`, an IPv4 address carried in IPv6 form. */
function isIpv4Mapped(bytes: Uint8Array): boolean {
  for (let i = 0; i < 10; i++) if (bytes[i] !== 0) return false;
  return bytes[10] === 0xff && bytes[11] === 0xff;
}

/**
 * The key one remote address is accounted under: the exact address for
 * IPv4 (including IPv4-mapped IPv6, which a dual-stack listener reports
 * for IPv4 peers), the /64 prefix for IPv6 (`2001:db8:1:2::/64`), and
 * "unknown" when the socket has no peer address.
 */
export function clientKey(remoteAddress: string | undefined): string {
  if (remoteAddress === undefined || remoteAddress === "") return "unknown";
  if (!remoteAddress.includes(":")) return remoteAddress;
  const bytes = parseIpv6(remoteAddress);
  if (bytes === null) return remoteAddress;
  if (isIpv4Mapped(bytes)) return `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
  const groups: string[] = [];
  for (let i = 0; i < CLIENT_KEY_IPV6_PREFIX / 16; i++) {
    groups.push(((bytes[2 * i]! << 8) | bytes[2 * i + 1]!).toString(16));
  }
  return `${groups.join(":")}::/${CLIENT_KEY_IPV6_PREFIX}`;
}
