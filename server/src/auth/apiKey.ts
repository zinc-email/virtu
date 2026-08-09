// API-key material: generation + hashing. Pure helpers (no DB) so they stay
// unit-testable. Keys are shown once at creation; only the sha256 hex digest
// is stored (api_keys.key_hash).

import { createHash, randomBytes } from "node:crypto";

// 32 random bytes -> 43-char base64url string ("long string" per the
// SimpleLogin docs; theirs is 60 alnum chars, same entropy class).
const API_KEY_BYTES = 32;

export function generateApiKey(): string {
  return randomBytes(API_KEY_BYTES).toString("base64url");
}

export function hashApiKey(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}
