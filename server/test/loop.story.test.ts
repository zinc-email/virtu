/**
 * Forwarding-loop guard story (plans/2026-09-05-security-review.md #2):
 * every forward through our mx stamps `X-Virtu-Hops`; a message that arrives
 * already at MAX_FORWARD_HOPS is accepted and dropped with a
 * `forward_loop` blocked log, nothing queued, nothing in any Maildir.
 *
 * The ring itself (a mailbox on a domain whose MX is us) is refused at
 * mailbox creation (routes int tier); this story pins the backstop by
 * presenting the mx with a message that has already been round the ring —
 * i.e. carries the counter at the limit — and checks the hop below the
 * limit still delivers, incremented.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db/index.ts";
import { emailLogs } from "../src/db/schema.ts";
import { FORWARD_HOPS_HEADER, MAX_FORWARD_HOPS } from "../src/mail/rewriteForward.ts";
import { createAlias, ensureDkimKey, ensureWes, pollUntil, type UserFixture } from "./fixtures.ts";
import { findMail, getHeader, waitForMail } from "./maildir.ts";
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

describe("forwarding loop guard", () => {
  test("one hop below the limit forwards, counter incremented", async () => {
    const alias = await createAlias(fixture);
    const testId = newTestId();
    await smtpSend({
      host: milton.submission.host,
      port: milton.submission.port,
      from: milton.email,
      to: alias.email,
      data: buildMessage({
        from: `Milton Waddams <${milton.email}>`,
        to: alias.email,
        subject: "chained once",
        testId,
        extraHeaders: [`${FORWARD_HOPS_HEADER}: ${MAX_FORWARD_HOPS - 1}`],
      }),
    });
    const delivered = await waitForMail(wes, testId);
    expect(getHeader(delivered.raw, FORWARD_HOPS_HEADER)).toBe(String(MAX_FORWARD_HOPS));
  }, 90_000);

  test("at the limit: 250 accept-and-drop with a forward_loop blocked log", async () => {
    const alias = await createAlias(fixture);
    const testId = newTestId();
    await smtpSend({
      host: milton.submission.host,
      port: milton.submission.port,
      from: milton.email,
      to: alias.email,
      data: buildMessage({
        from: `Milton Waddams <${milton.email}>`,
        to: alias.email,
        subject: "round the ring",
        testId,
        extraHeaders: [`${FORWARD_HOPS_HEADER}: ${MAX_FORWARD_HOPS}`],
      }),
    });

    await pollUntil(
      async () => {
        const blocked = await db
          .select()
          .from(emailLogs)
          .where(and(eq(emailLogs.aliasId, alias.id), eq(emailLogs.blocked, true)));
        return blocked.length > 0;
      },
      { timeoutMs: 60_000, what: "forward_loop blocked email_log" },
    );
    const logs = await db.select().from(emailLogs).where(eq(emailLogs.aliasId, alias.id));
    expect(logs.every((l) => l.blocked && l.blockedReason === "forward_loop")).toBe(true);
    expect(await findMail(wes, testId)).toBeUndefined();
  }, 90_000);
});
