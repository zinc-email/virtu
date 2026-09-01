// Insert one in-app notification for a user — dev tooling for the client DOM
// tier (notifications are pipeline-produced; tests need one on demand) and a
// handy operator lever ("we'll migrate your domain Tuesday"). Direct DB via
// the server's drizzle, same seam sendAlertOnce writes through.
//
// Usage: bin/notification-create <email> <title> <message>

import { eq } from "drizzle-orm";
import { db } from "../db";
import { notifications, users } from "../db/schema";

const [emailArg, title, message] = process.argv.slice(2);
const email = emailArg?.trim().toLowerCase();
if (!email || !title || !message) {
  console.error("usage: notificationCreate.ts <email> <title> <message>");
  process.exit(2);
}

const rows = await db.select().from(users).where(eq(users.email, email)).limit(1);
const user = rows[0];
if (user === undefined) {
  console.error(`no user with email ${email}`);
  process.exit(1);
}

const inserted = await db
  .insert(notifications)
  .values({ userId: user.id, title, message })
  .returning({ id: notifications.id });
console.log(`notification ${inserted[0]!.id} for ${email} (user ${user.id})`);
process.exit(0);
