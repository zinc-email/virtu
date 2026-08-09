/**
 * Queue insert — the ONLY way messages enter outbound_messages (PLAN Lane
 * D: the queue is the only writer of "sent" state; mx/submission only ever
 * enqueue). One row per envelope recipient so retries and failures stay
 * per-recipient.
 */

import type { Db } from "../db/index.ts";
import { outboundMessages } from "../db/schema.ts";

/** Default size cap, matching the SMTP server's default SIZE. */
export const DEFAULT_MAX_RAW_BYTES = 25 * 1024 * 1024;

export interface EnqueueInput {
  /** Full signed RFC 5322 message bytes. */
  raw: Uint8Array;
  /** VERP return path, or "" for the null reverse path (never bounce a bounce). */
  envelopeFrom: string;
  /** Exactly one recipient per row. */
  envelopeTo: string;
  /** Override the size cap (config.smtpMaxMessageSize). */
  maxRawBytes?: number;
}

/** Insert one queue row; resolves to its id. */
export async function enqueue(db: Db, input: EnqueueInput): Promise<number> {
  const cap = input.maxRawBytes ?? DEFAULT_MAX_RAW_BYTES;
  if (input.raw.length > cap) {
    throw new Error(`enqueue: message of ${input.raw.length} bytes exceeds cap of ${cap}`);
  }
  const rows = await db
    .insert(outboundMessages)
    .values({
      raw: input.raw,
      envelopeFrom: input.envelopeFrom,
      envelopeTo: input.envelopeTo,
    })
    .returning({ id: outboundMessages.id });
  return rows[0]!.id;
}
