// Suppress a mailbox by address — dev tooling for the client DOM tier (in
// real life the mail pipeline suppresses on a 5.1.1/5.2.1 bounce; tests need
// the state on demand) and an operator lever for a known-dead destination.
// Goes through the SAME pipeline function as deliverd/mx, so the in-app
// notification fires too.
//
// Usage: bin/mailbox-suppress <mailbox-email> [enhanced-code]

import { eq } from "drizzle-orm";
import { db } from "../db";
import { mailboxes } from "../db/schema";
import { isSuppressionCode, suppressMailbox } from "../pipeline/suppression";

const [emailArg, codeArg] = process.argv.slice(2);
const email = emailArg?.trim().toLowerCase();
const enhancedCode = codeArg ?? "5.1.1";
if (!email || !isSuppressionCode(enhancedCode)) {
  console.error("usage: mailboxSuppress.ts <mailbox-email> [5.1.1|5.2.1]");
  process.exit(2);
}

const rows = await db.select().from(mailboxes).where(eq(mailboxes.email, email));
if (rows.length === 0) {
  console.error(`no mailbox with address ${email}`);
  process.exit(1);
}
for (const mb of rows) {
  const result = await suppressMailbox(db, mb.id, { enhancedCode });
  console.log(
    `mailbox ${mb.id} (user ${mb.userId}): ${result.suppressed ? "suppressed" : "already suppressed"}`,
  );
}
process.exit(0);
