/**
 * Custom-domain DNS verification (SimpleLogin's CustomDomainValidation,
 * app/custom_domain_validation.py, adapted to our per-domain DKIM keys).
 *
 * Check semantics (each mirrors its SL counterpart, deviations flagged):
 *
 *   ownership  TXT at the apex contains `vt-verification={token}`
 *              (SL uses the `sl-verification=` prefix — ours is `vt-`).
 *   mx         The MX rrset is exactly our exchanges in priority ORDER;
 *              priority NUMBERS are irrelevant (SL is_mx_equivalent).
 *   spf        Some `v=spf1` TXT record includes one of our SPF domains.
 *   dkim       TXT at {selector}._domainkey.{domain} carries our p= value.
 *              DEVIATION: SL points a CNAME at its own dkim record because
 *              it signs custom-domain mail with its service key; we generate
 *              a key PER DOMAIN, so the domain publishes the key itself.
 *   dmarc      TXT at _dmarc.{domain} equals the recommended record.
 *
 * All checks are pure over injected resolvers (unit-testable without a
 * network); TXT goes through pipeline/dnsTxt.ts — Bun's node:dns flattens
 * multi-string TXT records, which would corrupt every RSA-2048 DKIM key.
 * Lookup failures (NXDOMAIN, timeouts, SERVFAIL) fail the check with the
 * error recorded — a verify endpoint must never 500 on someone's DNS.
 */

import { randomBytes } from "node:crypto";
import { promises as dnsPromises } from "node:dns";
import { eq } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { isUniqueViolation } from "../db/pgError.ts";
import { type Domain, domains } from "../db/schema.ts";
import { CUSTOM_DOMAIN_DKIM_SELECTOR, loadDkimKeyRow } from "./dkim.ts";
import { resolveTxt } from "./dnsTxt.ts";

/** The recommended DMARC record (SimpleLogin app/constants.py DMARC_RECORD). */
export const DMARC_RECORD = "v=DMARC1; p=quarantine; pct=100; adkim=s; aspf=s";

/** Ownership TXT prefix. SL uses `sl-verification=`; ours is `vt-`. */
export const OWNERSHIP_PREFIX = "vt-verification";

/** One MX target as resolved. */
export interface MxRecord {
  exchange: string;
  priority: number;
}

/** Injectable resolvers — tests stub these; prod uses {@link defaultResolvers}. */
export interface DnsCheckResolvers {
  /** Grouped TXT records: one string[] of character-strings per record. */
  resolveTxt(name: string): Promise<string[][]>;
  resolveMx(name: string): Promise<MxRecord[]>;
}

/** System-DNS resolvers: wire-format TXT client + node:dns MX. */
export function defaultResolvers(): DnsCheckResolvers {
  return {
    resolveTxt: (name) => resolveTxt(name),
    resolveMx: (name) => dnsPromises.resolveMx(name),
  };
}

/** Result of one record check. `errors` holds what WAS found (SL shape). */
export interface CheckResult {
  ok: boolean;
  errors: string[];
}

/** Fetch TXT records as whole strings (character-strings joined per record). */
async function fetchTxt(
  name: string,
  r: DnsCheckResolvers,
): Promise<{ records: string[]; error: string | null }> {
  try {
    const grouped = await r.resolveTxt(name);
    return { records: grouped.map((chunks) => chunks.join("")), error: null };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOTFOUND" || code === "ENODATA") return { records: [], error: null };
    return { records: [], error: `TXT lookup failed for ${name}: ${(err as Error).message}` };
  }
}

/** Normalize a hostname for comparison: lowercase, no trailing dot. */
function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

/** Ownership: some apex TXT record equals one of the expected values. */
export async function checkOwnership(
  domain: string,
  expectedValues: string[],
  r: DnsCheckResolvers,
): Promise<CheckResult> {
  const { records, error } = await fetchTxt(domain, r);
  if (error !== null) return { ok: false, errors: [error] };
  if (records.some((record) => expectedValues.includes(record))) return { ok: true, errors: [] };
  return { ok: false, errors: records };
}

/**
 * MX: found records, sorted by priority, must be exactly `expectedExchanges`
 * in that order — same count, same hosts; the numeric priorities themselves
 * are ignored (SL is_mx_equivalent).
 */
export async function checkMx(
  domain: string,
  expectedExchanges: string[],
  r: DnsCheckResolvers,
): Promise<CheckResult> {
  let records: MxRecord[];
  try {
    records = await r.resolveMx(domain);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOTFOUND" || code === "ENODATA") return { ok: false, errors: [] };
    return {
      ok: false,
      errors: [`MX lookup failed for ${domain}: ${(err as Error).message}`],
    };
  }
  const sorted = [...records].sort((a, b) => a.priority - b.priority);
  const found = sorted.map((m) => normalizeHost(m.exchange));
  const expected = expectedExchanges.map(normalizeHost);
  const equivalent =
    found.length === expected.length && found.every((host, i) => host === expected[i]);
  if (equivalent) return { ok: true, errors: [] };
  return { ok: false, errors: sorted.map((m) => `${m.priority} ${m.exchange}`) };
}

/** Extract the `include:` targets of an SPF record value. */
export function spfIncludes(record: string): string[] {
  const out: string[] = [];
  for (const term of record.split(/\s+/)) {
    const m = /^[+?~-]?include:(.+)$/i.exec(term);
    if (m !== null) out.push(normalizeHost(m[1]!));
  }
  return out;
}

/** SPF: some `v=spf1` apex TXT record includes one of our SPF domains. */
export async function checkSpf(
  domain: string,
  allowedIncludes: string[],
  r: DnsCheckResolvers,
): Promise<CheckResult> {
  const { records, error } = await fetchTxt(domain, r);
  if (error !== null) return { ok: false, errors: [error] };
  const spfRecords = records.filter((record) => /^v=spf1\b/i.test(record.trim()));
  const allowed = allowedIncludes.map(normalizeHost);
  for (const record of spfRecords) {
    if (spfIncludes(record).some((inc) => allowed.includes(inc))) {
      return { ok: true, errors: [] };
    }
  }
  return { ok: false, errors: spfRecords };
}

/** Parse the p= tag out of a DKIM TXT record value (whitespace-tolerant). */
export function dkimPublicKeyOf(record: string): string | null {
  for (const part of record.split(";")) {
    const [tag, ...rest] = part.split("=");
    if (tag !== undefined && tag.trim().toLowerCase() === "p") {
      return rest.join("=").replace(/\s+/g, "");
    }
  }
  return null;
}

/** DKIM: the selector TXT carries exactly our published public key. */
export async function checkDkim(
  domain: string,
  selector: string,
  expectedPublicKeyBase64: string,
  r: DnsCheckResolvers,
): Promise<CheckResult> {
  const name = `${selector}._domainkey.${domain}`;
  const { records, error } = await fetchTxt(name, r);
  if (error !== null) return { ok: false, errors: [error] };
  const expected = expectedPublicKeyBase64.replace(/\s+/g, "");
  for (const record of records) {
    if (dkimPublicKeyOf(record) === expected) return { ok: true, errors: [] };
  }
  return { ok: false, errors: records };
}

/** DMARC: the `_dmarc` TXT equals the recommended record (SL exact match). */
export async function checkDmarc(domain: string, r: DnsCheckResolvers): Promise<CheckResult> {
  const { records, error } = await fetchTxt(`_dmarc.${domain}`, r);
  if (error !== null) return { ok: false, errors: [error] };
  if (records.some((record) => record.trim() === DMARC_RECORD)) return { ok: true, errors: [] };
  return { ok: false, errors: records };
}

// ---------------------------------------------------------------------------
// Expected records (what we tell the customer to publish) + the orchestrator
// ---------------------------------------------------------------------------

/** One DNS record the customer must publish. */
export interface ExpectedRecord {
  type: "TXT" | "MX";
  /** Fully-qualified name the record lives at. */
  hostname: string;
  value: string;
  /** MX only. */
  priority?: number;
}

/** The full set of records for one custom domain. */
export interface ExpectedDnsRecords {
  ownership: ExpectedRecord;
  mx: ExpectedRecord[];
  spf: ExpectedRecord;
  /** Null until the domain has a signing key row. */
  dkim: ExpectedRecord | null;
  dmarc: ExpectedRecord;
}

/** Options shared by {@link expectedDnsRecords} / {@link verifyCustomDomain}. */
export interface DnsExpectations {
  /** config.mailDomain — MX target + SPF include live under it. */
  mailDomain: string;
}

/** Our MX exchanges for customer domains, in priority order. */
export function expectedMxExchanges(mailDomain: string): string[] {
  return [`mail.${mailDomain}`];
}

/**
 * SPF include domains we accept. The apex include (`include:{mailDomain}`)
 * is what we recommend (SL parity); `spf1.{mailDomain}` is the dedicated
 * SPF host the legacy stack documented — both delegate to the same senders.
 */
export function allowedSpfIncludes(mailDomain: string): string[] {
  return [mailDomain, `spf1.${mailDomain}`];
}

/** Build the record set for the dashboard / dns endpoint. */
export function expectedDnsRecords(
  domain: string,
  ownershipToken: string,
  dkimKey: { selector: string; publicKeyBase64: string } | null,
  opts: DnsExpectations,
): ExpectedDnsRecords {
  return {
    ownership: {
      type: "TXT",
      hostname: domain,
      value: `${OWNERSHIP_PREFIX}=${ownershipToken}`,
    },
    mx: expectedMxExchanges(opts.mailDomain).map((exchange, i) => ({
      type: "MX",
      hostname: domain,
      priority: (i + 1) * 10,
      value: `${exchange}.`,
    })),
    spf: {
      type: "TXT",
      hostname: domain,
      value: `v=spf1 include:${opts.mailDomain} ~all`,
    },
    dkim:
      dkimKey === null
        ? null
        : {
            type: "TXT",
            hostname: `${dkimKey.selector}._domainkey.${domain}`,
            value: `v=DKIM1; k=rsa; p=${dkimKey.publicKeyBase64}`,
          },
    dmarc: {
      type: "TXT",
      hostname: `_dmarc.${domain}`,
      value: DMARC_RECORD,
    },
  };
}

/** Per-record results plus the updated row. */
export interface DomainVerification {
  ownership: CheckResult;
  mx: CheckResult;
  spf: CheckResult;
  dkim: CheckResult;
  dmarc: CheckResult;
  /** The domains row after flag updates. */
  domain: Domain;
}

/** Generate the ownership token (30 hex chars, SL uses random_string(30)). */
export function newOwnershipToken(): string {
  return randomBytes(15).toString("hex");
}

/**
 * Run every DNS check for a domain against real DNS and persist the outcome on
 * the row. `verified_owner` and `verified_mx` only ever UPGRADE here (an
 * interactive re-check never demotes a live domain — that's the cron's job,
 * behind nb_failed_checks); spf/dkim/dmarc reflect the latest check both ways.
 *
 * Winner-take-all: flipping `verified_owner` true recomputes the generated
 * `name` column, which is UNIQUE. If another account already owns this name,
 * that update violates the constraint — we catch it, persist the other checks
 * WITHOUT ownership (so this row's `name` stays NULL), and report ownership as
 * failed. First to prove control of DNS wins; a squatter can never take it.
 */
export async function verifyCustomDomain(
  db: Db,
  domainRow: Domain,
  opts: DnsExpectations & { resolvers?: DnsCheckResolvers },
): Promise<DomainVerification> {
  const r = opts.resolvers ?? defaultResolvers();

  let token = domainRow.ownershipTxtToken;
  if (token === null || token === "") {
    token = newOwnershipToken();
    await db.update(domains).set({ ownershipTxtToken: token }).where(eq(domains.id, domainRow.id));
  }

  const keyRow = await loadDkimKeyRow(db, domainRow.nameRequested, CUSTOM_DOMAIN_DKIM_SELECTOR);

  const [ownership, mx, spf, dkim, dmarc] = await Promise.all([
    checkOwnership(domainRow.nameRequested, [`${OWNERSHIP_PREFIX}=${token}`], r),
    checkMx(domainRow.nameRequested, expectedMxExchanges(opts.mailDomain), r),
    checkSpf(domainRow.nameRequested, allowedSpfIncludes(opts.mailDomain), r),
    keyRow === null
      ? Promise.resolve<CheckResult>({ ok: false, errors: ["no signing key for this domain"] })
      : checkDkim(domainRow.nameRequested, keyRow.selector, keyRow.publicKeyBase64, r),
    checkDmarc(domainRow.nameRequested, r),
  ]);

  // The non-ownership flags always persist; ownership is the one that can lose
  // the winner-take-all race.
  const otherFlags = {
    verifiedMx: domainRow.verifiedMx || mx.ok,
    verifiedSpf: spf.ok,
    verifiedDkim: dkim.ok,
    verifiedDmarc: dmarc.ok,
  };
  const wantOwner = domainRow.verifiedOwner || ownership.ok;

  let ownershipResult = ownership;
  let updated: Domain[];
  try {
    updated = await db
      .update(domains)
      .set({ ...otherFlags, verifiedOwner: wantOwner })
      .where(eq(domains.id, domainRow.id))
      .returning();
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // Someone else already owns this name: keep this row unowned (name = NULL).
    updated = await db
      .update(domains)
      .set(otherFlags)
      .where(eq(domains.id, domainRow.id))
      .returning();
    ownershipResult = { ok: false, errors: ["this domain is already verified by another account"] };
  }

  return { ownership: ownershipResult, mx, spf, dkim, dmarc, domain: updated[0]! };
}
