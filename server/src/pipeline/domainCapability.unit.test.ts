import { describe, expect, test } from "bun:test";
import { canReceive, canSend } from "./domainCapability.ts";

const flags = (
  over: Partial<{
    verifiedOwner: boolean;
    verifiedMx: boolean;
    verifiedDkim: boolean;
    verifiedSpf: boolean;
  }> = {},
) => ({
  verifiedOwner: false,
  verifiedMx: false,
  verifiedDkim: false,
  verifiedSpf: false,
  ...over,
});

describe("canReceive", () => {
  test("needs ownership AND MX", () => {
    expect(canReceive(flags({ verifiedOwner: true, verifiedMx: true }))).toBe(true);
    expect(canReceive(flags({ verifiedOwner: true, verifiedMx: false }))).toBe(false);
    expect(canReceive(flags({ verifiedOwner: false, verifiedMx: true }))).toBe(false);
  });
});

describe("canSend", () => {
  test("needs ownership AND DKIM AND SPF", () => {
    expect(canSend(flags({ verifiedOwner: true, verifiedDkim: true, verifiedSpf: true }))).toBe(
      true,
    );
    expect(canSend(flags({ verifiedOwner: true, verifiedDkim: true, verifiedSpf: false }))).toBe(
      false,
    );
    expect(canSend(flags({ verifiedOwner: true, verifiedDkim: false, verifiedSpf: true }))).toBe(
      false,
    );
    expect(canSend(flags({ verifiedOwner: false, verifiedDkim: true, verifiedSpf: true }))).toBe(
      false,
    );
  });

  test("DMARC is not part of the gate", () => {
    // A domain with owner+dkim+spf can send even with DMARC unset.
    expect(canSend(flags({ verifiedOwner: true, verifiedDkim: true, verifiedSpf: true }))).toBe(
      true,
    );
  });
});
