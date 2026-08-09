/**
 * End-to-end unit test of the mx pipeline's pure core, zero network:
 *
 *   fixture signed by fake "initech.com" (in-test keypair, stub resolver)
 *     → verifyInbound (dkim/spf/dmarc all pass, ARC context captured)
 *     → rewriteForward (whitelist, reverse aliases, provenance)
 *     → signOutbound (our DKIM key + ARC seal with the captured context)
 *     → mailauth authenticate() AGAIN with a stub resolver knowing OUR keys
 *       → our DKIM signature verifies, the ARC chain validates
 *         (inbound cv=none → sealed i=1 passes)
 *
 * This closes exactly the loop the real mx will run.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { authenticate, dkimSign } from "mailauth";
import { parseAddressList, parseMessage, serializeMessage } from "../mail/headers.ts";
import { rewriteForward } from "../mail/rewriteForward.ts";
import { buildVerp } from "../mail/verp.ts";
import { signOutbound } from "./sign.ts";
import {
  dkimTxtRecord,
  makeRsaKeyPair,
  makeStubResolver,
  type TestKeyPair,
} from "./test-fixtures.ts";
import { verifyInbound } from "./verify.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

const INITECH_IP = "203.0.113.5";
const OUR_IP = "192.0.2.10";
const VERP_SECRET = "verp-secret-verp-secret-verp-secret!";

let initechKey: TestKeyPair;
let ourDkimKey: TestKeyPair;
let ourArcKey: TestKeyPair;

beforeAll(() => {
  initechKey = makeRsaKeyPair();
  ourDkimKey = makeRsaKeyPair();
  ourArcKey = makeRsaKeyPair();
});

/** DNS as seen by OUR mx: knows initech's SPF/DKIM/DMARC. */
function internetZones(): Parameters<typeof makeStubResolver>[0] {
  return {
    TXT: {
      "initech.com": `v=spf1 ip4:${INITECH_IP} -all`,
      "sel1._domainkey.initech.com": dkimTxtRecord(initechKey),
      "_dmarc.initech.com": "v=DMARC1; p=reject",
    },
  };
}

/** DNS as seen by the RECEIVING mailbox provider: knows our keys + SPF. */
function mailboxProviderZones(): Parameters<typeof makeStubResolver>[0] {
  return {
    TXT: {
      "virtu.test": `v=spf1 ip4:${OUR_IP} -all`,
      "vs1._domainkey.virtu.test": dkimTxtRecord(ourDkimKey),
      "arc1._domainkey.virtu.test": dkimTxtRecord(ourArcKey),
      "_dmarc.virtu.test": "v=DMARC1; p=reject",
    },
  };
}

const ORIGINAL =
  "From: Milton Waddams <milton@initech.com>\r\n" +
  "To: asdf@user.com\r\n" +
  "Subject: TPS reports — cover sheets\r\n" +
  "Date: Fri, 07 Aug 2026 10:00:00 +0000\r\n" +
  "Message-ID: <orig-1@initech.com>\r\n" +
  "Mime-Version: 1.0\r\n" +
  "Content-Type: text/plain; charset=utf-8\r\n" +
  "X-Mailer: LotusNotes\r\n" +
  "X-Virtu-Test-Id: 01J9TESTULID\r\n" +
  "\r\n" +
  "Please find the cover sheets attached.\r\n";

describe("mx pipeline: verify → rewrite → sign/seal → re-verify", () => {
  test("the full loop", async () => {
    // ── 0. Milton's MTA signs the message as initech.com ────────────────
    const signed = await dkimSign(ORIGINAL, {
      signingDomain: "initech.com",
      selector: "sel1",
      privateKey: initechKey.privateKeyPem,
      signatureData: [
        {
          signingDomain: "initech.com",
          selector: "sel1",
          privateKey: initechKey.privateKeyPem,
        },
      ] as never,
    });
    const inbound = signed.signatures + ORIGINAL;

    // ── 1. Our mx verifies the inbound message ──────────────────────────
    const verification = await verifyInbound(
      {
        remoteAddress: INITECH_IP,
        heloHostname: "mail.initech.com",
        envelopeFrom: "milton@initech.com",
        mta: "mx.virtu.test",
      },
      inbound,
      { resolver: makeStubResolver(internetZones()) },
    );

    expect(verification.verdict).toEqual({ action: "accept" });
    expect(verification.raw.dkim.results?.[0]?.status.result).toBe("pass");
    expect(verification.raw.dmarc !== false && verification.raw.dmarc.status.result).toBe(
      "pass",
    );
    expect(verification.arcContext).not.toBeNull();
    expect(verification.arcContext!.cv).toBe("none");

    // ── 2. Forward rewrite (pure, contact callback stubbed) ─────────────
    const parsed = parseMessage(enc.encode(inbound));
    const rewritten = await rewriteForward(
      { headers: parsed.headers },
      {
        alias: { email: "asdf@user.com" },
        mailbox: { email: "wes@qmail.com" },
        envelopeFrom: "milton@initech.com",
        emailLogId: 42,
        getOrCreateContact: async (addr) => ({
          replyEmail: `${addr.address.replace("@", "_at_").replace(/\./g, "_")}_abc12@virtu.test`,
        }),
      },
    );

    // the inbound DKIM-Signature was dropped by the whitelist (it would no
    // longer validate after the rewrite; ARC carries the attestation instead)
    expect(rewritten.actions.droppedHeaders).toContain("DKIM-Signature");
    expect(rewritten.actions.droppedHeaders).toContain("X-Mailer");
    const from = parseAddressList(rewritten.headers.get("From")!)[0]!;
    expect(from.address).toBe("milton_at_initech_com_abc12@virtu.test");
    expect(from.name).toBe("Milton Waddams - milton at initech.com");
    // test-id passthrough for Lane H story tests
    expect(rewritten.headers.get("X-Virtu-Test-Id")).toBe("01J9TESTULID");

    // prepend mailauth's Received-SPF / Authentication-Results like the mx will
    const prep = parseMessage(enc.encode(verification.prependHeaders));
    rewritten.headers.fields.unshift(...prep.headers.fields);

    // ── 3. Sign as us + ARC-seal with the context captured pre-rewrite ──
    const sealed = await signOutbound(rewritten.headers, parsed.body, {
      dkimKeys: [
        {
          signingDomain: "virtu.test",
          selector: "vs1",
          privateKey: ourDkimKey.privateKeyPem,
        },
      ],
      arc: {
        signingDomain: "virtu.test",
        selector: "arc1",
        privateKey: ourArcKey.privateKeyPem,
        context: verification.arcContext!,
      },
    });

    expect(sealed.errors).toEqual([]);
    expect(sealed.sealed).toBe(true);
    expect(sealed.arcHeaders).toContain("cv=none");

    // envelope from is a VERP bounce address on our domain (SPF-aligned)
    const envelopeFrom = buildVerp({
      type: "bounce_forward",
      id: 42,
      secret: VERP_SECRET,
      domain: "virtu.test",
    });
    expect(envelopeFrom.endsWith("@virtu.test")).toBe(true);

    // ── 4. The receiving mailbox provider authenticates OUR message ────
    const outcome = await authenticate(Buffer.from(sealed.message), {
      resolver: makeStubResolver(mailboxProviderZones()) as never,
      disableBimi: true,
      mta: "mx.qmail.com",
      ip: OUR_IP,
      helo: "out.virtu.test",
      sender: envelopeFrom,
    });

    // our DKIM signature verifies
    const ourDkim = outcome.dkim.results?.find((r) => r.signingDomain === "virtu.test");
    expect(ourDkim?.status.result).toBe("pass");
    expect(ourDkim?.selector).toBe("vs1");

    // SPF passes for the VERP envelope on our domain
    expect(outcome.spf !== false && outcome.spf.status.result).toBe("pass");

    // the ARC chain validates: cv=none inbound → our sealed i=1 passes
    expect(outcome.arc !== false && outcome.arc.status.result).toBe("pass");
    expect(outcome.arc !== false && outcome.arc.i).toBe(1);

    // and DMARC for the rewritten From (reverse alias @virtu.test) passes,
    // so the forward is deliverable under our own p=reject policy
    expect(outcome.dmarc !== false && outcome.dmarc.status.result).toBe("pass");

    // sanity: the final message still carries the forwarded body untouched
    const final = dec.decode(serializeMessage(parseMessage(sealed.message).headers, parseMessage(sealed.message).body));
    expect(final).toContain("Please find the cover sheets attached.\r\n");
    expect(final).toContain("ARC-Authentication-Results: i=1; mx.virtu.test");
    // the real mailbox address never appears in the outbound message
    expect(final).not.toContain("wes@qmail.com");
  });

  test("tampered-in-transit forward fails downstream DKIM (control)", async () => {
    // control experiment: flip a byte of the body after sealing and make
    // sure the downstream verifier notices — proves step 4 above is real.
    const { headers, body } = parseMessage(
      enc.encode(
        "From: a@virtu.test\r\nTo: wes@qmail.com\r\nSubject: x\r\nDate: Fri, 07 Aug 2026 10:00:00 +0000\r\nMessage-ID: <m@virtu.test>\r\n\r\nhello\r\n",
      ),
    );
    const signed = await signOutbound(headers, body, {
      dkimKeys: [
        { signingDomain: "virtu.test", selector: "vs1", privateKey: ourDkimKey.privateKeyPem },
      ],
    });
    const tampered = dec.decode(signed.message).replace("hello", "jello");
    const outcome = await authenticate(tampered, {
      resolver: makeStubResolver(mailboxProviderZones()) as never,
      disableBimi: true,
      disableDmarc: true,
      mta: "mx.qmail.com",
      ip: OUR_IP,
      sender: "vt.x.y@virtu.test",
    });
    const ourDkim = outcome.dkim.results?.find((r) => r.signingDomain === "virtu.test");
    expect(ourDkim?.status.result).not.toBe("pass");
  });
});
