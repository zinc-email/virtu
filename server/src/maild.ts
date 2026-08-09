/**
 * maild — single-process mail daemon for the MVP: starts mx (25),
 * submission (587 + 465) and deliverd in one Bun process.
 *
 * PLAN lists three separate entrypoints (mx / submission / deliverd) and
 * each still runs standalone (`bun src/mx.ts` etc.); this composite exists
 * because the test network runs everything on one container/IP
 * (mail.virtu.email = 192.168.34.101) and one process is the simplest
 * durable form for that. Scaling out later = running the individual
 * entrypoints on separate boxes; nothing here prevents it.
 */

import { startDeliverd } from "./deliverd.ts";
import { startMx } from "./mx.ts";
import { startSubmission } from "./submission.ts";

async function main(): Promise<void> {
  await startMx();
  await startSubmission();
  startDeliverd();
  console.log("maild: mx + submission + deliverd running");
}

if (import.meta.main) {
  void main();
}
