import { describe, expect, test } from "bun:test";
import { authThrottleKey } from "./authThrottle.ts";
import { clientKey, parseIpv6 } from "./ipAddress.ts";

describe("clientKey", () => {
  test("IPv4 is keyed exactly", () => {
    expect(clientKey("203.0.113.9")).toBe("203.0.113.9");
  });

  test("IPv4-mapped IPv6 folds to the IPv4 address, whatever the spelling", () => {
    expect(clientKey("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(clientKey("::ffff:cb00:7109")).toBe("203.0.113.9");
  });

  test("IPv6 is keyed by its /64: one allocation is one client", () => {
    const a = clientKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd");
    const b = clientKey("2001:db8:1:2::1");
    const c = clientKey("2001:0db8:0001:0002:0000:0000:0000:0002%eth0");
    expect(a).toBe("2001:db8:1:2::/64");
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(clientKey("2001:db8:1:3::1")).not.toBe(a);
  });

  test("loopback and unparseable input", () => {
    expect(clientKey("::1")).toBe("0:0:0:0::/64");
    expect(clientKey(undefined)).toBe("unknown");
    expect(clientKey("")).toBe("unknown");
    expect(clientKey("not:an:address")).toBe("not:an:address");
  });

  test("the AUTH throttle keys on the same client identity", () => {
    expect(authThrottleKey("2001:db8:1:2::1", "Alice")).toBe("2001:db8:1:2::/64|alice");
    expect(authThrottleKey("2001:db8:1:2::2", "alice")).toBe("2001:db8:1:2::/64|alice");
    expect(authThrottleKey("::ffff:10.0.0.1", "bob")).toBe("10.0.0.1|bob");
  });
});

describe("parseIpv6", () => {
  test("still lives here for the egress guard", () => {
    expect(parseIpv6("::1")?.[15]).toBe(1);
    expect(parseIpv6("::ffff:127.0.0.1")?.slice(10)).toEqual(
      new Uint8Array([0xff, 0xff, 127, 0, 0, 1]),
    );
    expect(parseIpv6("1:2:3:4:5:6:7:8:9")).toBeNull();
  });
});
