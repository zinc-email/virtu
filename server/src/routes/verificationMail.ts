// The one way a route emails a verification code (login, sudo, mailbox):
// budget check → mint → ledger + send, with the two refusal paths handled
// so a route can never answer "code sent" while nothing was queued.
//
// Why the pre-check AND the result check: the budget is read before minting
// so hammering a route cannot pile up codes it never sends (each mint past
// MAX_ACTIVE_CODES would retire a code the user actually received), and the
// send's own re-check can still refuse under concurrency — that minted code
// is then retired on the spot and the caller gets the 429 it would have got
// a moment earlier. A ceiling refusal is reported once, here.

import { eq } from "drizzle-orm";
import type { Db } from "../db/index.ts";
import { verificationCodes } from "../db/schema.ts";
import {
  createVerificationCode,
  noteCeilingRefusal,
  type RateLimitScope,
  sendBudget,
  type SendRefusal,
  sendWithRateLimit,
  type VerificationPurpose,
} from "../pipeline/transactional.ts";
import { HttpError } from "./httpError.ts";

export interface IssueCodeOptions {
  userId: number;
  /** Where the code is mailed (and the budget's recipient key). */
  toEmail: string;
  /** Budget ledger key (LOGIN_CODE_ALERT_TYPE, …). */
  alertType: string;
  purpose: VerificationPurpose;
  /** Required for purpose "mailbox". */
  mailboxId?: number;
  /** The template, given the plaintext code. */
  email: (code: string) => { subject: string; textBody: string };
  /** The 429 body when the scope's own budget refuses. */
  refusedMessage: string;
}

/**
 * Mint and email one code, or throw the 429. Resolves to the code row id
 * (the VERP ref) once the message is in the queue.
 */
export async function issueVerificationCode(db: Db, opts: IssueCodeOptions): Promise<number> {
  const scope: RateLimitScope = {
    userId: opts.userId,
    toEmail: opts.toEmail,
    alertType: opts.alertType,
  };
  const refused = await sendBudget(db, scope);
  if (refused !== null) throw await refusal(db, refused, opts.refusedMessage);

  const { code, row } = await createVerificationCode(db, {
    userId: opts.userId,
    purpose: opts.purpose,
    mailboxId: opts.mailboxId,
  });
  const { subject, textBody } = opts.email(code);
  const sent = await sendWithRateLimit(db, {
    userId: opts.userId,
    alertType: opts.alertType,
    to: opts.toEmail,
    subject,
    textBody,
    refId: row.id,
  });
  if (sent.rateLimited) {
    // Lost the race at the budget boundary: nothing was mailed, so the code
    // must not stay valid (nor occupy a slot in the active window).
    await db
      .update(verificationCodes)
      .set({ usedAt: new Date() })
      .where(eq(verificationCodes.id, row.id));
    throw await refusal(db, sent.refusal ?? "scope", opts.refusedMessage);
  }
  return row.id;
}

/** The 429 for a refusal, reporting a ceiling trip on the way. */
export async function refusal(db: Db, why: SendRefusal, scopeMessage: string): Promise<HttpError> {
  if (why === "ceiling") {
    await noteCeilingRefusal(db);
    return new HttpError(429, "Too many login emails requested right now, try again later");
  }
  return new HttpError(429, scopeMessage);
}
