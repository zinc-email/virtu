// Shared config for every entrypoint (api, mx, submission, deliverd — see
// PLAN.md). Parsed once from env at import; keys map camelCase -> SCREAMING
// snake env names via app/env.ts (databaseUrl -> DATABASE_URL, ...).

import { z } from "zod";
import { loadConfigFromEnv } from "./app/env";

const ConfigSchema = z.object({
  databaseUrl: z.string().default("postgres://virtu:virtu@localhost:5432/virtu"),
  apiHost: z.string().default("0.0.0.0"),
  apiPort: z.coerce.number().int().default(3000),
  // Requests/minute per IP across the auth routes (register/activate/login).
  // The dev compose raises it: the DOM test tier registers users freely.
  authRateLimitMax: z.coerce.number().int().default(10),

  // ── Mail path (mx / submission / deliverd — PLAN Milestones 1-3) ─────────
  // The domain aliases + reverse aliases + VERP addresses live on.
  mailDomain: z.string().default("virtu.email"),
  // Our MX hostname: SMTP banner, EHLO, Authentication-Results stamps.
  mailHostname: z.string().default("mail.virtu.email"),
  // DKIM selector for our signing key in dkim_keys ({selector}._domainkey.{domain}).
  dkimSelector: z.string().default("mail"),
  // HMAC secret for VERP bounce addresses (>= 32 chars, SimpleLogin invariant).
  // The default is a dev-only value; production must override.
  verpSecret: z.string().min(32).default("insecure-dev-verp-secret-change-me-00"),
  // PEM cert/key for STARTTLS (25/587) and implicit TLS (465). Both unset =>
  // plaintext-only listeners (local dev); requireAuthTls then defaults off.
  smtpTlsCertFile: z.string().optional(),
  smtpTlsKeyFile: z.string().optional(),
  smtpHost: z.string().default("0.0.0.0"),
  mxPort: z.coerce.number().int().default(25),
  submissionPort: z.coerce.number().int().default(587),
  submissionTlsPort: z.coerce.number().int().default(465),
  smtpMaxMessageSize: z.coerce
    .number()
    .int()
    .default(25 * 1024 * 1024),

  // ── Delivery queue (deliverd) ────────────────────────────────────────────
  queuePollMs: z.coerce.number().int().default(1000),
  queueBatchSize: z.coerce.number().int().default(10),
  // Max delivery attempts before a transient failure becomes permanent.
  queueMaxTries: z.coerce.number().int().default(6),
});

export const config = loadConfigFromEnv(ConfigSchema);
export type Config = typeof config;

// SimpleLogin's MAX_NB_EMAIL_FREE_PLAN default.
export const MAX_ALIAS_FREE_PLAN = 5;
