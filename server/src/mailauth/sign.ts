/**
 * Outbound signing: DKIM (our domain for forwards, alias domain for replies —
 * key selection is the caller's concern, this takes explicit keys) plus an
 * optional ARC seal using the context captured by `verifyInbound` BEFORE the
 * rewrite. Per-forward flow is exactly what mailauth documents for
 * forwarders: `authenticate(original)` → capture `arc.authResults` +
 * `arc.status.result` → rewrite headers → `dkimSign()` + `sealMessage()`.
 *
 * Error handling / fallback chain: mailauth's `dkimSign` does NOT throw per
 * signature — it collects `{ selector, signingDomain, err }` entries in
 * `result.errors` and simply omits the failed signature (this is the per-
 * signature granularity SimpleLogin lacked with dkimpy's DKIMException). We
 * replicate SimpleLogin's header-set fallback chain on top of that: any key
 * that errors with mailauth's default header set is retried with
 * progressively smaller `headerList`s ([Message-ID,Date,Subject,From,To] →
 * [From,To] → [Message-ID,Date] → [From]) before being reported as failed.
 */

import { dkimSign, sealMessage } from "mailauth";
import { type HeaderBlock, serializeMessage } from "../mail/headers.ts";
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

/**
 * SimpleLogin's DKIM header-set fallback chain (app/email/headers.py
 * DKIM_HEADERS), tried in order for any key that fails to sign with
 * mailauth's default header set.
 */
export const DKIM_HEADER_FALLBACK_CHAINS: readonly (readonly string[])[] = [
  ["Message-ID", "Date", "Subject", "From", "To"],
  ["From", "To"],
  ["Message-ID", "Date"],
  ["From"],
];

/** A signing failure that survived every fallback attempt. */
export interface SignError {
  selector?: string;
  signingDomain?: string;
  /** The underlying error from mailauth/node:crypto. */
  err: Error;
}

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
  /** Keys that failed to produce a signature after every fallback. */
  errors: SignError[];
}

/** Shape of mailauth's per-signature error entries (untyped upstream). */
interface MailauthSignError {
  selector?: string;
  signingDomain?: string;
  err: Error;
}

/** Run one dkimSign pass over `message` for `keys` with an optional headerList. */
async function signPass(
  message: Buffer,
  keys: DkimKeyConfig[],
  headerList: readonly string[] | undefined,
  signTime: Date | undefined,
): Promise<{ signatures: string; errors: MailauthSignError[] }> {
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
    headerList: headerList === undefined ? undefined : [...headerList],
    signTime,
  });
  return {
    signatures: res.signatures.trim() === "" ? "" : res.signatures,
    errors: (res.errors ?? []) as unknown as MailauthSignError[],
  };
}

/**
 * Sign a rewritten message: serialize headers+body, add one DKIM-Signature
 * per key (with the SimpleLogin fallback chain on per-key failures), then
 * optionally ARC-seal the DKIM-signed message with the pre-rewrite context.
 *
 * Per RFC 8617 a sealer must not extend a chain that failed validation, so
 * when `arc.context.cv === "fail"` the seal is skipped (`sealed: false`)
 * rather than producing an invalid chain.
 */
export async function signOutbound(
  headers: HeaderBlock,
  body: Uint8Array,
  opts: SignOutboundOptions,
): Promise<SignOutboundResult> {
  if (opts.dkimKeys.length === 0) {
    throw new Error("signOutbound requires at least one DKIM key");
  }
  const base = Buffer.from(serializeMessage(headers, body));

  // DKIM: mailauth's default (full) header set first, then the SimpleLogin
  // fallback chains for any key that failed the previous attempt.
  const attempts: (readonly string[] | undefined)[] = [
    undefined,
    ...DKIM_HEADER_FALLBACK_CHAINS,
  ];
  let dkimHeaders = "";
  const finalErrors: SignError[] = [];
  let remaining = [...opts.dkimKeys];

  for (let i = 0; i < attempts.length && remaining.length > 0; i++) {
    const isLastAttempt = i === attempts.length - 1;
    const { signatures, errors } = await signPass(base, remaining, attempts[i], opts.signTime);
    if (signatures !== "") dkimHeaders += signatures;

    const failed: DkimKeyConfig[] = [];
    for (const e of errors) {
      const key = remaining.find(
        (k) => k.selector === e.selector && k.signingDomain === e.signingDomain,
      );
      if (key !== undefined && !isLastAttempt) {
        failed.push(key);
      } else {
        // last attempt, or an error we cannot map to a key: report it
        finalErrors.push({ selector: e.selector, signingDomain: e.signingDomain, err: e.err });
      }
    }
    remaining = failed;
  }

  const dkimSigned =
    dkimHeaders === "" ? base : Buffer.concat([Buffer.from(dkimHeaders), base]);

  // ARC seal (over the DKIM-signed message so the AMS covers the final state).
  let arcHeaders = "";
  if (opts.arc !== undefined && opts.arc.context.cv !== "fail") {
    const sealBuffer = await sealMessage(dkimSigned, {
      signingDomain: opts.arc.signingDomain,
      selector: opts.arc.selector,
      privateKey: opts.arc.privateKey,
      authResults: opts.arc.context.authResults,
      cv: opts.arc.context.cv,
      signTime: opts.signTime,
    } as never);
    arcHeaders = sealBuffer.toString("utf-8");
  }

  const message =
    arcHeaders === ""
      ? new Uint8Array(dkimSigned)
      : new Uint8Array(Buffer.concat([Buffer.from(arcHeaders), dkimSigned]));

  return {
    message,
    dkimHeaders,
    arcHeaders,
    sealed: arcHeaders !== "",
    errors: finalErrors,
  };
}
