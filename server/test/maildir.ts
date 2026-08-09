/**
 * Maildir assertions for story tests.
 *
 * The fake peers deliver one file per message into
 * {MAILDIR_ROOT}/{domain}/{localpart}/new/. Tests never reset mailboxes:
 * every test stamps an X-Virtu-Test-Id header on what it sends and locates
 * its own messages by scanning for that id, so suites are order-independent
 * and parallel-safe against a shared, dirty spool.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { maildirPath, type Mailbox, type Persona } from "./personas.ts";

export const TEST_ID_HEADER = "X-Virtu-Test-Id";

/** A message as found on the spool. */
export interface StoredMail {
  path: string;
  /** Raw RFC 5322 bytes, exactly as the peer MTA wrote them. */
  raw: Buffer;
}

export interface WaitForMailOptions {
  timeoutMs?: number;
  pollMs?: number;
}

const MAILDIR_SUBDIRS = ["new", "cur"] as const;

/** All message file paths in a persona's Maildir (never throws if absent). */
export async function listMail(who: Persona | Mailbox | string): Promise<string[]> {
  const base = maildirPath(who);
  const paths: string[] = [];
  for (const sub of MAILDIR_SUBDIRS) {
    const dir = join(base, sub);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue; // mailbox has simply never received mail
    }
    for (const name of names) paths.push(join(dir, name));
  }
  return paths;
}

/** Find the message carrying the given X-Virtu-Test-Id, if delivered yet. */
export async function findMail(
  who: Persona | Mailbox | string,
  testId: string,
): Promise<StoredMail | undefined> {
  for (const path of await listMail(who)) {
    let raw: Buffer;
    try {
      raw = await readFile(path);
    } catch {
      continue; // delivered/renamed mid-scan; the next poll will see it
    }
    if (getHeader(raw, TEST_ID_HEADER) === testId) return { path, raw };
  }
  return undefined;
}

/**
 * Poll a persona's Maildir until the message stamped with testId arrives.
 * Resolves with the raw bytes; rejects on timeout.
 */
export async function waitForMail(
  who: Persona | Mailbox | string,
  testId: string,
  { timeoutMs = 15_000, pollMs = 250 }: WaitForMailOptions = {},
): Promise<StoredMail> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await findMail(who, testId);
    if (found) return found;
    if (Date.now() >= deadline) {
      const name = typeof who === "string" ? who : maildirPath(who);
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for ${TEST_ID_HEADER}: ${testId} in ${name}`,
      );
    }
    await Bun.sleep(pollMs);
  }
}

/** The raw header block (everything before the first empty line). */
export function headerBlock(raw: Buffer | string): string {
  // latin1 keeps a 1:1 byte↔char mapping — header parsing stays
  // byte-transparent no matter what the body contains.
  const text = typeof raw === "string" ? raw : raw.toString("latin1");
  const end = text.search(/\r?\n\r?\n/);
  return end === -1 ? text : text.slice(0, end);
}

/**
 * All values of a header (case-insensitive), unfolded, in message order.
 * Raw string ops on purpose — no MIME library in the harness.
 */
export function getHeaders(raw: Buffer | string, name: string): string[] {
  const values: string[] = [];
  // Unfold: CRLF/LF followed by WSP is a continuation (RFC 5322 §2.2.3).
  const unfolded = headerBlock(raw).replace(/\r?\n[ \t]/g, " ");
  const wanted = name.toLowerCase();
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    if (line.slice(0, colon).trim().toLowerCase() !== wanted) continue;
    values.push(line.slice(colon + 1).trim());
  }
  return values;
}

/** First value of a header (case-insensitive), or undefined. */
export function getHeader(raw: Buffer | string, name: string): string | undefined {
  return getHeaders(raw, name)[0];
}
