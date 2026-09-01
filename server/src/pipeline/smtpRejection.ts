/**
 * smtp_rejections writer (PLAN Lane K P2): every SMTP-time refusal from mx
 * and submission lands as one append-only row — the raw feed for abuse
 * forensics and Lane K P3's per-IP throttling. RCPT/DATA rejects previously
 * wrote nothing.
 *
 * Recording must never affect the SMTP conversation: a failed insert logs a
 * warning and the reject reply goes out regardless.
 */

import type { Db } from "../db/index.ts";
import {
  type SmtpRejectionEntrypoint,
  type SmtpRejectionPhase,
  smtpRejections,
} from "../db/schema.ts";
import type { Logger } from "../log.ts";
import { smtpRejectionsTotal } from "../metrics/index.ts";
import type { SmtpRejection } from "../smtp/index.ts";

export interface SmtpRejectionInput {
  entrypoint: SmtpRejectionEntrypoint;
  phase: SmtpRejectionPhase;
  remoteAddress: string;
  heloName?: string | null;
  /** Envelope context as far as the session got. */
  mailFrom?: string | null;
  /** The refused recipient — or every accepted one, for a DATA-time reject. */
  rcptTo?: string | null;
  /** The authenticated user, when the session had one (submission). */
  userId?: number | null;
  /** The reply sent to the peer. */
  reject: SmtpRejection;
}

const clip = (v: string | null | undefined, max: number): string | null =>
  v == null || v === "" ? null : v.slice(0, max);

/** Record one refusal; swallows (and logs) its own failures. */
export async function recordSmtpRejection(
  db: Db,
  input: SmtpRejectionInput,
  log?: Logger,
): Promise<void> {
  smtpRejectionsTotal.inc({ entrypoint: input.entrypoint, phase: input.phase });
  try {
    await db.insert(smtpRejections).values({
      entrypoint: input.entrypoint,
      phase: input.phase,
      remoteAddress: input.remoteAddress.slice(0, 64),
      heloName: clip(input.heloName, 256),
      mailFrom: input.mailFrom == null || input.mailFrom === "" ? null : input.mailFrom,
      rcptTo: clip(input.rcptTo, 4096),
      smtpCode: input.reject.code,
      enhancedCode: clip(input.reject.enhanced, 16),
      reason: input.reject.message.slice(0, 256),
      userId: input.userId ?? null,
    });
  } catch (err) {
    log?.warn("smtp_rejection_record_failed", {
      phase: `${input.entrypoint}/${input.phase}`,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
