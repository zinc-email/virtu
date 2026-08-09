import { afterEach, describe, expect, test } from "bun:test";
import type { SmtpDataEvent, SmtpServer, SmtpServerOptions } from "./types.ts";
import { RawClient, listen } from "./testutil.ts";

const HOST = "mx.test.example";

let servers: SmtpServer[] = [];
let clients: RawClient[] = [];

afterEach(async () => {
  for (const c of clients) c.end();
  clients = [];
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});

async function setup(options: Partial<SmtpServerOptions> = {}) {
  const { server, port } = await listen({ hostname: HOST, ...options });
  servers.push(server);
  const client = await RawClient.connect(port);
  clients.push(client);
  await client.waitFor(/^220 /);
  return { server, port, client };
}

describe("smtp server: greeting and EHLO", () => {
  test("greets with hostname and banner", async () => {
    const { server } = await listen({ hostname: HOST, banner: "virtu" });
    servers.push(server);
    const client = await RawClient.connect(server.address()!.port);
    clients.push(client);
    const greeting = await client.waitFor(/^220 /);
    expect(greeting).toBe(`220 ${HOST} ESMTP virtu`);
  });

  test("EHLO advertises extensions as a multiline reply", async () => {
    const { client } = await setup({ maxMessageSize: 12345, onAuth: () => ({ accept: true }) });
    client.write("EHLO client.example\r\n");
    await client.waitFor(/^250 /);
    expect(client.all).toContain(`250-${HOST}\r\n`);
    expect(client.all).toContain("250-PIPELINING\r\n");
    expect(client.all).toContain("250-SIZE 12345\r\n");
    expect(client.all).toContain("250-8BITMIME\r\n");
    expect(client.all).toContain("250-SMTPUTF8\r\n");
    expect(client.all).toContain("250-ENHANCEDSTATUSCODES\r\n");
    // no tls configured => no STARTTLS; requireAuthTls defaults false w/o tls
    expect(client.all).not.toContain("STARTTLS");
    expect(client.all).toContain("AUTH PLAIN LOGIN");
  });

  test("HELO gets a single-line reply", async () => {
    const { client } = await setup();
    client.write("HELO x\r\n");
    const line = await client.waitFor(/^250/);
    expect(line).toBe(`250 ${HOST}`);
  });

  test("EHLO without a name is a syntax error", async () => {
    const { client } = await setup();
    client.write("EHLO\r\n");
    await client.waitFor(/^501 5\.5\.4/);
  });

  test("onEhlo can reject", async () => {
    const { client } = await setup({
      onEhlo: ({ heloName }) =>
        heloName === "bad.example"
          ? { reject: { code: 550, enhanced: "5.7.1", message: "go away" } }
          : { accept: true },
    });
    client.write("EHLO bad.example\r\n");
    await client.waitFor(/^550 5\.7\.1 go away/);
    client.write("EHLO good.example\r\n");
    await client.waitFor(/^250 /);
  });

  test("onConnect rejection refuses everything except QUIT", async () => {
    const { server } = await listen({
      hostname: HOST,
      onConnect: () => ({ reject: { code: 554, enhanced: "5.7.1", message: "blocked" } }),
    });
    servers.push(server);
    const client = await RawClient.connect(server.address()!.port);
    clients.push(client);
    await client.waitFor(/^554 5\.7\.1 blocked/);
    client.write("EHLO x\r\n");
    await client.waitFor(/^503 5\.5\.1/);
    client.write("QUIT\r\n");
    await client.waitFor(/^221 /);
    await client.waitForClose();
  });
});

describe("smtp server: command sequencing", () => {
  test("MAIL before EHLO is out of sequence", async () => {
    const { client } = await setup();
    client.write("MAIL FROM:<a@b.c>\r\n");
    await client.waitFor(/^503 5\.5\.1/);
  });

  test("RCPT before MAIL is out of sequence", async () => {
    const { client } = await setup();
    client.write("EHLO x\r\n");
    await client.waitFor(/^250 /);
    client.write("RCPT TO:<a@b.c>\r\n");
    await client.waitFor(/^503 5\.5\.1/);
  });

  test("DATA before RCPT is out of sequence", async () => {
    const { client } = await setup();
    client.write("EHLO x\r\n");
    await client.waitFor(/^250 /);
    client.write("MAIL FROM:<a@b.c>\r\nDATA\r\n");
    await client.waitFor(/^250 2\.1\.0/);
    await client.waitFor(/^503 5\.5\.1/);
  });

  test("nested MAIL is rejected", async () => {
    const { client } = await setup();
    client.write("EHLO x\r\nMAIL FROM:<a@b.c>\r\nMAIL FROM:<d@e.f>\r\n");
    await client.waitFor(/^250 2\.1\.0/);
    await client.waitFor(/^503 5\.5\.1/);
  });

  test("RSET clears the transaction", async () => {
    const rcpts: string[] = [];
    const { client } = await setup({
      onRcptTo: ({ address }) => {
        rcpts.push(address);
        return { accept: true };
      },
    });
    client.write("EHLO x\r\nMAIL FROM:<a@b.c>\r\nRCPT TO:<r1@b.c>\r\nRSET\r\n");
    await client.waitFor(/^250 2\.0\.0 Ok/);
    // After RSET, RCPT is out of sequence again (no MAIL).
    client.write("RCPT TO:<r2@b.c>\r\n");
    await client.waitFor(/^503 5\.5\.1/);
    // ...but a fresh MAIL works.
    client.write("MAIL FROM:<a@b.c>\r\nRCPT TO:<r3@b.c>\r\n");
    await client.waitFor(/^250 2\.1\.5/);
    expect(rcpts).toEqual(["r1@b.c", "r3@b.c"]);
  });

  test("unknown command and VRFY", async () => {
    const { client } = await setup();
    client.write("BANANA\r\n");
    await client.waitFor(/^500 5\.5\.2/);
    client.write("VRFY somebody\r\n");
    await client.waitFor(/^252 2\.0\.0/);
    client.write("NOOP\r\n");
    await client.waitFor(/^250 2\.0\.0/);
    client.write("HELP\r\n");
    await client.waitFor(/^502 5\.5\.1/);
  });
});

describe("smtp server: MAIL parameters", () => {
  async function ehlo(client: RawClient) {
    client.write("EHLO x\r\n");
    await client.waitFor(/^250 /);
  }

  test("SIZE over the maximum is rejected up front", async () => {
    const { client } = await setup({ maxMessageSize: 1000 });
    await ehlo(client);
    client.write("MAIL FROM:<a@b.c> SIZE=1001\r\n");
    await client.waitFor(/^552 5\.3\.4/);
    client.write("MAIL FROM:<a@b.c> SIZE=1000\r\n");
    await client.waitFor(/^250 2\.1\.0/);
  });

  test("BODY and SMTPUTF8 params are accepted and passed to the hook", async () => {
    let seen: Record<string, string | true> = {};
    const { client } = await setup({
      onMailFrom: ({ params }) => {
        seen = params;
        return { accept: true };
      },
    });
    await ehlo(client);
    client.write("MAIL FROM:<a@b.c> BODY=8BITMIME SMTPUTF8\r\n");
    await client.waitFor(/^250 2\.1\.0/);
    expect(seen).toEqual({ BODY: "8BITMIME", SMTPUTF8: true });
  });

  test("unknown MAIL params are refused", async () => {
    const { client } = await setup();
    await ehlo(client);
    client.write("MAIL FROM:<a@b.c> WAT=1\r\n");
    await client.waitFor(/^555 5\.5\.4/);
  });

  test("null reverse-path is accepted", async () => {
    const { client } = await setup();
    await ehlo(client);
    client.write("MAIL FROM:<>\r\n");
    await client.waitFor(/^250 2\.1\.0/);
  });

  test("bad sender syntax is a 501", async () => {
    const { client } = await setup();
    await ehlo(client);
    client.write("MAIL FROM:<oops\r\n");
    await client.waitFor(/^501 5\.1\.7/);
  });

  test("source routes are stripped", async () => {
    let seen = "";
    const { client } = await setup({
      onMailFrom: ({ address }) => {
        seen = address;
        return { accept: true };
      },
    });
    await ehlo(client);
    client.write("MAIL FROM:<@relay.example:real@dom.example>\r\n");
    await client.waitFor(/^250 2\.1\.0/);
    expect(seen).toBe("real@dom.example");
  });

  test("maxRecipients is enforced with 452", async () => {
    const { client } = await setup({ maxRecipients: 2 });
    await ehlo(client);
    client.write(
      "MAIL FROM:<a@b.c>\r\nRCPT TO:<r1@b.c>\r\nRCPT TO:<r2@b.c>\r\nRCPT TO:<r3@b.c>\r\n",
    );
    await client.waitFor(/^250 2\.1\.5/);
    await client.waitFor(/^250 2\.1\.5/);
    await client.waitFor(/^452 4\.5\.3/);
  });
});

describe("smtp server: DATA", () => {
  test("pipelined envelope + data in one write round-trips", async () => {
    let got: SmtpDataEvent | null = null;
    const { client } = await setup({
      onData: (event) => {
        got = event;
        return { accept: true, message: "queued as t1" };
      },
    });
    client.write(
      "EHLO pipeliner\r\n" +
        "MAIL FROM:<a@b.c>\r\n" +
        "RCPT TO:<r@b.c>\r\n" +
        "DATA\r\n" +
        "Subject: hi\r\n" +
        "\r\n" +
        "body line\r\n" +
        ".\r\n" +
        "QUIT\r\n",
    );
    await client.waitFor(/^250 2\.6\.0 queued as t1/);
    await client.waitFor(/^221 /);
    const event = got! as SmtpDataEvent;
    expect(event.envelope.heloName).toBe("pipeliner");
    expect(event.envelope.mailFrom).toBe("a@b.c");
    expect(event.envelope.rcptTo.map((r) => r.address)).toEqual(["r@b.c"]);
    expect(event.envelope.tls).toBe(false);
    expect(Buffer.from(event.headers).toString()).toBe("Subject: hi\r\n");
    expect(Buffer.from(event.body).toString()).toBe("body line\r\n");
    expect(Buffer.from(event.raw).toString()).toBe("Subject: hi\r\n\r\nbody line\r\n");
  });

  test("bare-LF input is normalized to CRLF", async () => {
    let raw = "";
    const { client } = await setup({
      onData: (event) => {
        raw = Buffer.from(event.raw).toString();
        return { accept: true };
      },
    });
    client.write("EHLO x\nMAIL FROM:<a@b.c>\nRCPT TO:<r@b.c>\nDATA\nX: 1\n\nhello\n.\n");
    await client.waitFor(/^250 2\.6\.0/);
    expect(raw).toBe("X: 1\r\n\r\nhello\r\n");
  });

  test("oversized DATA gets 552 after the terminator", async () => {
    let called = false;
    const { client } = await setup({
      maxMessageSize: 100,
      onData: () => {
        called = true;
        return { accept: true };
      },
    });
    client.write("EHLO x\r\nMAIL FROM:<a@b.c>\r\nRCPT TO:<r@b.c>\r\nDATA\r\n");
    await client.waitFor(/^354 /);
    client.write("x".repeat(200) + "\r\n.\r\n");
    await client.waitFor(/^552 5\.3\.4/);
    expect(called).toBe(false);
    // The connection remains usable for a new transaction.
    client.write("MAIL FROM:<a@b.c>\r\n");
    await client.waitFor(/^250 2\.1\.0/);
  });

  test("overlong DATA line gets 500 5.6.0", async () => {
    const { client } = await setup({ maxDataLineLength: 50 });
    client.write("EHLO x\r\nMAIL FROM:<a@b.c>\r\nRCPT TO:<r@b.c>\r\nDATA\r\n");
    await client.waitFor(/^354 /);
    client.write("y".repeat(80) + "\r\n.\r\n");
    await client.waitFor(/^500 5\.6\.0/);
  });

  test("onData rejection is delivered and the transaction resets", async () => {
    const { client } = await setup({
      onData: () => ({ reject: { code: 554, enhanced: "5.7.1", message: "rejected content" } }),
    });
    client.write("EHLO x\r\nMAIL FROM:<a@b.c>\r\nRCPT TO:<r@b.c>\r\nDATA\r\nhm\r\n.\r\n");
    await client.waitFor(/^554 5\.7\.1 rejected content/);
    client.write("MAIL FROM:<a@b.c>\r\n");
    await client.waitFor(/^250 2\.1\.0/);
  });

  test("command line too long is refused and input resyncs", async () => {
    const { client } = await setup();
    client.write("EHLO x\r\n");
    await client.waitFor(/^250 /);
    client.write("MAIL FROM:<" + "a".repeat(3000) + "@b.c>\r\nNOOP\r\n");
    await client.waitFor(/^500 5\.5\.2/);
    await client.waitFor(/^250 2\.0\.0/);
  });
});

describe("smtp server: limits and timeouts", () => {
  test("too many errors gets 421 and a disconnect", async () => {
    const { client } = await setup({ maxErrors: 2 });
    client.write("WAT\r\nWAT\r\nWAT\r\n");
    await client.waitFor(/^500 /);
    await client.waitFor(/^500 /);
    await client.waitFor(/^500 /);
    await client.waitFor(/^421 4\.7\.0/);
    await client.waitForClose();
  });

  test("command timeout gets 421 4.4.2 and a disconnect", async () => {
    const { client } = await setup({ commandTimeoutMs: 120 });
    await client.waitFor(/^421 4\.4\.2/, 3000);
    await client.waitForClose();
  });

  test("DATA timeout uses dataTimeoutMs", async () => {
    const { client } = await setup({ commandTimeoutMs: 60_000, dataTimeoutMs: 120 });
    client.write("EHLO x\r\nMAIL FROM:<a@b.c>\r\nRCPT TO:<r@b.c>\r\nDATA\r\n");
    await client.waitFor(/^354 /);
    client.write("partial line never finishes");
    await client.waitFor(/^421 4\.4\.2/, 3000);
    await client.waitForClose();
  });
});

describe("smtp server: STARTTLS edge cases", () => {
  test("STARTTLS without TLS configured is not implemented", async () => {
    const { client } = await setup();
    client.write("EHLO x\r\n");
    await client.waitFor(/^250 /);
    client.write("STARTTLS\r\n");
    await client.waitFor(/^502 5\.5\.1/);
  });

  test("abandoning the connection after STARTTLS cleans up server side", async () => {
    const { makeTestCert } = await import("./testcert.ts");
    const { client, server } = await setup({ tls: makeTestCert() });
    client.write("EHLO x\r\n");
    await client.waitFor(/^250 /);
    client.write("STARTTLS\r\n");
    await client.waitFor(/^220 2\.0\.0/);
    // Never start the handshake; just hang up.
    client.end();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await server.close(); // must not hang on the orphaned upgrade
  });
});

describe("smtp server: AUTH (plaintext dev mode)", () => {
  const authOpts: Partial<SmtpServerOptions> = {
    onAuth: ({ username, password }) =>
      username === "wes" && password === "s3cret"
        ? { accept: true }
        : { reject: { code: 535, enhanced: "5.7.8", message: "Bad credentials" } },
  };

  test("AUTH PLAIN initial-response success sets authUser", async () => {
    let user: string | undefined;
    const { client } = await setup({
      ...authOpts,
      onMailFrom: ({ session }) => {
        user = session.authUser;
        return { accept: true };
      },
    });
    client.write("EHLO x\r\n");
    await client.waitFor(/^250 /);
    const b64 = Buffer.from("\0wes\0s3cret", "utf8").toString("base64");
    client.write(`AUTH PLAIN ${b64}\r\n`);
    await client.waitFor(/^235 2\.7\.0/);
    client.write("MAIL FROM:<a@b.c>\r\n");
    await client.waitFor(/^250 2\.1\.0/);
    expect(user).toBe("wes");
  });

  test("AUTH PLAIN challenge form works", async () => {
    const { client } = await setup(authOpts);
    client.write("EHLO x\r\n");
    await client.waitFor(/^250 /);
    client.write("AUTH PLAIN\r\n");
    await client.waitFor(/^334/);
    client.write(Buffer.from("\0wes\0s3cret", "utf8").toString("base64") + "\r\n");
    await client.waitFor(/^235 2\.7\.0/);
  });

  test("AUTH PLAIN failure is 535", async () => {
    const { client } = await setup(authOpts);
    client.write("EHLO x\r\n");
    await client.waitFor(/^250 /);
    client.write("AUTH PLAIN " + Buffer.from("\0wes\0wrong").toString("base64") + "\r\n");
    await client.waitFor(/^535 5\.7\.8/);
  });

  test("AUTH LOGIN dialog success and abort", async () => {
    const { client } = await setup(authOpts);
    client.write("EHLO x\r\n");
    await client.waitFor(/^250 /);
    client.write("AUTH LOGIN\r\n");
    await client.waitFor(/^334 VXNlcm5hbWU6/);
    client.write(Buffer.from("wes").toString("base64") + "\r\n");
    await client.waitFor(/^334 UGFzc3dvcmQ6/);
    client.write(Buffer.from("s3cret").toString("base64") + "\r\n");
    await client.waitFor(/^235 2\.7\.0/);
    // Second AUTH after success is refused.
    client.write("AUTH LOGIN\r\n");
    await client.waitFor(/^503 5\.5\.1/);
  });

  test("AUTH LOGIN abort with *", async () => {
    const { client } = await setup(authOpts);
    client.write("EHLO x\r\n");
    await client.waitFor(/^250 /);
    client.write("AUTH LOGIN\r\n");
    await client.waitFor(/^334 /);
    client.write("*\r\n");
    await client.waitFor(/^501 5\.7\.0/);
  });

  test("bad base64 is 501 5.5.2", async () => {
    const { client } = await setup(authOpts);
    client.write("EHLO x\r\n");
    await client.waitFor(/^250 /);
    client.write("AUTH PLAIN !!!\r\n");
    await client.waitFor(/^501 5\.5\.2/);
  });

  test("AUTH before EHLO is out of sequence", async () => {
    const { client } = await setup(authOpts);
    client.write("AUTH PLAIN\r\n");
    await client.waitFor(/^503 5\.5\.1/);
  });

  test("AUTH without an onAuth hook is not implemented", async () => {
    const { client } = await setup();
    client.write("EHLO x\r\n");
    await client.waitFor(/^250 /);
    client.write("AUTH PLAIN\r\n");
    await client.waitFor(/^502 5\.5\.1/);
  });

  test("unsupported mechanism is 504", async () => {
    const { client } = await setup(authOpts);
    client.write("EHLO x\r\n");
    await client.waitFor(/^250 /);
    client.write("AUTH CRAM-MD5\r\n");
    await client.waitFor(/^504 5\.5\.4/);
  });
});
