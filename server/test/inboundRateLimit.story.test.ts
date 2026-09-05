/**
 * Per-alias inbound rate limit (pipeline/inboundRateLimit.ts) at the real
 * MX: with the budget's worth of forwards to an alias inside the trailing
 * minute, the next RCPT TO for it is tempfailed 450 4.7.1 — before DATA, so the sending MTA
 * queues and retries and nothing is lost. Once the window has passed, the
 * same alias accepts RCPT again.
 *
 * The test-runner speaks SMTP straight to mail.virtu.email:25 (not through
 * a peer MTA) so the RCPT reply is observable; the DATA phase is never
 * reached in the limited case. The ten prior forwards are seeded as
 * email_log rows — the count IS the ledger, and a wire-driven seed through
 * Initech's queue would race the minute.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../src/db/index.ts";
import { contacts, emailLogs } from "../src/db/schema.ts";
import { createAlias, ensureDkimKey, ensureWes, randomTag, type UserFixture } from "./fixtures.ts";
import { buildMessage } from "./message.ts";
import { milton } from "./personas.ts";
import { smtpSend, waitForPort } from "./smtpSend.ts";
import { newTestId } from "./testId.ts";

/** docker-compose.test.yml pins INBOUND_RATE_LIMIT_PER_ALIAS_PER_MINUTE. */
const ALIAS_BUDGET = 50;

let fixture: UserFixture;

beforeAll(async () => {
  await waitForPort("mail.virtu.email", 25, 60_000);
  await ensureDkimKey();
  fixture = await ensureWes();
});

async function seedForwards(aliasId: number, mailboxId: number, n: number, createdAt: Date) {
  const tag = randomTag();
  const contact = (
    await db
      .insert(contacts)
      .values({
        userId: fixture.user.id,
        aliasId,
        websiteEmail: `flood-${tag}@example.com`,
        replyEmail: `flood_${tag}@virtu.email`,
      })
      .returning()
  )[0]!;
  await db.insert(emailLogs).values(
    Array.from({ length: n }, (_, i) => ({
      userId: fixture.user.id,
      contactId: contact.id,
      aliasId,
      mailboxId,
      messageId: `<flood-${tag}-${i}@example.com>`,
      createdAt,
    })),
  );
  return contact;
}

describe("inbound rate limit at the MX", () => {
  test("one message past the minute budget: RCPT 450 4.7.1; after the window: accepted", async () => {
    const alias = await createAlias(fixture);
    const contact = await seedForwards(alias.id, fixture.mailbox.id, ALIAS_BUDGET, new Date());

    const send = () =>
      smtpSend({
        host: "mail.virtu.email",
        port: 25,
        from: milton.email,
        to: alias.email,
        data: buildMessage({
          from: `Milton Waddams <${milton.email}>`,
          to: alias.email,
          subject: "flood",
          testId: newTestId(),
          body: "one more",
        }),
        timeoutMs: 30_000,
      });

    // Over budget: the RCPT itself is refused with a tempfail.
    await expect(send()).rejects.toThrow(/RCPT: expected 250, got 450 .*4\.7\.1/);

    // Window passed: RCPT is accepted again. (DATA may then be refused —
    // the test-runner is not in initech.com's SPF and Initech publishes
    // p=reject — but that is a different reply at a different step.)
    await db
      .update(emailLogs)
      .set({ createdAt: new Date(Date.now() - 2 * 60_000) })
      .where(eq(emailLogs.contactId, contact.id));
    try {
      await send();
    } catch (err) {
      expect((err as Error).message).not.toMatch(/RCPT: expected 250, got 450/);
    }
  }, 90_000);
});
