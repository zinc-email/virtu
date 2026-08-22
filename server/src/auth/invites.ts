// Invite minting (ABUSE.md Tier 0) — the shared primitive behind both the
// admin API (routes/admin/invites.ts) and the break-glass CLI
// (scripts/inviteCreate.ts), so the two can never diverge. Consumption is
// NOT here: it lives inside graduateUser's transaction in routes/auth.ts —
// one call site, atomic with activation.

import { randomBytes } from "node:crypto";
import type { Db } from "../db";
import { type Invite, invites } from "../db/schema";

// 9 random bytes -> 12-char base64url: short enough to read out loud,
// 2^72 entropy — unguessable through the per-IP-rate-limited auth surface.
const INVITE_CODE_BYTES = 9;

export function generateInviteCode(): string {
  return randomBytes(INVITE_CODE_BYTES).toString("base64url");
}

export interface CreateInvitesInput {
  count: number;
  note?: string;
  /** Null/undefined = never expires. */
  expiresAt?: Date | null;
  /** Admin user id; null when minted by the CLI (no admin session). */
  createdBy?: number | null;
}

export async function createInvites(db: Db, input: CreateInvitesInput): Promise<Invite[]> {
  const rows = Array.from({ length: input.count }, () => ({
    code: generateInviteCode(),
    note: input.note ?? null,
    expiresAt: input.expiresAt ?? null,
    createdBy: input.createdBy ?? null,
  }));
  return db.insert(invites).values(rows).returning();
}
