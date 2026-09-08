/**
 * Submission listener AUTH posture (pre-launch review P1 #5 + P2 bulkhead):
 * without TLS material, AUTH is neither advertised nor accepted unless the
 * dev-only plaintext flag is set; a saturated verify bulkhead refuses before
 * any credential work. Socket-level — no credential rows are ever consulted
 * (the bulkhead test's rejection bookkeeping tolerates a dead db: the
 * recorder swallows its own failures by design).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { db } from "./db/index.ts";
import { RawClient } from "./smtp/testutil.ts";
import { createSubmissionServers, type SubmissionServers } from "./submission.ts";

const base = {
  db,
  mailDomain: "virtu.email",
  mailHostname: "mail.virtu.email",
  dkimSelector: "mail",
  verpSecret: "unit-test-verp-secret-unit-test-verp-secret",
  maxMessageSize: 1024 * 1024,
};

let servers: SubmissionServers | null = null;
const clients: RawClient[] = [];

afterEach(async () => {
  for (const c of clients) c.end();
  clients.length = 0;
  await servers?.starttls.close();
  servers = null;
});

async function ehlo(opts: Partial<Parameters<typeof createSubmissionServers>[0]>) {
  servers = createSubmissionServers({ ...base, ...opts });
  const { port } = await servers.starttls.listen(0, "127.0.0.1");
  const client = await RawClient.connect(port);
  clients.push(client);
  await client.waitFor(/^220 /);
  client.write("EHLO client.example\r\n");
  await client.waitFor(/^250 /);
  return client;
}

describe("submission without TLS", () => {
  test("does not advertise AUTH and refuses it with 538", async () => {
    const client = await ehlo({});
    expect(client.all).not.toContain("AUTH");
    client.write(`AUTH PLAIN ${Buffer.from("\0wes\0pw").toString("base64")}\r\n`);
    const reply = await client.waitFor(/^538 /);
    expect(reply).toContain("5.7.11");
  });

  test("advertises AUTH only under the explicit dev flag", async () => {
    const client = await ehlo({ allowPlaintextAuth: true });
    expect(client.all).toContain("AUTH PLAIN LOGIN");
  });
});

describe("verify bulkhead", () => {
  test("a saturated verify pool answers 454 before any credential work", async () => {
    const client = await ehlo({
      allowPlaintextAuth: true,
      verifyBulkhead: { tryAcquire: () => false, release: () => {}, saturated: () => true },
    });
    client.write(`AUTH PLAIN ${Buffer.from("\0wes\0pw").toString("base64")}\r\n`);
    const reply = await client.waitFor(/^454 /);
    expect(reply).toContain("4.7.0");
  });
});
