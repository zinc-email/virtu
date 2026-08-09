/**
 * Loopback round-trips: the real client against the real server, including
 * STARTTLS, implicit TLS, AUTH, and byte-for-byte message fidelity.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { connectSmtp, SmtpCommandError } from "./client.ts";
import type { SmtpDataEvent, SmtpServer, SmtpServerOptions } from "./types.ts";
import { makeTestCert } from "./testcert.ts";
import { listen } from "./testutil.ts";

const CERT = makeTestCert();
const TLS_CLIENT = { rejectUnauthorized: false };

let servers: SmtpServer[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});

interface Received {
  events: SmtpDataEvent[];
}

async function setup(
  options: Partial<SmtpServerOptions> = {},
): Promise<{ port: number; received: Received }> {
  const received: Received = { events: [] };
  const { server, port } = await listen({
    hostname: "mx.test.example",
    onData: (event) => {
      received.events.push(event);
      return { accept: true, message: `queued as m${received.events.length}` };
    },
    ...options,
  });
  servers.push(server);
  return { port, received };
}

describe("round-trip: plaintext", () => {
  test("basic delivery end to end", async () => {
    const { port, received } = await setup();
    const client = await connectSmtp({ host: "127.0.0.1", port, name: "sender.example" });
    await client.ehlo();
    expect(client.capabilities.has("PIPELINING")).toBe(true);
    expect(client.capabilities.has("8BITMIME")).toBe(true);
    expect(client.capabilities.has("SMTPUTF8")).toBe(true);

    const message = "From: a@x\r\nTo: b@y\r\nSubject: hello\r\n\r\nHi there.\r\n";
    const result = await client.send({
      mailFrom: "a@x.example",
      rcptTo: ["b@y.example", "c@y.example"],
      data: message,
    });
    expect(result.accepted).toBe(true);
    expect(result.mailFrom.code).toBe(250);
    expect(result.rcptTo.every((r) => r.accepted)).toBe(true);
    expect(result.data?.code).toBe(250);
    expect(result.data?.message).toContain("queued as m1");
    await client.quit();

    expect(received.events).toHaveLength(1);
    const event = received.events[0]!;
    expect(event.envelope.mailFrom).toBe("a@x.example");
    expect(event.envelope.rcptTo.map((r) => r.address)).toEqual(["b@y.example", "c@y.example"]);
    expect(event.envelope.heloName).toBe("sender.example");
    expect(event.envelope.tls).toBe(false);
    expect(event.envelope.authUser).toBeUndefined();
    expect(Buffer.from(event.raw).toString()).toBe(message);
    expect(Buffer.from(event.headers).toString()).toBe(
      "From: a@x\r\nTo: b@y\r\nSubject: hello\r\n",
    );
    expect(Buffer.from(event.body).toString()).toBe("Hi there.\r\n");
  });

  test("dot-stuffing round-trips a dotted body byte-for-byte", async () => {
    const { port, received } = await setup();
    const client = await connectSmtp({ host: "127.0.0.1", port });
    await client.ehlo();
    const body =
      "X: 1\r\n" +
      "\r\n" +
      ".\r\n" +
      "..\r\n" +
      ".lines starting with dots\r\n" +
      "....four dots\r\n" +
      "normal\r\n" +
      ". dot space\r\n";
    const result = await client.send({ mailFrom: "a@x", rcptTo: ["b@y"], data: body });
    expect(result.accepted).toBe(true);
    expect(Buffer.from(received.events[0]!.raw).toString()).toBe(body);
    await client.quit();
  });

  test("UTF-8 8-bit body passes through byte-for-byte with SMTPUTF8", async () => {
    const { port, received } = await setup();
    const client = await connectSmtp({ host: "127.0.0.1", port });
    await client.ehlo();
    const message = Buffer.from(
      "From: könig@exämple.test\r\nSubject: héllo → 世界 🌍\r\n\r\nСъешь ещё этих мягких булок.\r\n",
      "utf8",
    );
    const result = await client.send({
      mailFrom: "könig@exämple.test",
      rcptTo: ["b@y.example"],
      data: message,
      mailParams: { SMTPUTF8: true, BODY: "8BITMIME" },
    });
    expect(result.accepted).toBe(true);
    const event = received.events[0]!;
    expect(Buffer.from(event.raw).equals(message)).toBe(true);
    expect(event.envelope.params).toEqual({ SMTPUTF8: true, BODY: "8BITMIME" });
    expect(event.envelope.mailFrom).toBe("könig@exämple.test");
    await client.quit();
  });

  test("SIZE param beyond the limit is refused before DATA", async () => {
    const { port, received } = await setup({ maxMessageSize: 1024 });
    const client = await connectSmtp({ host: "127.0.0.1", port });
    await client.ehlo();
    expect(client.capabilities.get("SIZE")).toBe("1024");
    const result = await client.send({
      mailFrom: "a@x",
      rcptTo: ["b@y"],
      data: "irrelevant\r\n",
      mailParams: { SIZE: "999999" },
    });
    expect(result.accepted).toBe(false);
    expect(result.mailFrom.code).toBe(552);
    expect(result.mailFrom.enhancedCode).toBe("5.3.4");
    expect(received.events).toHaveLength(0);
    await client.quit();
  });

  test("oversized message body gets 552 at end of DATA", async () => {
    const { port, received } = await setup({ maxMessageSize: 512 });
    const client = await connectSmtp({ host: "127.0.0.1", port });
    await client.ehlo();
    const result = await client.send({
      mailFrom: "a@x",
      rcptTo: ["b@y"],
      data: "Subject: big\r\n\r\n" + "x".repeat(2000) + "\r\n",
    });
    expect(result.accepted).toBe(false);
    expect(result.data?.code).toBe(552);
    expect(result.data?.enhancedCode).toBe("5.3.4");
    expect(received.events).toHaveLength(0);
    await client.quit();
  });

  test("two transactions on one connection", async () => {
    const { port, received } = await setup();
    const client = await connectSmtp({ host: "127.0.0.1", port });
    await client.ehlo();
    const r1 = await client.send({ mailFrom: "a@x", rcptTo: ["b@y"], data: "one\r\n" });
    const r2 = await client.send({ mailFrom: "c@x", rcptTo: ["d@y"], data: "two\r\n" });
    expect(r1.accepted).toBe(true);
    expect(r2.accepted).toBe(true);
    expect(received.events.map((e) => e.envelope.mailFrom)).toEqual(["a@x", "c@x"]);
    await client.quit();
  });

  test("per-recipient rejection is reported while others deliver", async () => {
    const { port, received } = await setup({
      onRcptTo: ({ address }) =>
        address.startsWith("nope")
          ? { reject: { code: 550, enhanced: "5.1.1", message: "No such alias" } }
          : { accept: true },
    });
    const client = await connectSmtp({ host: "127.0.0.1", port });
    await client.ehlo();
    const result = await client.send({
      mailFrom: "a@x",
      rcptTo: ["nope@y", "yes@y"],
      data: "hi\r\n",
    });
    expect(result.accepted).toBe(true);
    expect(result.rcptTo[0]).toMatchObject({ accepted: false });
    expect(result.rcptTo[0]!.reply.code).toBe(550);
    expect(result.rcptTo[0]!.reply.enhancedCode).toBe("5.1.1");
    expect(result.rcptTo[1]).toMatchObject({ accepted: true });
    expect(received.events[0]!.envelope.rcptTo.map((r) => r.address)).toEqual(["yes@y"]);
    await client.quit();
  });
});

describe("round-trip: TLS", () => {
  const auth = (event: { username: string; password: string }) =>
    event.username === "wes" && event.password === "s3cret"
      ? ({ accept: true } as const)
      : ({ reject: { code: 535, enhanced: "5.7.8", message: "Bad credentials" } } as const);

  test("STARTTLS upgrade, then AUTH PLAIN, then delivery", async () => {
    const { port, received } = await setup({ tls: CERT, onAuth: auth });
    const client = await connectSmtp({ host: "127.0.0.1", port, tls: TLS_CLIENT });
    await client.ehlo();
    expect(client.capabilities.has("STARTTLS")).toBe(true);
    // requireAuthTls defaults to true when tls is configured => no AUTH yet.
    expect(client.capabilities.has("AUTH")).toBe(false);

    await client.startTls();
    expect(client.secure).toBe(true);
    // Re-EHLO happened inside startTls; capabilities were replaced.
    expect(client.capabilities.has("STARTTLS")).toBe(false);
    expect(client.capabilities.get("AUTH")).toBe("PLAIN LOGIN");

    const authReply = await client.auth({ username: "wes", password: "s3cret" });
    expect(authReply.code).toBe(235);

    const result = await client.send({ mailFrom: "wes@x", rcptTo: ["b@y"], data: "secret\r\n" });
    expect(result.accepted).toBe(true);
    const event = received.events[0]!;
    expect(event.envelope.tls).toBe(true);
    expect(event.envelope.authUser).toBe("wes");
    await client.quit();
  });

  test("AUTH before STARTTLS is refused with 538 when TLS is required", async () => {
    const { port } = await setup({ tls: CERT, onAuth: auth });
    const client = await connectSmtp({ host: "127.0.0.1", port, tls: TLS_CLIENT });
    await client.ehlo();
    expect.assertions(2);
    try {
      await client.auth({ username: "wes", password: "s3cret" });
    } catch (err) {
      expect(err).toBeInstanceOf(SmtpCommandError);
      expect((err as SmtpCommandError).reply.code).toBe(538);
    }
    await client.quit();
  });

  test("AUTH LOGIN over STARTTLS, and bad credentials are 535", async () => {
    const { port } = await setup({ tls: CERT, onAuth: auth });
    const client = await connectSmtp({ host: "127.0.0.1", port, tls: TLS_CLIENT });
    await client.ehlo();
    await client.startTls();
    const ok = await client.auth({ username: "wes", password: "s3cret", mechanism: "LOGIN" });
    expect(ok.code).toBe(235);
    await client.quit();

    const client2 = await connectSmtp({ host: "127.0.0.1", port, tls: TLS_CLIENT });
    await client2.ehlo();
    await client2.startTls();
    expect.assertions(3);
    try {
      await client2.auth({ username: "wes", password: "wrong", mechanism: "LOGIN" });
    } catch (err) {
      expect(err).toBeInstanceOf(SmtpCommandError);
      expect((err as SmtpCommandError).reply.code).toBe(535);
    }
    await client2.quit();
  });

  test("implicit TLS (465-style) delivery", async () => {
    const { port, received } = await setup({ tls: CERT, implicitTls: true, onAuth: auth });
    const client = await connectSmtp({
      host: "127.0.0.1",
      port,
      implicitTls: true,
      tls: TLS_CLIENT,
    });
    expect(client.secure).toBe(true);
    await client.ehlo();
    // Already secure: STARTTLS is not advertised, AUTH is.
    expect(client.capabilities.has("STARTTLS")).toBe(false);
    expect(client.capabilities.get("AUTH")).toBe("PLAIN LOGIN");
    await client.auth({ username: "wes", password: "s3cret" });
    const result = await client.send({ mailFrom: "wes@x", rcptTo: ["b@y"], data: "over tls\r\n" });
    expect(result.accepted).toBe(true);
    expect(received.events[0]!.envelope.tls).toBe(true);
    await client.quit();
  });

  test("dotted UTF-8 body survives a STARTTLS session byte-for-byte", async () => {
    const { port, received } = await setup({ tls: CERT });
    const client = await connectSmtp({ host: "127.0.0.1", port, tls: TLS_CLIENT });
    await client.ehlo();
    await client.startTls();
    const body = "Subject: über\r\n\r\n.начало\r\n..двойной\r\nконец 🎉\r\n";
    const result = await client.send({ mailFrom: "a@x", rcptTo: ["b@y"], data: body });
    expect(result.accepted).toBe(true);
    expect(Buffer.from(received.events[0]!.raw).toString("utf8")).toBe(body);
    await client.quit();
  });
});
