/**
 * Lane B: inbound email authentication via mailauth.
 *
 * One `authenticate()` call covers SPF + DKIM + DMARC + ARC and returns
 * ready-to-prepend `Received-SPF` / `Authentication-Results` headers plus the
 * ARC context in exactly the shape Lane C's sealer consumes. This module
 * wraps that call and maps the results to a pre-queue verdict via a small
 * table-driven policy (cribbed from SimpleLogin `app/handler/dmarc.py`,
 * enforcement kept conservative and configurable — over-rejection is how
 * forwarders lose mail).
 *
 * The DNS resolver is injectable (tests run with zero network); the default
 * is node:dns promises `resolve`, i.e. the container's configured
 * nameserver, so the simulated-internet BIND answers lookups unchanged.
 */

import { promises as dnsPromises } from "node:dns";
import { authenticate } from "mailauth";
import type { AuthenticateResult } from "mailauth";

/**
 * DNS resolver in mailauth's shape: `dns.promises.resolve` compatible —
 * `resolver("initech.com", "TXT")` → `string[][]`, `("host", "A")` →
 * `string[]`, `("dom", "MX")` → `{ exchange, priority }[]`, etc.
 */
export type DnsResolver = (name: string, rrtype: string) => Promise<unknown>;

/** SMTP session facts the verifier needs (subset of the Lane A session). */
export interface InboundSession {
  /** Client IP address (SPF). */
  remoteAddress: string;
  /** Hostname from EHLO/HELO. */
  heloHostname?: string;
  /** SMTP MAIL FROM (may be empty for bounces). */
  envelopeFrom: string;
  /** Our MX hostname, stamped into Authentication-Results (defaults to os.hostname()). */
  mta?: string;
}

/** What to do for a matched policy rule. */
export type PolicyAction = "accept" | "flag" | "reject";

/**
 * Configurable verdict policy. Defaults are conservative:
 * - DMARC p=reject + fail → reject (550 5.7.1)
 * - DMARC p=quarantine + fail → flag (deliver annotated, never bounce)
 * - SPF hard-fail with no DMARC record → flag (PLAN: over-rejection is how
 *   forwarders lose mail; set to "reject" to harden)
 */
export interface VerifyPolicy {
  onDmarcReject: PolicyAction;
  onDmarcQuarantine: PolicyAction;
  onSpfHardFailWithoutDmarc: PolicyAction;
}

/** Default policy (see {@link VerifyPolicy}). */
export const DEFAULT_VERIFY_POLICY: VerifyPolicy = {
  onDmarcReject: "reject",
  onDmarcQuarantine: "flag",
  onSpfHardFailWithoutDmarc: "flag",
};

/** Options for {@link verifyInbound}. */
export interface VerifyOptions {
  /** Injectable DNS resolver; defaults to node:dns `promises.resolve`. */
  resolver?: DnsResolver;
  /** Policy overrides, merged over {@link DEFAULT_VERIFY_POLICY}. */
  policy?: Partial<VerifyPolicy>;
  /** Minimum accepted DKIM/ARC key length in bits (mailauth default: 1024). */
  minBitLength?: number;
}

/** The pre-queue verdict for an inbound message. */
export type Verdict =
  | { action: "accept" }
  | { action: "flag"; reason: string }
  | {
      action: "reject";
      /** SMTP reply code, e.g. 550. */
      code: number;
      /** Enhanced status code, e.g. "5.7.1". */
      enhanced: string;
      /** Human-readable SMTP reply text. */
      message: string;
      reason: string;
    };

/** ARC context captured pre-rewrite, in the exact shape the sealer consumes. */
export interface ArcContext {
  /** `res.arc.authResults` — the Authentication-Results content for the AAR header. */
  authResults: string;
  /** `res.arc.status.result` — chain validation state to stamp as cv= on the new seal. */
  cv: "none" | "pass" | "fail";
}

/** Result of {@link verifyInbound}. */
export interface VerifyResult {
  verdict: Verdict;
  /**
   * Ready-to-prepend header text from mailauth (`Received-SPF` +
   * `Authentication-Results`, CRLF line endings, trailing CRLF). Parse with
   * Lane C's `parseMessage` and unshift the fields onto the message block.
   */
  prependHeaders: string;
  /** ARC context for `signOutbound`'s sealer; null when ARC was unavailable. */
  arcContext: ArcContext | null;
  /** The full mailauth result, for logging/metrics. */
  raw: AuthenticateResult;
}

/**
 * One row of the verdict table: `when` inspects the mailauth result; the
 * action taken comes from the policy key; reject rows carry their SMTP shape.
 */
interface VerdictRule {
  reason: string;
  policyKey: keyof VerifyPolicy;
  when(res: AuthenticateResult): boolean;
  rejectCode: number;
  rejectEnhanced: string;
  rejectMessage(res: AuthenticateResult): string;
}

/** True when DMARC evaluated and failed. */
function dmarcFailed(res: AuthenticateResult): boolean {
  return res.dmarc !== false && res.dmarc.status.result === "fail";
}

/** The effective DMARC policy for the message ('none'|'quarantine'|'reject'). */
function dmarcPolicy(res: AuthenticateResult): string {
  if (res.dmarc === false) return "none";
  return res.dmarc.policy || res.dmarc.p || "none";
}

/** True when the From domain publishes no usable DMARC record. */
function noDmarcRecord(res: AuthenticateResult): boolean {
  return res.dmarc === false || ["none", "permerror", "temperror"].includes(res.dmarc.status.result);
}

/**
 * The verdict table, evaluated top to bottom; first match wins, no match
 * means accept. Exported as data so wave 2 (and ops) can read the policy at
 * a glance.
 */
export const VERDICT_RULES: readonly VerdictRule[] = [
  {
    reason: "dmarc-reject",
    policyKey: "onDmarcReject",
    when: (res) => dmarcFailed(res) && dmarcPolicy(res) === "reject",
    rejectCode: 550,
    rejectEnhanced: "5.7.1",
    rejectMessage: (res) =>
      `Email rejected per DMARC policy of ${res.dmarc === false ? "sender domain" : res.dmarc.domain}`,
  },
  {
    reason: "dmarc-quarantine",
    policyKey: "onDmarcQuarantine",
    when: (res) => dmarcFailed(res) && dmarcPolicy(res) === "quarantine",
    rejectCode: 550,
    rejectEnhanced: "5.7.1",
    rejectMessage: (res) =>
      `Email rejected per DMARC policy of ${res.dmarc === false ? "sender domain" : res.dmarc.domain}`,
  },
  {
    reason: "spf-hardfail",
    policyKey: "onSpfHardFailWithoutDmarc",
    when: (res) =>
      res.spf !== false && res.spf.status.result === "fail" && noDmarcRecord(res),
    rejectCode: 550,
    rejectEnhanced: "5.7.23",
    rejectMessage: () => "SPF validation failed",
  },
];

/** Map a mailauth result to a verdict using the table + policy. */
export function mapVerdict(res: AuthenticateResult, policy: VerifyPolicy): Verdict {
  for (const rule of VERDICT_RULES) {
    if (!rule.when(res)) continue;
    const action = policy[rule.policyKey];
    if (action === "accept") return { action: "accept" };
    if (action === "flag") return { action: "flag", reason: rule.reason };
    return {
      action: "reject",
      code: rule.rejectCode,
      enhanced: rule.rejectEnhanced,
      message: rule.rejectMessage(res),
      reason: rule.reason,
    };
  }
  return { action: "accept" };
}

/** Default resolver: the container's configured DNS via node:dns. */
const defaultResolver: DnsResolver = (name, rrtype) =>
  dnsPromises.resolve(name, rrtype as never);

/**
 * Verify an inbound message: SPF + DKIM + DMARC + ARC in one in-process
 * `authenticate()` call, mapped to a pre-queue verdict. Zero network when a
 * resolver is injected. Never throws on authentication failures — those are
 * verdicts; only infrastructure errors (e.g. resolver crash) propagate.
 */
export async function verifyInbound(
  session: InboundSession,
  rawMessage: Uint8Array | string,
  opts: VerifyOptions = {},
): Promise<VerifyResult> {
  const policy: VerifyPolicy = { ...DEFAULT_VERIFY_POLICY, ...opts.policy };
  const input = typeof rawMessage === "string" ? rawMessage : Buffer.from(rawMessage);

  const res = await authenticate(input, {
    ip: session.remoteAddress,
    helo: session.heloHostname,
    sender: session.envelopeFrom,
    mta: session.mta,
    resolver: (opts.resolver ?? defaultResolver) as never,
    minBitLength: opts.minBitLength,
    disableBimi: true,
  });

  const arcContext: ArcContext | null =
    res.arc !== false && typeof res.arc.authResults === "string"
      ? {
          authResults: res.arc.authResults,
          cv: res.arc.status.result as ArcContext["cv"],
        }
      : null;

  return {
    verdict: mapVerdict(res, policy),
    prependHeaders: res.headers,
    arcContext,
    raw: res,
  };
}
