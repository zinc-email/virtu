import { afterEach, describe, expect, test } from "bun:test";
import { SmtpClientError, SmtpCommandError, connectSmtp } from "./client.ts";
import { hostileServer } from "./testutil.ts";

let closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers) close();
  closers = [];
});

async function serve(handler: Parameters<typeof hostileServer>[0]): Promise<number> {
  const { port, close } = await hostileServer(handler);
  closers.push(close);
  return port;
}

describe("smtp client vs hostile server", () => {
  test("parses multiline replies and capabilities", async () => {
    const port = await serve(async (conn) => {
      conn.write("220 fake.example ESMTP\r\n");
      await conn.nextLine(); // EHLO
      conn.write(
        "250-fake.example greets you\r\n250-PIPELINING\r\n250-SIZE 5000\r\n250 AUTH PLAIN LOGIN\r\n",
      );
      await conn.nextLine(); // QUIT
      conn.write("221 2.0.0 Bye\r\n");
    });
    const client = await connectSmtp({ host: "127.0.0.1", port, name: "me.example" });
    expect(client.greeting.code).toBe(220);
    const r = await client.ehlo();
    expect(r.lines).toEqual([
      "fake.example greets you",
      "PIPELINING",
      "SIZE 5000",
      "AUTH PLAIN LOGIN",
    ]);
    expect(client.capabilities.get("SIZE")).toBe("5000");
    expect(client.capabilities.get("AUTH")).toBe("PLAIN LOGIN");
    await client.quit();
  });

  test("transient 421 greeting throws SmtpCommandError carrying the reply", async () => {
    const port = await serve(async (conn) => {
      conn.write("421 4.3.2 fake.example Service not available\r\n");
    });
    expect.assertions(3);
    try {
      await connectSmtp({ host: "127.0.0.1", port });
    } catch (err) {
      expect(err).toBeInstanceOf(SmtpCommandError);
      const e = err as SmtpCommandError;
      expect(e.reply.code).toBe(421);
      expect(e.reply.enhancedCode).toBe("4.3.2");
    }
  });

  test("transient 450 on RCPT is reported per recipient, not thrown", async () => {
    const port = await serve(async (conn) => {
      conn.write("220 fake ESMTP\r\n");
      await conn.nextLine();
      conn.write("250 fake\r\n");
      await conn.nextLine(); // MAIL
      conn.write("250 2.1.0 Ok\r\n");
      await conn.nextLine(); // RCPT 1
      conn.write("450 4.2.1 Mailbox busy\r\n");
      await conn.nextLine(); // RCPT 2
      conn.write("550 5.1.1 No such user\r\n");
      await conn.nextLine(); // RCPT 3
      conn.write("250 2.1.5 Ok\r\n");
      await conn.nextLine(); // DATA
      conn.write("354 go\r\n");
      for (;;) {
        const line = await conn.nextLine();
        if (line === ".") break;
      }
      conn.write("250 2.6.0 Accepted\r\n");
    });
    const client = await connectSmtp({ host: "127.0.0.1", port });
    await client.ehlo();
    const result = await client.send({
      mailFrom: "from@x.example",
      rcptTo: ["busy@y.example", "gone@y.example", "ok@y.example"],
      data: "Subject: t\r\n\r\nhi\r\n",
    });
    expect(result.accepted).toBe(true);
    expect(result.rcptTo.map((r) => [r.accepted, r.reply.code, r.reply.enhancedCode])).toEqual([
      [false, 450, "4.2.1"],
      [false, 550, "5.1.1"],
      [true, 250, "2.1.5"],
    ]);
    expect(result.data?.code).toBe(250);
    client.close();
  });

  test("MAIL FROM refusal short-circuits without RCPT", async () => {
    const port = await serve(async (conn) => {
      conn.write("220 fake ESMTP\r\n");
      await conn.nextLine();
      conn.write("250 fake\r\n");
      await conn.nextLine(); // MAIL
      conn.write("451 4.7.1 Greylisted, try later\r\n");
    });
    const client = await connectSmtp({ host: "127.0.0.1", port });
    await client.ehlo();
    const result = await client.send({ mailFrom: "a@x", rcptTo: ["b@y"], data: "x\r\n" });
    expect(result.accepted).toBe(false);
    expect(result.mailFrom.code).toBe(451);
    expect(result.mailFrom.enhancedCode).toBe("4.7.1");
    expect(result.rcptTo).toEqual([]);
    expect(result.data).toBeUndefined();
    client.close();
  });

  test("all recipients refused: RSET is sent, DATA never attempted", async () => {
    const commands: string[] = [];
    const port = await serve(async (conn) => {
      conn.write("220 fake ESMTP\r\n");
      commands.push(await conn.nextLine());
      conn.write("250 fake\r\n");
      commands.push(await conn.nextLine());
      conn.write("250 2.1.0 Ok\r\n");
      commands.push(await conn.nextLine());
      conn.write("550 5.1.1 no\r\n");
      commands.push(await conn.nextLine()); // should be RSET
      conn.write("250 2.0.0 Ok\r\n");
    });
    const client = await connectSmtp({ host: "127.0.0.1", port });
    await client.ehlo();
    const result = await client.send({ mailFrom: "a@x", rcptTo: ["b@y"], data: "x\r\n" });
    expect(result.accepted).toBe(false);
    expect(result.data).toBeUndefined();
    expect(commands.at(-1)).toBe("RSET");
    client.close();
  });

  test("connection drop mid-DATA throws SmtpClientError(CLOSED)", async () => {
    const port = await serve(async (conn) => {
      conn.write("220 fake ESMTP\r\n");
      await conn.nextLine();
      conn.write("250 fake\r\n");
      await conn.nextLine();
      conn.write("250 Ok\r\n");
      await conn.nextLine();
      conn.write("250 Ok\r\n");
      await conn.nextLine(); // DATA
      conn.write("354 go\r\n");
      await conn.nextLine(); // first data line, then yank the cable
      conn.destroy();
    });
    const client = await connectSmtp({ host: "127.0.0.1", port });
    await client.ehlo();
    expect.assertions(2);
    try {
      await client.send({ mailFrom: "a@x", rcptTo: ["b@y"], data: "line1\r\nline2\r\n" });
    } catch (err) {
      expect(err).toBeInstanceOf(SmtpClientError);
      expect((err as SmtpClientError).kind).toBe("CLOSED");
    }
    client.close();
  });

  test("reply timeout throws SmtpClientError(TIMEOUT)", async () => {
    const port = await serve(async (conn) => {
      conn.write("220 fake ESMTP\r\n");
      await conn.nextLine(); // EHLO — never reply
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    });
    const client = await connectSmtp({ host: "127.0.0.1", port, timeoutMs: 150 });
    expect.assertions(2);
    try {
      await client.ehlo();
    } catch (err) {
      expect(err).toBeInstanceOf(SmtpClientError);
      expect((err as SmtpClientError).kind).toBe("TIMEOUT");
    }
  });

  test("EHLO 500 falls back to HELO", async () => {
    const port = await serve(async (conn) => {
      conn.write("220 ancient ESMTP\r\n");
      const first = await conn.nextLine();
      if (first.startsWith("EHLO")) conn.write("500 what\r\n");
      const second = await conn.nextLine();
      if (second.startsWith("HELO")) conn.write("250 ancient\r\n");
    });
    const client = await connectSmtp({ host: "127.0.0.1", port });
    const r = await client.ehlo();
    expect(r.code).toBe(250);
    expect(client.capabilities.size).toBe(0);
    client.close();
  });

  test("dot-stuffing on the wire", async () => {
    const dataLines: string[] = [];
    const port = await serve(async (conn) => {
      conn.write("220 fake ESMTP\r\n");
      await conn.nextLine();
      conn.write("250 fake\r\n");
      await conn.nextLine();
      conn.write("250 Ok\r\n");
      await conn.nextLine();
      conn.write("250 Ok\r\n");
      await conn.nextLine();
      conn.write("354 go\r\n");
      for (;;) {
        const line = await conn.nextLine();
        if (line === ".") break;
        dataLines.push(line);
      }
      conn.write("250 Accepted\r\n");
    });
    const client = await connectSmtp({ host: "127.0.0.1", port });
    await client.ehlo();
    await client.send({ mailFrom: "a@x", rcptTo: ["b@y"], data: ".start\r\nmid\r\n..two\r\n" });
    expect(dataLines).toEqual(["..start", "mid", "...two"]);
    client.close();
  });
});

describe("smtp client bounds what a hostile server can make it hold (review round 3)", () => {
  test("an endless multiline greeting is a protocol error, not a memory hog", async () => {
    const port = await serve(async (conn) => {
      const line = `220-${"g".repeat(1000)}\r\n`;
      for (let i = 0; i < 5000; i++) {
        if (conn.socket.destroyed) return;
        conn.write(line);
        if (i % 50 === 0) await new Promise((r) => setTimeout(r, 1));
      }
    });
    const started = Date.now();
    expect.assertions(3);
    try {
      await connectSmtp({ host: "127.0.0.1", port, timeoutMs: 5000 });
    } catch (err) {
      expect(err).toBeInstanceOf(SmtpClientError);
      expect((err as SmtpClientError).kind).toBe("PROTOCOL");
      expect(Date.now() - started).toBeLessThan(2000);
    }
  });

  test("a reply that never ends its line is cut at the buffer cap", async () => {
    const port = await serve(async (conn) => {
      conn.write("220 fake ESMTP\r\n");
      await conn.nextLine(); // EHLO
      const chunk = "2".repeat(16 * 1024);
      for (let i = 0; i < 64; i++) {
        if (conn.socket.destroyed) return;
        conn.write(chunk);
        await new Promise((r) => setTimeout(r, 1));
      }
    });
    const client = await connectSmtp({ host: "127.0.0.1", port, timeoutMs: 5000 });
    expect.assertions(2);
    try {
      await client.ehlo();
    } catch (err) {
      expect(err).toBeInstanceOf(SmtpClientError);
      expect((err as SmtpClientError).kind).toBe("PROTOCOL");
    }
  });

  test("bytes nobody asked for are bounded too", async () => {
    const port = await serve(async (conn) => {
      conn.write("220 fake ESMTP\r\n");
      await conn.nextLine(); // EHLO
      conn.write("250 fake\r\n");
      // Unsolicited chatter while the client is between commands.
      const chunk = `250-${"n".repeat(1000)}\r\n`;
      for (let i = 0; i < 200; i++) {
        if (conn.socket.destroyed) return;
        conn.write(chunk);
        await new Promise((r) => setTimeout(r, 1));
      }
    });
    const client = await connectSmtp({ host: "127.0.0.1", port, timeoutMs: 5000 });
    await client.ehlo();
    await new Promise((r) => setTimeout(r, 500));
    expect.assertions(2);
    try {
      await client.ehlo();
    } catch (err) {
      expect(err).toBeInstanceOf(SmtpClientError);
      expect((err as SmtpClientError).kind).toBe("CLOSED");
    }
  });
});
