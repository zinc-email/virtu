// alias_mailboxes maintenance — the join table holding an alias's extra
// delivery mailboxes beyond the primary `aliases.mailbox_id` (SimpleLogin
// AliasMailbox). Serialization reads it in aliasInfo.ts; this module owns
// the writes.

import { and, eq, inArray, sql } from "drizzle-orm";
import { type Db, db } from "../db";
import { aliases, aliasMailboxes, mailboxes } from "../db/schema";
import { HttpError } from "./httpError";

/** A drizzle transaction handle (same query surface as `db`). */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** SimpleLogin _MAX_MAILBOXES_PER_ALIAS. */
export const MAX_MAILBOXES_PER_ALIAS = 20;

/**
 * Validate a `mailbox_ids` list for PUT/PATCH /aliases/:id exactly like
 * SimpleLogin's `set_mailboxes_for_alias` (error strings verbatim): every id
 * must be one of the user's verified mailboxes, at least one, at most 20.
 * Returns the mailbox rows ordered by id ascending — SimpleLogin makes the
 * lowest id the primary.
 */
export async function validateMailboxIdsForUpdate(userId: number, mailboxIds: number[]) {
  if (mailboxIds.length === 0) throw new HttpError(400, "Must choose at least one mailbox");
  if (mailboxIds.length > MAX_MAILBOXES_PER_ALIAS) throw new HttpError(400, "Too many mailboxes");
  const rows = await db
    .select()
    .from(mailboxes)
    .where(
      and(
        inArray(mailboxes.id, mailboxIds),
        eq(mailboxes.userId, userId),
        eq(mailboxes.verified, true),
      ),
    )
    .orderBy(mailboxes.id);
  // Duplicate or unknown/unverified/foreign ids all surface as a length
  // mismatch, exactly like SimpleLogin.
  if (rows.length !== mailboxIds.length) throw new HttpError(400, "Forbidden");
  return rows;
}

/**
 * Replace an alias's mailbox set: the first id becomes the primary
 * (`aliases.mailbox_id`), the rest replace the join-table rows (SimpleLogin
 * `set_mailboxes_for_alias`). Caller has already validated ownership.
 */
export async function replaceAliasMailboxes(aliasId: number, orderedMailboxIds: number[]) {
  const [primary, ...extras] = orderedMailboxIds;
  if (primary === undefined) throw new Error("replaceAliasMailboxes: empty mailbox list");
  const uniqueExtras = [...new Set(extras)].filter((id) => id !== primary);
  await db.transaction(async (tx) => {
    await tx.update(aliases).set({ mailboxId: primary }).where(eq(aliases.id, aliasId));
    await tx.delete(aliasMailboxes).where(eq(aliasMailboxes.aliasId, aliasId));
    if (uniqueExtras.length > 0) {
      await tx
        .insert(aliasMailboxes)
        .values(uniqueExtras.map((mailboxId) => ({ aliasId, mailboxId })));
    }
  });
}

/** Insert the extra (non-primary) mailboxes for a freshly created alias. */
export async function insertExtraAliasMailboxes(tx: Tx, aliasId: number, extraIds: number[]) {
  const unique = [...new Set(extraIds)];
  if (unique.length === 0) return;
  await tx.insert(aliasMailboxes).values(unique.map((mailboxId) => ({ aliasId, mailboxId })));
}

/**
 * Mailbox deletion with transfer_aliases_to: repoint join rows from the
 * doomed mailbox to the target, dropping any row that would duplicate the
 * target (SimpleLogin's delete_mailbox_job semantics — with the one
 * refinement that a join row equal to the alias's primary is dropped rather
 * than kept and de-duplicated at serialization time).
 *
 * Call inside the delete-mailbox transaction, AFTER the primary transfer
 * (`UPDATE aliases SET mailbox_id = to WHERE mailbox_id = from`).
 */
export async function transferAliasMailboxJoins(
  tx: Tx,
  fromMailboxId: number,
  toMailboxId: number,
) {
  // Join rows that now duplicate their alias's primary mailbox.
  await tx
    .delete(aliasMailboxes)
    .where(
      and(
        inArray(aliasMailboxes.mailboxId, [fromMailboxId, toMailboxId]),
        sql`exists (select 1 from ${aliases} where ${aliases.id} = ${aliasMailboxes.aliasId} and ${aliases.mailboxId} = ${toMailboxId})`,
      ),
    );
  // Rows on the doomed mailbox whose alias already lists the target as an extra.
  await tx
    .delete(aliasMailboxes)
    .where(
      and(
        eq(aliasMailboxes.mailboxId, fromMailboxId),
        sql`exists (select 1 from alias_mailboxes am2 where am2.alias_id = ${aliasMailboxes.aliasId} and am2.mailbox_id = ${toMailboxId})`,
      ),
    );
  // Repoint the rest.
  await tx
    .update(aliasMailboxes)
    .set({ mailboxId: toMailboxId })
    .where(eq(aliasMailboxes.mailboxId, fromMailboxId));
}
