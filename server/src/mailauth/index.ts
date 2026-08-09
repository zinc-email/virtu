/**
 * Lane B public surface: inbound verification (SPF/DKIM/DMARC/ARC via one
 * in-process mailauth call, mapped to a pre-queue verdict) and outbound
 * DKIM signing + ARC sealing. Wave 2 (mx/submission wiring) codes against
 * these interfaces; all DNS goes through the injectable resolver.
 */

export {
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
  DKIM_HEADER_FALLBACK_CHAINS,
  type DkimKeyConfig,
  type SignError,
  type SignOutboundOptions,
  type SignOutboundResult,
  signOutbound,
} from "./sign.ts";
