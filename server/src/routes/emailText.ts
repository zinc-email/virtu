// Email-address text helpers shared across the route surface. One
// definition each on purpose: these are security-adjacent (what counts as
// "the same address", what counts as an address at all), and per-file
// copies were already drifting before they were pulled here (2026-09-07
// review — auth.ts, mailboxRoutes.ts and contacts.ts each carried their
// own looksLikeEmail).

/** The one canonical form an address is stored and compared in. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Deliberately loose shape check — real deliverability checks (MX,
 * disposable-domain blocklist; legacy virtu had both) are a wave-2 concern.
 */
export function looksLikeEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
