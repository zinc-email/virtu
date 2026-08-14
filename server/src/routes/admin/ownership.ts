// Who does a queue row belong to? There is deliberately no FK from
// outbound_messages to email_logs (PLAN Lane D keeps the queue table dumb);
// the correlation is the VERP return path — bounce_forward/bounce_reply
// encode an email_logs id, transactional a verification_codes id. A row
// whose envelope_from is the null reverse path (DSNs, trash copies), or
// whose VERP is expired (5-day validity — queue retention keeps rows
// younger) or foreign, resolves to null. Durable attribution columns are
// the Lane K P2 schema decision.

import { eq } from "drizzle-orm";
import { config } from "../../config.ts";
import type { Db } from "../../db/index.ts";
import { aliases, emailLogs, users, verificationCodes } from "../../db/schema.ts";
import { parseVerp, type VerpType } from "../../mail/index.ts";

export interface QueueOwner {
  verpType: VerpType;
  verpId: number;
  emailLogId: number | null;
  verificationCodeId: number | null;
  user: { id: number; email: string } | null;
  alias: { id: number; email: string } | null;
}

export async function resolveQueueOwner(db: Db, envelopeFrom: string): Promise<QueueOwner | null> {
  if (envelopeFrom === "") return null;
  const verp = parseVerp(envelopeFrom, config.verpSecret);
  if (verp === null) return null;

  if (verp.type === "transactional") {
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
    .where(eq(emailLogs.id, verp.id))
    .limit(1);
  const hit = rows[0];
  return {
    verpType: verp.type,
    verpId: verp.id,
    emailLogId: hit?.emailLogId ?? null,
    verificationCodeId: null,
    user: hit === undefined ? null : { id: hit.userId, email: hit.userEmail },
    alias:
      hit?.aliasId == null || hit.aliasEmail === null
        ? null
        : { id: hit.aliasId, email: hit.aliasEmail },
  };
}
