import { createPrivateKey } from "node:crypto";
import { createLogger } from "../log.ts";
import { signingFailuresTotal } from "../metrics/index.ts";
/**
 * Required outbound DKIM signatures use one fixed header policy. ARC sealing
 * follows all message modifications, including DKIM, using the inbound
 * validation context. No signing failure weakens the policy or sends unsigned.
 */

import { dkimSign, sealMessage } from "mailauth";
import { type HeaderBlock, parseAddressList, serializeMessage } from "../mail/headers.ts";
import { assertLineLengths } from "../mail/lineLength.ts";
import { arcFieldInstance } from "./arcInstance.ts";
import type { ArcContext } from "./verify.ts";

/** One DKIM signing key. */
export interface DkimKeyConfig {
  /** d= tag: the signing domain. */
  signingDomain: string;
  /** s= tag: the selector. */
  selector: string;
  /** PEM private key (RSA or Ed25519). */
  privateKey: string;
  /** Default "rsa-sha256"; "ed25519-sha256" for Ed25519 keys. */
  algorithm?: "rsa-sha256" | "ed25519-sha256";
  /** Default "relaxed/relaxed". */
  canonicalization?: string;
}

/** ARC sealing configuration: our seal key + the pre-rewrite context. */
export interface ArcSealConfig {
  /** d= tag for the seal. */
  signingDomain: string;
  /** s= tag for the seal. */
  selector: string;
  /** PEM private key for the seal (RSA — RFC 8617 seals are rsa-sha256). */
  privateKey: string;
  /** Context captured by `verifyInbound` on the ORIGINAL message. */
  context: ArcContext;
}

/** RFC 6376 §5.4/5.4.1: authenticate the author and core displayed/MIME fields. */
export const DKIM_SIGNED_HEADERS: readonly string[] = [
  "From",
  "Sender",
  "Reply-To",
  "To",
  "Cc",
  "Subject",
  "Date",
  "Message-ID",
  "In-Reply-To",
  "References",
  "MIME-Version",
  "Content-Type",
  "Content-Transfer-Encoding",
  "Content-Disposition",
  "Content-ID",
  "Content-Description",
  "Resent-Date",
  "Resent-From",
  "Resent-To",
  "Resent-Cc",
  "Resent-Message-ID",
  "List-Id",
  "List-Help",
  "List-Unsubscribe",
  "List-Unsubscribe-Post",
  "List-Subscribe",
  "List-Post",
  "List-Owner",
  "List-Archive",
];

/** Options for {@link signOutbound}. */
export interface SignOutboundOptions {
  /** Keys to sign with (one DKIM-Signature per key). */
  dkimKeys: DkimKeyConfig[];
  /** Optional ARC seal (forwarded mail). Omit for replies/fresh mail. */
  arc?: ArcSealConfig;
  /** Signing timestamp override for tests. */
  signTime?: Date;
}

/** Result of {@link signOutbound}. */
export interface SignOutboundResult {
  /**
   * The final message bytes: ARC set (when sealed) + DKIM-Signature header(s)
   * + the rewritten headers + body. This is what goes into the queue.
   */
  message: Uint8Array;
  /** The DKIM-Signature header text (CRLF-terminated lines; "" when all keys failed). */
  dkimHeaders: string;
  /** The ARC-Seal/ARC-Message-Signature/ARC-Authentication-Results text ("" when not sealed). */
  arcHeaders: string;
  /** True when an ARC seal was added. */
  sealed: boolean;
}

/** Shape of mailauth's per-signature error entries (untyped upstream). */
interface MailauthSignError {
  selector?: string;
  signingDomain?: string;
  err: Error;
}

/**
 * How long our DKIM signatures stay valid (`x=`). A signature without an
 * expiry vouches for a captured message forever; RFC 6376 §3.5 recommends
 * setting one. Seven days covers the RFC 5321 retry window (Postfix and
 * viadkim use five) with room for a slow receiver.
 */
export const DKIM_SIGNATURE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

/** RFC 8301/8463: reject historic hashes, undersized RSA and mismatched keys. */
function assertSigningKey(key: DkimKeyConfig): void {
  const algorithm = key.algorithm ?? "rsa-sha256";
  if (algorithm !== "rsa-sha256" && algorithm !== "ed25519-sha256") {
    throw new Error("Required DKIM key uses an unsupported signing algorithm");
  }
  const privateKey = createPrivateKey(key.privateKey);
  const type = algorithm === "rsa-sha256" ? "rsa" : "ed25519";
  if (privateKey.asymmetricKeyType !== type) throw new Error("Required signing key type mismatch");
  if (type === "rsa" && (privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 1024) {
    throw new Error("Required RSA signing key must be at least 1024 bits");
  }
}

/** The transport may dot-stuff, but must not normalize signed message bytes. */
function assertDataReady(message: Uint8Array): void {
  if (
    message.length < 2 ||
    message[message.length - 2] !== 13 ||
    message[message.length - 1] !== 10
  ) {
    throw new Error("Signing requires a CRLF-terminated message");
  }
  for (let i = 0; i < message.length; i++) {
    if (message[i] === 10 && message[i - 1] !== 13) {
      throw new Error("Signing requires CRLF line endings");
    }
  }
}

/** Exactly one signing pass; no reduced-header retries. */
async function signPass(
  message: Buffer,
  keys: DkimKeyConfig[],
  signTime: Date | undefined,
): Promise<{ signatures: string; errors: MailauthSignError[] }> {
  // Two places mailauth's published option type and its signer disagree
  // (lib/dkim/dkim-signer.js, lib/tools.js getSigningHeaderLines): the
  // signer reads `expires`, which the type omits, and honours `headerList`
  // only as a colon-separated string, where the type says string[] (an
  // array is silently ignored and the default set signed instead). Spread
  // both from a plain record so no literal is asserted over.
  const untyped: Record<string, Date | string> = {
    expires: new Date((signTime ?? new Date()).getTime() + DKIM_SIGNATURE_LIFETIME_MS),
    headerList: DKIM_SIGNED_HEADERS.join(":"),
  };
  const res = await dkimSign(message, {
    // DkimSigner reads signatureData only; the top-level key fields are
    // present to satisfy the declared option type and are ignored upstream.
    signingDomain: keys[0]!.signingDomain,
    selector: keys[0]!.selector,
    privateKey: keys[0]!.privateKey,
    signatureData: keys.map((k) => ({
      signingDomain: k.signingDomain,
      selector: k.selector,
      privateKey: k.privateKey,
      algorithm: k.algorithm,
      canonicalization: k.canonicalization ?? "relaxed/relaxed",
    })) as never,
    signTime,
    ...untyped,
  });
  return {
    signatures: res.signatures.trim() === "" ? "" : res.signatures,
    errors: (res.errors ?? []) as unknown as MailauthSignError[],
  };
}

/**
 * Require one generated author and an exact-domain DKIM key. This is our
 * outgoing identity policy (stricter than relaxed DMARC alignment), not a
 * replacement for complete inbound RFC 5322 mailbox syntax validation.
 */
function assertSigningIdentity(headers: HeaderBlock, keys: DkimKeyConfig[]): void {
  const fromFields = headers.getFields("From");
  const authors = fromFields.length === 1 ? parseAddressList(headers.get("From") ?? "") : [];
  if (authors.length !== 1) throw new Error("Signing requires exactly one From author");
  const address = authors[0]!.address;
  const at = address.lastIndexOf("@");
  const domain = address.slice(at + 1);
  if (at <= 0 || domain === "" || /[\s<>@]/.test(domain)) {
    throw new Error("Signing requires a From author domain");
  }
  if (!keys.some((key) => key.signingDomain.toLowerCase() === domain.toLowerCase())) {
    throw new Error("Required DKIM key must match the From author domain");
  }
}

async function signRequired(
  headers: HeaderBlock,
  body: Uint8Array,
  opts: SignOutboundOptions,
): Promise<SignOutboundResult> {
  if (opts.dkimKeys.length === 0) {
    throw new Error("signOutbound requires at least one DKIM key");
  }
  const base = Buffer.from(serializeMessage(headers, body));
  assertLineLengths(base);
  assertDataReady(base);

  assertSigningIdentity(headers, opts.dkimKeys);
  try {
    for (const key of opts.dkimKeys) assertSigningKey(key);
  } catch (error) {
    throw new AggregateError([error], "Required DKIM signing failed");
  }
  const { signatures: dkimHeaders, errors } = await signPass(base, opts.dkimKeys, opts.signTime);
  const signatureCount = dkimHeaders.match(/^DKIM-Signature:/gim)?.length ?? 0;
  if (errors.length > 0 || signatureCount !== opts.dkimKeys.length) {
    throw new AggregateError(
      errors.map((error) => error.err),
      "Required DKIM signing failed",
    );
  }

  const dkimSigned = dkimHeaders === "" ? base : Buffer.concat([Buffer.from(dkimHeaders), base]);

  // RFC 8617 §5.1: a newly detected failure gets its own cv=fail set;
  // an incoming chain whose newest seal already says fail is not extended.
  let arcHeaders = "";
  const arc = opts.arc;
  if (arc !== undefined && arc.context.state !== "already-failed") {
    const context = arc.context;
    const incoming = headers.fields.filter((field) =>
      ["arc-seal", "arc-message-signature", "arc-authentication-results"].includes(
        field.name.toLowerCase(),
      ),
    );
    if (context.state === "no-chain" && incoming.length !== 0) {
      throw new Error("Cannot start ARC chain over existing ARC fields");
    }
    if (context.state !== "no-chain" && incoming.length === 0) {
      throw new Error("Incoming ARC fields missing from rewritten message");
    }
    const instances = incoming.flatMap((field) => {
      const instance = arcFieldInstance(field.rawValue);
      return instance === null ? [] : [instance];
    });
    const expectedInstance = Math.max(0, ...instances) + 1;
    if (
      !Number.isSafeInteger(context.nextInstance) ||
      context.nextInstance < 1 ||
      context.nextInstance > 50 ||
      context.nextInstance !== expectedInstance
    ) {
      throw new Error("Invalid ARC sealing instance for incoming chain");
    }
    assertSigningKey({
      signingDomain: arc.signingDomain,
      selector: arc.selector,
      privateKey: arc.privateKey,
      algorithm: "rsa-sha256",
    });
    const sealBuffer = await sealMessage(dkimSigned, {
      signingDomain: arc.signingDomain,
      selector: arc.selector,
      privateKey: arc.privateKey,
      authResults: context.authResults,
      cv: context.cv,
      i: context.nextInstance,
      signTime: opts.signTime,
    } as never);
    arcHeaders = sealBuffer.toString("utf-8");
    // mailauth can report signer failures by omitting individual fields.
    // Require a complete set before returning any message bytes.
    for (const field of ["ARC-Seal", "ARC-Message-Signature", "ARC-Authentication-Results"]) {
      const count = arcHeaders.match(new RegExp(`^${field}:`, "gim"))?.length ?? 0;
      if (count !== 1) throw new Error("Required ARC sealing failed");
    }
  }

  const message =
    arcHeaders === ""
      ? new Uint8Array(dkimSigned)
      : new Uint8Array(Buffer.concat([Buffer.from(arcHeaders), dkimSigned]));

  assertLineLengths(message);
  assertDataReady(message);
  return {
    message,
    dkimHeaders,
    arcHeaders,
    sealed: arcHeaders !== "",
  };
}

/** Operator-visible failure signal; alert on virtu_signing_failures_total. */
export function reportSigningFailure(error: unknown): void {
  signingFailuresTotal.inc();
  createLogger("mailauth").error("required_signing_failed", {
    error: error instanceof Error ? error.message : String(error),
    consequence: "message not accepted or queued",
  });
}

export async function signOutbound(
  headers: HeaderBlock,
  body: Uint8Array,
  opts: SignOutboundOptions,
): Promise<SignOutboundResult> {
  try {
    return await signRequired(headers, body, opts);
  } catch (error) {
    reportSigningFailure(error);
    throw error;
  }
}
