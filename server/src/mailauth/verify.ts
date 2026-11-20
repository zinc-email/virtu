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
import { arcFieldInstance } from "./arcInstance.ts";
import { authenticate } from "mailauth";
import type { AuthenticateResult } from "mailauth";
import { parseMessage, unfoldValue } from "../mail/headers.ts";
import { type Bulkhead, createBulkhead } from "../pipeline/verifyBulkhead.ts";

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
 * - DMARC p=reject + fail → annotate; local abuse evidence is required for rejection
 * - DMARC p=quarantine + fail → flag (deliver annotated, never bounce)
 * - SPF hard-fail with no DMARC record → flag (PLAN: over-rejection is how
 *   forwarders lose mail; set to "reject" to harden)
 */
export interface VerifyPolicy {
  onDmarcReject: "accept" | "flag";
  onDmarcQuarantine: "accept" | "flag";
  onSpfHardFailWithoutDmarc: PolicyAction;
  /**
   * A DKIM pass whose signature covered only a prefix of the body (`l=`):
   * whatever was appended after the covered bytes is unsigned, so a
   * forward re-signed and ARC-sealed by us would vouch for it. Flag.
   */
  onDkimBodyLengthLimited: PolicyAction;
}

/** Default policy (see {@link VerifyPolicy}). */
export const DEFAULT_VERIFY_POLICY: VerifyPolicy = {
  onDmarcReject: "flag",
  onDmarcQuarantine: "flag",
  onSpfHardFailWithoutDmarc: "flag",
  onDkimBodyLengthLimited: "flag",
};

/** Options for {@link verifyInbound}. */
export interface VerifyOptions {
  /** Injectable DNS resolver; defaults to node:dns `promises.resolve`. */
  resolver?: DnsResolver;
  /** Privileged local evidence, never inferred from sender-supplied headers or ARC pass alone. */
  acceptanceEvidence?: AcceptanceEvidence;
  flagDisposition?: "reject" | "forward";
  /** Policy overrides, merged over {@link DEFAULT_VERIFY_POLICY}. */
  policy?: Partial<VerifyPolicy>;
  /** Minimum accepted DKIM/ARC key length in bits (mailauth default: 1024). */
  minBitLength?: number;
  /**
   * Whole-call budget, ms (default {@link VERIFY_TIMEOUT_MS}). Every DKIM
   * signature and ARC set is a DNS lookup the sender chose the target of;
   * past the budget the verdict is a 451 tempfail, never a stalled session.
   */
  timeoutMs?: number;
  /** Concurrent verifications allowed process-wide; the default is shared. */
  bulkhead?: Bulkhead;
}

/** Maximum DKIM signatures evaluated; exceeding the budget yields incomplete/451. */
export const MAX_DKIM_SIGNATURES = 8;
/**
 * Distinct body-hash inputs — (body canonicalization, hash, `l=`) triples —
 * hashed per message. mailauth shares one body pass per triple, so eight
 * signatures that agree cost one pass, and eight that each carry a
 * different `l=` cost eight: a 20 MiB body is ~300 ms of the one event
 * loop per pass. Exceeding this budget yields incomplete/451.
 */
export const MAX_BODY_HASH_VARIANTS = 2;
/** ARC sets evaluated per message; exceeding this budget yields incomplete/451. */
export const MAX_ARC_SETS = 10;
export const VERIFY_TIMEOUT_MS = 20_000;
/** In-flight verifications process-wide before new ones tempfail. */
// Match the SMTP materialization budget: timed-out work retains its message until settled.
export const VERIFY_CONCURRENCY = 1;

const defaultBulkhead = createBulkhead(VERIFY_CONCURRENCY);

/** The tempfail verdict when authentication could not complete in time. */
export const VERIFY_UNAVAILABLE: Extract<Verdict, { action: "reject" }> = {
  action: "reject",
  code: 451,
  enhanced: "4.7.1",
  message: "Authentication temporarily unavailable, try again later",
  reason: "verify-unavailable",
};

/** The tag=value pairs of a DKIM-Signature field body, lower-cased keys. */
function parseSignatureTags(value: string): Map<string, string> {
  const tags = new Map<string, string>();
  for (const part of unfoldValue(value).split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    tags.set(part.slice(0, eq).trim().toLowerCase(), part.slice(eq + 1).trim());
  }
  return tags;
}

export type AcceptanceEvidence =
  | { kind: "trusted-indirect"; source: string }
  | { kind: "abuse"; reason: string };

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

/** Completed custody transitions; incomplete verification never supplies a seal context. */
export type ArcContext = { authResults: string } & (
  | { state: "no-chain"; cv: "none"; nextInstance: 1 }
  | { state: "valid"; cv: "pass"; nextInstance: number }
  | { state: "newly-failed"; cv: "fail"; nextInstance: number }
  | { state: "already-failed"; cv: "fail" }
);

/** Result of {@link verifyInbound}. */
export interface VerifyResult {
  completion: "complete" | "incomplete";
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
  return (
    res.dmarc === false || ["none", "permerror", "temperror"].includes(res.dmarc.status.result)
  );
}

/**
 * True when the message's DKIM standing rests only on `l=`-limited
 * signatures: at least one passing signature covered a body prefix, and no
 * passing signature covered the whole body. mailauth records the limit as
 * a warning (`canonBodyLengthLimited`) and still says pass.
 */
function dkimPassOnlyBodyLengthLimited(res: AuthenticateResult): boolean {
  const results = (res.dkim?.results ?? []) as {
    status?: { result?: string };
    canonBodyLengthLimited?: boolean;
  }[];
  const passing = results.filter((r) => r.status?.result === "pass");
  if (passing.length === 0) return false;
  return passing.every((r) => r.canonBodyLengthLimited === true);
}

/**
 * Authentication findings, evaluated together; independent rejection takes priority
 * over a DMARC annotation. Exported as data so wave 2 (and ops) can read the policy at
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
    when: (res) => res.spf !== false && res.spf.status.result === "fail" && noDmarcRecord(res),
    rejectCode: 550,
    rejectEnhanced: "5.7.23",
    rejectMessage: () => "SPF validation failed",
  },
  {
    reason: "dkim-body-length-limited",
    policyKey: "onDkimBodyLengthLimited",
    when: dkimPassOnlyBodyLengthLimited,
    rejectCode: 550,
    rejectEnhanced: "5.7.20",
    rejectMessage: () => "DKIM signature does not cover the whole message body",
  },
];

/** Map a mailauth result to a verdict using the table + policy. */
export function mapVerdict(
  res: AuthenticateResult,
  policy: VerifyPolicy,
  evidence?: AcceptanceEvidence,
  flagDisposition: "reject" | "forward" = "forward",
): Verdict {
  if (evidence?.kind === "abuse")
    return {
      action: "reject",
      code: 550,
      enhanced: "5.7.1",
      message: "Message rejected by local abuse policy",
      reason: evidence.reason,
    };
  let annotation: Extract<Verdict, { action: "flag" }> | undefined;
  for (const rule of VERDICT_RULES) {
    if (!rule.when(res)) continue;
    if (rule.reason.startsWith("dmarc-") && evidence?.kind === "trusted-indirect") continue;
    const action = policy[rule.policyKey];
    if (action === "accept") continue;
    // A domain assessment is evidence, not independent abuse evidence (RFC 9989 7.4).
    if (rule.reason.startsWith("dmarc-") || (action === "flag" && flagDisposition === "forward")) {
      annotation ??= { action: "flag", reason: rule.reason };
      continue;
    }
    return {
      action: "reject",
      code: rule.rejectCode,
      enhanced: rule.rejectEnhanced,
      message: rule.rejectMessage(res),
      reason: rule.reason,
    };
  }
  return annotation ?? { action: "accept" };
}

/** Default resolver: the container's configured DNS via node:dns. */
const defaultResolver: DnsResolver = (name, rrtype) => dnsPromises.resolve(name, rrtype as never);

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
  const bulkhead = opts.bulkhead ?? defaultBulkhead;
  if (!bulkhead.tryAcquire()) return unavailable("bulkhead");
  // Refused callers must not allocate any whole-message buffers.
  let bytes: Uint8Array;
  let input: Buffer;
  try {
    bytes = typeof rawMessage === "string" ? Buffer.from(rawMessage) : rawMessage;
    input = Buffer.from(bytes);
  } catch (error) {
    bulkhead.release();
    throw error;
  }
  // The budget cannot cancel mailauth; when it wins, the work runs on to
  // completion. The bulkhead slot is therefore held until the work truly
  // settles, so leaked verifications count against concurrency instead of
  // stacking up uncounted behind a 451.
  let dnsUnavailable = false;
  const resolver: DnsResolver = async (name, type) => {
    try {
      return await (opts.resolver ?? defaultResolver)(name, type);
    } catch (error) {
      if (!["ENOTFOUND", "ENODATA"].includes((error as { code?: string }).code ?? ""))
        dnsUnavailable = true;
      throw error;
    }
  };
  const work = authenticate(input, {
    ip: session.remoteAddress,
    helo: session.heloHostname,
    sender: session.envelopeFrom,
    mta: session.mta,
    resolver: resolver as never,
    minBitLength: Math.max(1024, opts.minBitLength ?? 1024),
    ...{
      verificationLimits: {
        dkimSignatures: MAX_DKIM_SIGNATURES,
        bodyHashVariants: MAX_BODY_HASH_VARIANTS,
        arcSets: MAX_ARC_SETS,
      },
    },
    disableBimi: true,
  });
  work.finally(() => bulkhead.release()).catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  let res: AuthenticateResult;
  try {
    const budget = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), opts.timeoutMs ?? VERIFY_TIMEOUT_MS);
    });
    const outcome = await Promise.race([work, budget]);
    if (outcome === null) return unavailable("timeout");
    res = outcome;
  } catch (error) {
    if ((error as { code?: string }).code === "EAUTHINCOMPLETE") return unavailable("budget");
    throw error;
  } finally {
    clearTimeout(timer);
  }

  // DNS/verification unavailability is not evidence that a chain or identity failed.
  if (
    dnsUnavailable ||
    (res.dmarc !== false && res.dmarc.status.result === "temperror") ||
    (res.spf !== false && res.spf.status.result === "temperror") ||
    res.dkim.results.some((r) => r.status.result === "temperror")
  )
    return unavailable("dns");
  const parsed = parseMessage(bytes);
  const arcFields = parsed.headers.fields.filter((f) =>
    ["arc-seal", "arc-message-signature", "arc-authentication-results"].includes(
      f.name.toLowerCase(),
    ),
  );
  let highest = 0;
  let alreadyFailed = false;
  let highestSeal = 0;
  for (const field of arcFields) {
    const tags = parseSignatureTags(field.rawValue);
    const instance = arcFieldInstance(field.rawValue);
    if (instance !== null) {
      highest = Math.max(highest, instance);
      if (field.name.toLowerCase() === "arc-seal" && instance >= highestSeal) {
        if (instance > highestSeal) alreadyFailed = false;
        highestSeal = instance;
        if (tags.get("cv")?.toLowerCase() === "fail") alreadyFailed = true;
      }
    }
  }
  const authResults = res.arc !== false ? res.arc.authResults : undefined;
  if (typeof authResults !== "string") return unavailable("arc");
  let arcContext: ArcContext;
  if (alreadyFailed) arcContext = { state: "already-failed", cv: "fail", authResults };
  else if (highest >= 50) return unavailable("arc-limit");
  else if (res.arc !== false && res.arc.status.result === "pass")
    arcContext = { state: "valid", cv: "pass", authResults, nextInstance: highest + 1 };
  else if (arcFields.length === 0)
    arcContext = { state: "no-chain", cv: "none", authResults, nextInstance: 1 };
  else arcContext = { state: "newly-failed", cv: "fail", authResults, nextInstance: highest + 1 };

  return {
    completion: "complete",
    verdict: mapVerdict(res, policy, opts.acceptanceEvidence, opts.flagDisposition),
    prependHeaders: res.headers,
    arcContext,
    raw: res,
  };
}

/** The 451 result: nothing to prepend, no ARC context, an empty raw. */
function unavailable(reason: string): VerifyResult {
  return {
    completion: "incomplete",
    verdict: { ...VERIFY_UNAVAILABLE, reason: `verify-${reason}` },
    prependHeaders: "",
    arcContext: null,
    raw: EMPTY_RESULT,
  };
}

const EMPTY_RESULT = {
  dkim: { results: [] },
  spf: false,
  dmarc: false,
  arc: false,
  headers: "",
} as unknown as AuthenticateResult; // a synthetic "nothing ran" result; mailauth has no constructor for it
