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
import { type HeaderField, parseMessage, serializeMessage, unfoldValue } from "../mail/headers.ts";
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
 * - DMARC p=reject + fail → reject (550 5.7.1)
 * - DMARC p=quarantine + fail → flag (deliver annotated, never bounce)
 * - SPF hard-fail with no DMARC record → flag (PLAN: over-rejection is how
 *   forwarders lose mail; set to "reject" to harden)
 */
export interface VerifyPolicy {
  onDmarcReject: PolicyAction;
  onDmarcQuarantine: PolicyAction;
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
  onDmarcReject: "reject",
  onDmarcQuarantine: "flag",
  onSpfHardFailWithoutDmarc: "flag",
  onDkimBodyLengthLimited: "flag",
};

/** Options for {@link verifyInbound}. */
export interface VerifyOptions {
  /** Injectable DNS resolver; defaults to node:dns `promises.resolve`. */
  resolver?: DnsResolver;
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

/** Signatures evaluated per message; the rest are dropped before verifying. */
export const MAX_DKIM_SIGNATURES = 8;
/**
 * Distinct body-hash inputs — (body canonicalization, hash, `l=`) triples —
 * hashed per message. mailauth shares one body pass per triple, so eight
 * signatures that agree cost one pass, and eight that each carry a
 * different `l=` cost eight: a 20 MiB body is ~300 ms of the one event
 * loop per pass. Signatures past the second variant are dropped.
 */
export const MAX_BODY_HASH_VARIANTS = 2;
/** ARC sets evaluated per message; more than this and the chain is ignored. */
export const MAX_ARC_SETS = 10;
export const VERIFY_TIMEOUT_MS = 20_000;
/** In-flight verifications process-wide before new ones tempfail. */
export const VERIFY_CONCURRENCY = 16;

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

/**
 * Whether one DKIM-Signature is worth verifying at all. Two of these are
 * rules mailauth does not enforce and our policy assumes it does:
 *
 * - RFC 6376 §5.4: `From` MUST be signed. A signature whose `h=` omits it
 *   verified as `pass` in mailauth, and DMARC aligned that pass with the
 *   From domain — so anyone holding such a message could rewrite From and
 *   keep DKIM+DMARC pass.
 * - RFC 8301: `rsa-sha1` MUST NOT be accepted (mailauth verifies it).
 *
 * The third is cost: each distinct (body canonicalization, hash, `l=`)
 * triple is a full pass over the body, see {@link MAX_BODY_HASH_VARIANTS}.
 */
function keepSignature(tags: Map<string, string>, variants: Set<string>): boolean {
  const algorithm = (tags.get("a") ?? "").toLowerCase();
  if (algorithm.endsWith("-sha1")) return false;
  const signed = (tags.get("h") ?? "").toLowerCase().split(":");
  if (!signed.some((name) => name.trim() === "from")) return false;
  const canon = (tags.get("c") ?? "simple/simple").toLowerCase();
  const bodyCanon = canon.split("/")[1] ?? "simple";
  const hash = algorithm.split("-")[1] ?? "";
  const variant = `${bodyCanon}:${hash}:${tags.get("l") ?? ""}`;
  if (!variants.has(variant)) {
    if (variants.size >= MAX_BODY_HASH_VARIANTS) return false;
    variants.add(variant);
  }
  return true;
}

/**
 * Bound the sender-controlled work before mailauth sees the message:
 * keep the first {@link MAX_DKIM_SIGNATURES} DKIM-Signature fields that
 * pass {@link keepSignature} (top-most first, as viadkim does), and, past
 * {@link MAX_ARC_SETS} ARC-Seal fields, drop every ARC header (a chain that
 * long is not one we can vouch for anyway — cv=none is the honest answer).
 * Only the verification input is trimmed; the forwarded copy is rebuilt
 * from the whitelist and never carries these headers.
 */
export function boundSignatureHeaders(raw: Uint8Array): Uint8Array {
  const parsed = parseMessage(raw);
  const fields = parsed.headers.fields;
  const variants = new Set<string>();
  let kept = 0;
  let arcSeals = 0;
  const keep = new Map<HeaderField, boolean>();
  for (const f of fields) {
    const name = f.name.toLowerCase();
    if (name === "dkim-signature") {
      const ok =
        keepSignature(parseSignatureTags(f.rawValue), variants) && ++kept <= MAX_DKIM_SIGNATURES;
      keep.set(f, ok);
    } else if (name === "arc-seal") arcSeals++;
  }
  const dropArc = arcSeals > MAX_ARC_SETS;
  const dropping = dropArc || [...keep.values()].some((ok) => !ok);
  if (!dropping) return raw;
  parsed.headers.retain((f) => {
    const decided = keep.get(f);
    if (decided !== undefined) return decided;
    return !(dropArc && f.name.toLowerCase().startsWith("arc-"));
  });
  return serializeMessage(parsed.headers, parsed.body);
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
  const bytes = typeof rawMessage === "string" ? Buffer.from(rawMessage) : rawMessage;
  const input = Buffer.from(boundSignatureHeaders(bytes));

  const bulkhead = opts.bulkhead ?? defaultBulkhead;
  if (!bulkhead.tryAcquire()) return unavailable("bulkhead");
  // The budget cannot cancel mailauth; when it wins, the work runs on to
  // completion. The bulkhead slot is therefore held until the work truly
  // settles, so leaked verifications count against concurrency instead of
  // stacking up uncounted behind a 451.
  const work = authenticate(input, {
    ip: session.remoteAddress,
    helo: session.heloHostname,
    sender: session.envelopeFrom,
    mta: session.mta,
    resolver: (opts.resolver ?? defaultResolver) as never,
    minBitLength: opts.minBitLength,
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
  } finally {
    clearTimeout(timer);
  }

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

/** The 451 result: nothing to prepend, no ARC context, an empty raw. */
function unavailable(reason: "timeout" | "bulkhead"): VerifyResult {
  return {
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
