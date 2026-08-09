/**
 * Edge-policy stories at the mx (PLAN Lane C semantics):
 *
 *   - mail to a NONEXISTENT alias is refused 550 at RCPT time;
 *   - mail to a DISABLED alias is accepted (250) and dropped — a blocked
 *     email_log appears, nothing is queued, nothing reaches any Maildir —
 *     so the alias's existence is never probed.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db/index.ts";
import { emailLogs } from "../src/db/schema.ts";
import {
  createAlias,
  ensureDkimKey,
  ensureWes,
  pollUntil,
  randomTag,
  type UserFixture,
} from "./fixtures.ts";
import { findMail } from "./maildir.ts";
import { buildMessage } from "./message.ts";
import { milton, wes } from "./personas.ts";
import { smtpSend, waitForPort } from "./smtpSend.ts";
import { newTestId } from "./testId.ts";

let fixture: UserFixture;

beforeAll(async () => {
  await waitForPort("mail.virtu.email", 25, 60_000);
  await ensureDkimKey();
  fixture = await ensureWes();
});

describe("mx policy", () => {
  test("nonexistent alias: 550 at RCPT", async () => {
    const nowhere = `no-such-alias-${randomTag()}@virtu.email`;
    // Straight to our mx on port 25: the rejection happens at RCPT, before
    // DATA (so no DMARC evaluation can interfere with the story).
    let error: Error | null = null;
    try {
      await smtpSend({
        host: "mail.virtu.email",
        port: 25,
        from: milton.email,
        to: nowhere,
        data: buildMessage({
          from: milton.email,
          to: nowhere,
          subject: "should be refused",
          testId: newTestId(),
        }),
      });
    } catch (err) {
      error = err as Error;
    }
    expect(error).not.toBeNull();
    expect(error!.message).toContain("RCPT");
    expect(error!.message).toContain("550");
  }, 60_000);

  test("foreign recipient: relay denied at RCPT", async () => {
    let error: Error | null = null;
    try {
      await smtpSend({
        host: "mail.virtu.email",
        port: 25,
        from: milton.email,
        to: "peter@initech.com",
        data: buildMessage({
          from: milton.email,
          to: "peter@initech.com",
          subject: "open relay probe",
          testId: newTestId(),
        }),
      });
    } catch (err) {
      error = err as Error;
    }
    expect(error).not.toBeNull();
    expect(error!.message).toContain("554");
  }, 60_000);

  test("disabled alias: 250 accept-and-drop with a blocked log", async () => {
    const alias = await createAlias(fixture, { enabled: false });
    const testId = newTestId();

    // Through initech so the message is fully DMARC-clean; it must be
    // accepted end-to-end (a 5xx from our mx would bounce at initech).
    await smtpSend({
      host: milton.submission.host,
      port: milton.submission.port,
      from: milton.email,
      to: alias.email,
      data: buildMessage({
        from: `Milton Waddams <${milton.email}>`,
        to: alias.email,
        subject: "probing a disabled alias",
        testId,
      }),
    });

    // The drop is recorded...
    await pollUntil(
      async () => {
        const blocked = await db
          .select()
          .from(emailLogs)
          .where(and(eq(emailLogs.aliasId, alias.id), eq(emailLogs.blocked, true)));
        return blocked.length > 0;
      },
      { timeoutMs: 60_000, what: "blocked email_log for the disabled alias" },
    );

    // ...no forward log exists, and nothing reached Wes's Maildir.
    const logs = await db.select().from(emailLogs).where(eq(emailLogs.aliasId, alias.id));
    expect(logs.every((l) => l.blocked)).toBe(true);
    expect(await findMail(wes, testId)).toBeUndefined();
  }, 90_000);
});
