import { describe, expect, test } from "bun:test";
import { authThrottleKey, createAuthThrottle } from "./authThrottle.ts";

const at = (ms: number) => new Date(ms);

describe("createAuthThrottle", () => {
  test("limits after maxFailures within the window, not before", () => {
    const throttle = createAuthThrottle({ windowMs: 60_000, maxFailures: 3 });
    expect(throttle.isLimited("k", at(0))).toBe(false);
    throttle.recordFailure("k", at(0));
    throttle.recordFailure("k", at(1_000));
    expect(throttle.isLimited("k", at(2_000))).toBe(false);
    throttle.recordFailure("k", at(2_000));
    expect(throttle.isLimited("k", at(3_000))).toBe(true);
  });

  test("failures age out of the sliding window", () => {
    const throttle = createAuthThrottle({ windowMs: 60_000, maxFailures: 2 });
    throttle.recordFailure("k", at(0));
    throttle.recordFailure("k", at(1_000));
    expect(throttle.isLimited("k", at(2_000))).toBe(true);
    // 61s after the first failure only one remains live.
    expect(throttle.isLimited("k", at(61_000))).toBe(false);
  });

  test("keys are independent, and clear() forgets a key", () => {
    const throttle = createAuthThrottle({ windowMs: 60_000, maxFailures: 1 });
    throttle.recordFailure("a", at(0));
    expect(throttle.isLimited("a", at(1))).toBe(true);
    expect(throttle.isLimited("b", at(1))).toBe(false);
    throttle.clear("a");
    expect(throttle.isLimited("a", at(2))).toBe(false);
  });

  test("tracked keys are bounded: the least-recently-failing key is evicted", () => {
    const throttle = createAuthThrottle({ windowMs: 60_000, maxFailures: 1, maxKeys: 2 });
    throttle.recordFailure("a", at(0));
    throttle.recordFailure("b", at(1));
    throttle.recordFailure("a", at(2)); // refresh a — b is now oldest
    throttle.recordFailure("c", at(3)); // evicts b
    expect(throttle.isLimited("a", at(4))).toBe(true);
    expect(throttle.isLimited("b", at(4))).toBe(false);
    expect(throttle.isLimited("c", at(4))).toBe(true);
  });

  test("a limited key survives a churn of cheap one-failure keys", () => {
    // The attack this guards: burn the victim key to the limit, then flood
    // unknown-username failures so eviction would flush the victim and
    // re-open the hashing path. Eviction must prefer non-limited keys.
    const throttle = createAuthThrottle({ windowMs: 60_000, maxFailures: 2, maxKeys: 2 });
    throttle.recordFailure("victim", at(0));
    throttle.recordFailure("victim", at(1));
    expect(throttle.isLimited("victim", at(2))).toBe(true);
    for (let i = 0; i < 50; i++) throttle.recordFailure(`junk-${i}`, at(3 + i));
    expect(throttle.isLimited("victim", at(60))).toBe(true);
  });

  test("a limited key admits a trickle attempt after quiet trickleMs", () => {
    // The NAT-collateral guard: a stale device's failure burst must not
    // hard-lock a sibling device presenting VALID credentials — once the
    // burst pauses for trickleMs, one attempt goes through to the verifier.
    const throttle = createAuthThrottle({ windowMs: 60_000, maxFailures: 2, trickleMs: 5_000 });
    throttle.recordFailure("k", at(0));
    throttle.recordFailure("k", at(1_000));
    expect(throttle.isLimited("k", at(2_000))).toBe(true);
    expect(throttle.isLimited("k", at(6_500))).toBe(false); // quiet ≥ 5s → admitted
    // The admission itself is recorded: a CONCURRENT probe in the same
    // quiet gap is NOT admitted (one trickle slot, not one per connection).
    expect(throttle.isLimited("k", at(6_600))).toBe(true);
    // A failed trickle attempt re-arms the limit like any other failure.
    throttle.recordFailure("k", at(6_500));
    expect(throttle.isLimited("k", at(7_000))).toBe(true);
  });

  test("authThrottleKey normalizes the username", () => {
    expect(authThrottleKey("10.0.0.1", "  Wes@QMail.com ")).toBe("10.0.0.1|wes@qmail.com");
  });
});
