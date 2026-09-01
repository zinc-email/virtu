// Who does a queue row belong to? Two sources, richest first: the VERP
// return path (bounce_forward/bounce_reply encode an email_logs id,
// transactional a verification_codes id) and, when that yields nothing —
// null reverse path (DSNs, trash copies), expired VERP (5-day validity),
// rows enqueued before attribution — the durable attribution columns
// outbound_messages.user_id/email_log_id (Lane K P2). deliverd itself never
// reads either; the queue stays operationally dumb.

import { eq } from "drizzle-orm";
import { config } from "../../config.ts";
import type { Db } from "../../db/index.ts";
import { aliases, emailLogs, users, verificationCodes } from "../../db/schema.ts";
import { parseVerp, type VerpType } from "../../mail/index.ts";

export interface QueueOwner {
  /** Null when the owner came from the attribution columns, not the VERP. */
  verpType: VerpType | null;
  verpId: number | null;
  emailLogId: number | null;
  verificationCodeId: number | null;
  user: { id: number; email: string } | null;
  alias: { id: number; email: string } | null;
}

/** The attribution facts a queue row carries alongside its envelope. */
export interface QueueOwnerRow {
  envelopeFrom: string;
  userId: number | null;
  emailLogId: number | null;
}

async function lookupEmailLogOwner(
  db: Db,
  emailLogId: number,
): Promise<{
  emailLogId: number;
  user: { id: number; email: string };
  alias: { id: number; email: string } | null;
} | null> {
  const rows = await db
    .select({
      emailLogId: emailLogs.id,
      userId: users.id,
      userEmail: users.email,
      aliasId: aliases.id,
      aliasEmail: aliases.email,
    })
    .from(emailLogs)
    .innerJoin(users, eq(emailLogs.userId, users.id))
    .leftJoin(aliases, eq(emailLogs.aliasId, aliases.id))
    .where(eq(emailLogs.id, emailLogId))
    .limit(1);
  const hit = rows[0];
  if (hit === undefined) return null;
  return {
    emailLogId: hit.emailLogId,
    user: { id: hit.userId, email: hit.userEmail },
    alias:
      hit.aliasId == null || hit.aliasEmail === null
        ? null
        : { id: hit.aliasId, email: hit.aliasEmail },
  };
}

export async function resolveQueueOwner(db: Db, row: QueueOwnerRow): Promise<QueueOwner | null> {
  const verp = row.envelopeFrom === "" ? null : parseVerp(row.envelopeFrom, config.verpSecret);

  if (verp?.type === "transactional") {
    const rows = await db
      .select({ codeId: verificationCodes.id, userId: users.id, userEmail: users.email })
      .from(verificationCodes)
      .innerJoin(users, eq(verificationCodes.userId, users.id))
      .where(eq(verificationCodes.id, verp.id))
      .limit(1);
    const hit = rows[0];
    return {
      verpType: verp.type,
      verpId: verp.id,
      emailLogId: null,
      verificationCodeId: hit?.codeId ?? null,
      user: hit === undefined ? null : { id: hit.userId, email: hit.userEmail },
      alias: null,
    };
  }

  if (verp !== null) {
    const hit = await lookupEmailLogOwner(db, verp.id);
    return {
      verpType: verp.type,
      verpId: verp.id,
      emailLogId: hit?.emailLogId ?? null,
      verificationCodeId: null,
      user: hit?.user ?? null,
      alias: hit?.alias ?? null,
    };
  }

  // No decodable VERP — fall back to the durable columns.
  if (row.emailLogId !== null) {
    const hit = await lookupEmailLogOwner(db, row.emailLogId);
    if (hit !== null) {
      return {
        verpType: null,
        verpId: null,
        emailLogId: hit.emailLogId,
        verificationCodeId: null,
        user: hit.user,
        alias: hit.alias,
      };
    }
  }
  if (row.userId !== null) {
    const rows = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.id, row.userId))
      .limit(1);
    const hit = rows[0];
    if (hit !== undefined) {
      return {
        verpType: null,
        verpId: null,
        emailLogId: row.emailLogId,
        verificationCodeId: null,
        user: hit,
        alias: null,
      };
    }
  }
  return null;
}
