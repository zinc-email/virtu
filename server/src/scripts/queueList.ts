// List outbound_messages rows, newest first — the break-glass queue view
// (PLAN Lane K). Direct DB; works with the API down.
//
// Usage: bin/queue-list [status] [--limit n]

import { desc, eq } from "drizzle-orm";
import { db } from "../db";
import { outboundMessages } from "../db/schema";

const STATUSES = ["pending", "sending", "sent", "failed"] as const;

const args = process.argv.slice(2);
const limitIdx = args.indexOf("--limit");
const limit = limitIdx === -1 ? 50 : Number(args[limitIdx + 1]);
const positional = args.filter(
  (a, i) => a !== "--limit" && (limitIdx === -1 || i !== limitIdx + 1),
);
const rawStatus = positional[0];
const status = STATUSES.find((s) => s === rawStatus);

if (rawStatus !== undefined && status === undefined) {
  console.error(`usage: queueList.ts [${STATUSES.join("|")}] [--limit n]`);
  process.exit(2);
}
if (!Number.isInteger(limit) || limit < 1) {
  console.error("--limit must be a positive integer");
  process.exit(2);
}

const rows = await db
  .select({
    id: outboundMessages.id,
    status: outboundMessages.status,
    tries: outboundMessages.tries,
    nextAttemptAt: outboundMessages.nextAttemptAt,
    envelopeTo: outboundMessages.envelopeTo,
    lastError: outboundMessages.lastError,
  })
  .from(outboundMessages)
  .where(status === undefined ? undefined : eq(outboundMessages.status, status))
  .orderBy(desc(outboundMessages.id))
  .limit(limit);

if (rows.length === 0) {
  console.log(status === undefined ? "queue is empty" : `no ${status} rows`);
  process.exit(0);
}
for (const row of rows) {
  const next = row.status === "pending" ? ` next=${row.nextAttemptAt.toISOString()}` : "";
  const error = row.lastError === null ? "" : ` error=${JSON.stringify(row.lastError)}`;
  console.log(`#${row.id} ${row.status} tries=${row.tries} to=${row.envelopeTo}${next}${error}`);
}
process.exit(0);
