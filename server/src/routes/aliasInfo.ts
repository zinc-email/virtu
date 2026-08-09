// Alias serialization + the queries feeding it — the TS analog of
// SimpleLogin's app/api/serializer.py (serialize_alias_info_v2 /
// construct_alias_query). Field names verbatim.
//
// Count semantics copy construct_alias_query: nb_reply = reply logs,
// nb_block = non-reply blocked, nb_forward = non-reply non-blocked (bounces
// count as forwards here, exactly like SimpleLogin; /api/stats uses the
// stricter get_stats filters instead).

import { desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import {
  type Alias,
  aliases,
  aliasMailboxes,
  type Contact,
  contacts,
  deletedAliases,
  type EmailLog,
  emailLogs,
  type Mailbox,
  mailboxes,
} from "../db/schema";
import { formatCreationDate, timestampOf, websiteSendTo } from "./aliasText";

export interface AliasInfo {
  alias: Alias;
  mailbox: Mailbox;
  /** Full delivery list: primary + alias_mailboxes extras (SimpleLogin's
   * `Alias.mailboxes` property — de-duplicated, verified only, sorted by
   * email). */
  mailboxes: Mailbox[];
  nbForward: number;
  nbBlock: number;
  nbReply: number;
  latest: { log: EmailLog; contact: Contact } | null;
}

/** SimpleLogin `EmailLog.get_action()`: forward|reply|block|bounced. */
export function emailLogAction(log: EmailLog): "forward" | "reply" | "block" | "bounced" {
  if (log.isReply) return "reply";
  if (log.bounced) return "bounced";
  if (log.blocked) return "block";
  return "forward";
}

/**
 * Load the serializer inputs for a page of alias rows (<= PAGE_LIMIT): their
 * mailboxes, activity counts, and latest activity — three set-based queries,
 * no N+1.
 */
export async function loadAliasInfos(aliasRows: Alias[]): Promise<AliasInfo[]> {
  if (aliasRows.length === 0) return [];
  const aliasIds = aliasRows.map((a) => a.id);

  const joinRows = await db
    .select()
    .from(aliasMailboxes)
    .where(inArray(aliasMailboxes.aliasId, aliasIds));
  const extraIdsByAlias = new Map<number, number[]>();
  for (const j of joinRows) {
    const list = extraIdsByAlias.get(j.aliasId) ?? [];
    list.push(j.mailboxId);
    extraIdsByAlias.set(j.aliasId, list);
  }

  const mailboxIds = [
    ...new Set([...aliasRows.map((a) => a.mailboxId), ...joinRows.map((j) => j.mailboxId)]),
  ];
  const mailboxRows = await db.select().from(mailboxes).where(inArray(mailboxes.id, mailboxIds));
  const mailboxById = new Map(mailboxRows.map((m) => [m.id, m]));

  const countRows = await db
    .select({
      aliasId: emailLogs.aliasId,
      nbReply: sql<number>`count(*) filter (where ${emailLogs.isReply})`.mapWith(Number),
      nbBlock:
        sql<number>`count(*) filter (where not ${emailLogs.isReply} and ${emailLogs.blocked})`.mapWith(
          Number,
        ),
      nbForward:
        sql<number>`count(*) filter (where not ${emailLogs.isReply} and not ${emailLogs.blocked})`.mapWith(
          Number,
        ),
    })
    .from(emailLogs)
    .where(inArray(emailLogs.aliasId, aliasIds))
    .groupBy(emailLogs.aliasId);
  const countsByAlias = new Map(countRows.map((r) => [r.aliasId, r]));

  const latestRows = await db
    .selectDistinctOn([emailLogs.aliasId], { log: emailLogs, contact: contacts })
    .from(emailLogs)
    .innerJoin(contacts, eq(emailLogs.contactId, contacts.id))
    .where(inArray(emailLogs.aliasId, aliasIds))
    .orderBy(emailLogs.aliasId, desc(emailLogs.createdAt), desc(emailLogs.id));
  const latestByAlias = new Map(latestRows.map((r) => [r.log.aliasId, r]));

  return aliasRows.map((alias) => {
    const mailbox = mailboxById.get(alias.mailboxId);
    if (!mailbox) throw new Error(`alias ${alias.id} has no mailbox row`);
    const counts = countsByAlias.get(alias.id);

    // SimpleLogin Alias.mailboxes: primary + extras, de-duplicated, verified
    // only, sorted by email.
    const seen = new Set<number>();
    const fullList: Mailbox[] = [];
    for (const id of [alias.mailboxId, ...(extraIdsByAlias.get(alias.id) ?? [])]) {
      const mb = mailboxById.get(id);
      if (mb && mb.verified && !seen.has(mb.id)) {
        seen.add(mb.id);
        fullList.push(mb);
      }
    }
    fullList.sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0));

    return {
      alias,
      mailbox,
      mailboxes: fullList,
      nbForward: counts?.nbForward ?? 0,
      nbBlock: counts?.nbBlock ?? 0,
      nbReply: counts?.nbReply ?? 0,
      latest: latestByAlias.get(alias.id) ?? null,
    };
  });
}

/** Load one alias (scoped to the user) with serializer inputs; null if absent. */
export async function loadAliasInfo(userId: number, aliasId: number): Promise<AliasInfo | null> {
  const rows = await db.select().from(aliases).where(eq(aliases.id, aliasId)).limit(1);
  const alias = rows[0];
  if (!alias || alias.userId !== userId) return null;
  const infos = await loadAliasInfos([alias]);
  return infos[0] ?? null;
}

/** SimpleLogin `serialize_alias_info_v2` — wire field names verbatim. */
export function aliasToDict(info: AliasInfo) {
  return {
    id: info.alias.id,
    email: info.alias.email,
    creation_date: formatCreationDate(info.alias.createdAt),
    creation_timestamp: timestampOf(info.alias.createdAt),
    enabled: info.alias.enabled,
    note: info.alias.note,
    name: info.alias.name,
    nb_forward: info.nbForward,
    nb_block: info.nbBlock,
    nb_reply: info.nbReply,
    mailbox: { id: info.mailbox.id, email: info.mailbox.email },
    mailboxes: info.mailboxes.map((m) => ({ id: m.id, email: m.email })),
    // PGP is not implemented (deviation): support_pgp/disable_pgp are
    // hardcoded false; disable_pgp is accepted-but-ignored on PATCH.
    support_pgp: false,
    disable_pgp: false,
    latest_activity: info.latest
      ? {
          timestamp: timestampOf(info.latest.log.createdAt),
          action: emailLogAction(info.latest.log),
          contact: {
            email: info.latest.contact.websiteEmail,
            name: info.latest.contact.name,
            reverse_alias: websiteSendTo(info.latest.contact),
          },
        }
      : null,
    pinned: info.alias.pinned,
  };
}

export type AliasDict = ReturnType<typeof aliasToDict>;

/**
 * SimpleLogin `available_sl_email`: an address is free when no alias, no
 * tombstone, and no contact reverse alias uses it.
 */
export async function emailAvailable(email: string): Promise<boolean> {
  const [aliasHit, deletedHit, contactHit] = await Promise.all([
    db.select({ id: aliases.id }).from(aliases).where(eq(aliases.email, email)).limit(1),
    db
      .select({ id: deletedAliases.id })
      .from(deletedAliases)
      .where(eq(deletedAliases.email, email))
      .limit(1),
    db.select({ id: contacts.id }).from(contacts).where(eq(contacts.replyEmail, email)).limit(1),
  ]);
  return aliasHit.length === 0 && deletedHit.length === 0 && contactHit.length === 0;
}
