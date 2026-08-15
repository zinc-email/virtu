/**
 * Recipient-domain → provider bucket for delivery-outcome metrics. A fixed
 * table on purpose: destination domains are attacker-influenced free text,
 * and Prometheus label cardinality must stay bounded. Anything not on the
 * list is "other" — per-domain detail belongs in Postgres aggregates
 * (Lane K roadmap P4), not in metric labels.
 */

const PROVIDER_DOMAINS: Record<string, string> = {
  "gmail.com": "gmail",
  "googlemail.com": "gmail",
  "outlook.com": "microsoft",
  "hotmail.com": "microsoft",
  "live.com": "microsoft",
  "msn.com": "microsoft",
  "yahoo.com": "yahoo",
  "ymail.com": "yahoo",
  "aol.com": "yahoo",
  "icloud.com": "icloud",
  "me.com": "icloud",
  "mac.com": "icloud",
  "proton.me": "proton",
  "protonmail.com": "proton",
  "pm.me": "proton",
};

/** Provider bucket for a recipient address or bare domain. */
export function providerFor(addressOrDomain: string): string {
  const at = addressOrDomain.lastIndexOf("@");
  const domain = (at === -1 ? addressOrDomain : addressOrDomain.slice(at + 1)).trim().toLowerCase();
  return PROVIDER_DOMAINS[domain] ?? "other";
}
