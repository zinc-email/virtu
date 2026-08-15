// Queue counts by status + oldest pending age — the break-glass overview.
//
// Usage: bin/queue-stats

import { count, eq, min } from "drizzle-orm";
import { db } from "../db";
import { outboundMessages } from "../db/schema";

const byStatus = await db
  .select({ status: outboundMessages.status, n: count() })
  .from(outboundMessages)
  .groupBy(outboundMessages.status);

for (const status of ["pending", "sending", "sent", "failed"]) {
  console.log(`${status}: ${byStatus.find((r) => r.status === status)?.n ?? 0}`);
}

const [oldest] = await db
  .select({ oldest: min(outboundMessages.nextAttemptAt) })
  .from(outboundMessages)
  .where(eq(outboundMessages.status, "pending"));
if (oldest?.oldest != null) {
  const ageSeconds = Math.max(0, Math.round((Date.now() - oldest.oldest.getTime()) / 1000));
  console.log(`oldest pending due: ${oldest.oldest.toISOString()} (${ageSeconds}s ago)`);
}
process.exit(0);
