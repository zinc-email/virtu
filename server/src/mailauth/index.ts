/**
 * Authentication boundary: verify original bytes, decide local acceptance, then
 * sign the final rewritten bytes. The pinned mailauth patch owns RFC 9989 DNS
 * discovery/alignment and verification budgets without altering ARC input.
 * verify.ts owns explicit custody transitions and local acceptance policy;
 * sign.ts requires the final author's key and never weakens header coverage.
 *
 * On dependency upgrades, retain engine.unit.test.ts and the downstream
 * pipeline verification tests as compatibility checks before removing the patch.
 */

export {
  type AcceptanceEvidence,
  type ArcContext,
  DEFAULT_VERIFY_POLICY,
  type DnsResolver,
  type InboundSession,
  mapVerdict,
  type PolicyAction,
  VERDICT_RULES,
  type Verdict,
  type VerifyOptions,
  type VerifyPolicy,
  type VerifyResult,
  verifyInbound,
} from "./verify.ts";

export {
  type ArcSealConfig,
  DKIM_SIGNED_HEADERS,
  type DkimKeyConfig,
  type SignOutboundOptions,
  type SignOutboundResult,
  signOutbound,
} from "./sign.ts";
