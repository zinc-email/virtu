import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { parseMessage } from "../src/mail/headers.ts";
import { signOutbound } from "../src/mailauth/sign.ts";
import { MAX_DKIM_SIGNATURES, verifyInbound } from "../src/mailauth/verify.ts";
import { dkimTxtRecord, makeRsaKeyPair, makeStubResolver } from "../src/mailauth/test-fixtures.ts";
import type { StressConfig } from "./config.ts";

/** Large-message authentication with blocked DNS, overload, and repeated recovery. */
export async function runAuthPressure(config: StressConfig): Promise<Record<string, number>> {
  const key = makeRsaKeyPair();
  const raw = Buffer.alloc(config.messageBytes);
  const header = Buffer.from(
    "From: sender@sender.test\r\nTo: alias@virtu.test\r\nSubject: stress\r\n\r\n",
  );
  const line = Buffer.from(`${"x".repeat(996)}\r\n`);
  header.copy(raw);
  for (let offset = header.length; offset < raw.length; offset += line.length)
    line.copy(raw, offset);
  raw[raw.length - 2] = 13;
  raw[raw.length - 1] = 10;
  const parsed = parseMessage(raw);
  const signed = await signOutbound(parsed.headers, parsed.body, {
    dkimKeys: [{ signingDomain: "sender.test", selector: "s", privateKey: key.privateKeyPem }],
  });
  const fingerprint = createHash("sha256").update(signed.message).digest("hex");
  const stub = makeStubResolver({
    TXT: {
      "sender.test": "v=spf1 ip4:192.0.2.1 -all",
      "s._domainkey.sender.test": dkimTxtRecord(key),
      "_dmarc.sender.test": "v=DMARC1; p=reject",
    },
  });
  const session = {
    remoteAddress: "192.0.2.1",
    envelopeFrom: "sender@sender.test",
    mta: "mx.virtu.test",
  };
  let shed = 0;
  let recovered = 0;
  let budgetRefused = 0;
  for (let round = 0; round < config.rounds; round++) {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reachedDns = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let lookups = 0;
    const resolver = async (name: string, type: string) => {
      lookups++;
      entered();
      await gate;
      return stub(name, type);
    };
    try {
      const first = verifyInbound(session, signed.message, { resolver, timeoutMs: 100 });
      await reachedDns;
      const stalled = await first;
      assert.equal(stalled.completion, "incomplete");
      assert.equal(stalled.verdict.action === "reject" && stalled.verdict.reason, "verify-timeout");
      const before = lookups;
      const refusals = await Promise.all(
        Array.from({ length: config.clients }, () =>
          verifyInbound(session, signed.message, { resolver }),
        ),
      );
      for (const refusal of refusals) {
        assert.equal(
          refusal.verdict.action === "reject" && refusal.verdict.reason,
          "verify-bulkhead",
        );
        assert.equal(refusal.arcContext, null);
        shed++;
      }
      assert.equal(lookups, before, "Overloaded callers started additional DNS work");
    } finally {
      release();
    }
    // Wait for the timed-out library work to actually release its retained slot.
    const until = performance.now() + config.timeoutMs;
    for (;;) {
      const healthy = await verifyInbound(session, signed.message, { resolver: stub });
      if (healthy.completion === "complete") {
        assert.equal(healthy.verdict.action, "accept");
        assert.equal(healthy.raw.dkim.results?.[0]?.status.result, "pass");
        recovered++;
        break;
      }
      assert(performance.now() < until, "Authentication slot did not recover after DNS resumed");
      await Bun.sleep(10);
    }
    const excessive = Buffer.concat([
      Buffer.from(signed.dkimHeaders.repeat(MAX_DKIM_SIGNATURES + 1)),
      raw,
    ]);
    let budgetLookups = 0;
    const limited = await verifyInbound(session, excessive, {
      resolver: async (name, type) => {
        budgetLookups++;
        return stub(name, type);
      },
    });
    assert.equal(limited.completion, "incomplete");
    assert.equal(limited.verdict.action === "reject" && limited.verdict.code, 451);
    assert.equal(budgetLookups, 0, "Signature budget was enforced after DNS work");
    budgetRefused++;
  }
  assert.equal(createHash("sha256").update(signed.message).digest("hex"), fingerprint);
  return { messageBytes: raw.length, rounds: config.rounds, shed, recovered, budgetRefused };
}
