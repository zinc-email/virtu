import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import {
  DataDecoder,
  ReplyParser,
  bracket,
  decodeBase64,
  dotStuff,
  formatReply,
  parseCapabilities,
  parseParams,
  parsePath,
  splitMessage,
  takeLine,
} from "./wire.ts";

describe("takeLine", () => {
  test("splits CRLF lines", () => {
    const r = takeLine(Buffer.from("HELO x\r\nrest"));
    expect(r?.line.toString()).toBe("HELO x");
    expect(r?.rest.toString()).toBe("rest");
  });
  test("accepts bare LF", () => {
    const r = takeLine(Buffer.from("NOOP\nrest"));
    expect(r?.line.toString()).toBe("NOOP");
  });
  test("returns null without a full line", () => {
    expect(takeLine(Buffer.from("partial"))).toBeNull();
  });
});

describe("DataDecoder", () => {
  const decode = (input: string, opts?: { maxSize?: number; maxLine?: number }) => {
    const d = new DataDecoder(opts?.maxSize ?? 1_000_000, opts?.maxLine ?? 998);
    const rest = d.push(Buffer.from(input));
    return { d, rest };
  };

  test("unstuffs dots and normalizes CRLF", () => {
    const { d, rest } = decode("hello\r\n..dot\r\nbare\nmore\r\n.\r\nQUIT\r\n");
    expect(rest?.toString()).toBe("QUIT\r\n");
    expect(d.message().toString()).toBe("hello\r\n.dot\r\nbare\r\nmore\r\n");
  });

  // SMTP smuggling (CVE-2023-51764 class): only <CRLF>.<CRLF> may end DATA.
  // A relay that passes bare LF through must not be able to end our DATA
  // early and pipeline a second envelope behind it.
  describe("end-of-data is <CRLF>.<CRLF> only", () => {
    const smuggled = "MAIL FROM:<ceo@relay.example>\r\nRCPT TO:<victim@virtu.email>\r\nDATA\r\n";

    test("<LF>.<LF> is content", () => {
      const { d, rest } = decode(`body\r\n\n.\n${smuggled}`);
      expect(rest).toBeNull();
      expect(d.message().toString()).toBe(`body\r\n\r\n\r\n${smuggled.replace(/\r\n/g, "\r\n")}`);
    });

    test("<CRLF>.<LF> is content", () => {
      const { rest } = decode(`body\r\n.\n${smuggled}`);
      expect(rest).toBeNull();
    });

    test("<LF>.<CRLF> is content", () => {
      const { rest } = decode(`body\n.\r\n${smuggled}`);
      expect(rest).toBeNull();
    });

    test("the real terminator still works after bare-LF content", () => {
      const { d, rest } = decode("body\n.\n\r\n.\r\nQUIT\r\n");
      expect(rest?.toString()).toBe("QUIT\r\n");
      // The smuggled-looking "." was unstuffed to an empty line.
      expect(d.message().toString()).toBe("body\r\n\r\n\r\n");
    });

    test("terminator as the very first line (empty message)", () => {
      const { d, rest } = decode(".\r\nQUIT\r\n");
      expect(rest?.toString()).toBe("QUIT\r\n");
      expect(d.message().length).toBe(0);
    });

    test("terminator split across chunks", () => {
      const d = new DataDecoder(1_000_000, 998);
      expect(d.push(Buffer.from("body\r"))).toBeNull();
      expect(d.push(Buffer.from("\n."))).toBeNull();
      expect(d.push(Buffer.from("\r"))).toBeNull();
      expect(d.push(Buffer.from("\nQUIT\r\n"))?.toString()).toBe("QUIT\r\n");
      expect(d.message().toString()).toBe("body\r\n");
    });
  });

  test("terminator split across pushes", () => {
    const d = new DataDecoder(1000, 998);
    expect(d.push(Buffer.from("line1\r\n."))).toBeNull();
    const rest = d.push(Buffer.from("\r\n"));
    expect(rest?.toString()).toBe("");
    expect(d.message().toString()).toBe("line1\r\n");
  });

  test("empty message", () => {
    const { d, rest } = decode(".\r\n");
    expect(rest?.toString()).toBe("");
    expect(d.message().length).toBe(0);
  });

  test("flags oversized messages but still finds the terminator", () => {
    const { d, rest } = decode("x".repeat(50) + "\r\n" + "y".repeat(50) + "\r\n.\r\n", {
      maxSize: 60,
    });
    expect(rest).not.toBeNull();
    expect(d.tooBig).toBe(true);
    expect(d.message().length).toBe(0); // discarded
  });

  test("flags overlong lines (single push)", () => {
    const { d, rest } = decode("ok\r\n" + "z".repeat(60) + "\r\n.\r\n", { maxLine: 50 });
    expect(rest).not.toBeNull();
    expect(d.lineTooLong).toBe(true);
  });

  test("flags overlong lines split across pushes and recovers terminator", () => {
    const d = new DataDecoder(1_000_000, 50);
    expect(d.push(Buffer.from("z".repeat(40)))).toBeNull();
    expect(d.push(Buffer.from("z".repeat(40)))).toBeNull();
    expect(d.lineTooLong).toBe(true);
    const rest = d.push(Buffer.from("zzz\r\n.\r\nNEXT"));
    expect(rest?.toString()).toBe("NEXT");
  });

  test("a lone dot inside a line is not a terminator", () => {
    const { d, rest } = decode("a . b\r\n.\r\n");
    expect(rest).not.toBeNull();
    expect(d.message().toString()).toBe("a . b\r\n");
  });
});

describe("dotStuff", () => {
  test("stuffs leading dots and normalizes endings", () => {
    expect(dotStuff(Buffer.from(".a\nb\r\n.\n")).toString()).toBe("..a\r\nb\r\n..\r\n");
  });
  test("appends missing trailing CRLF", () => {
    expect(dotStuff(Buffer.from("abc")).toString()).toBe("abc\r\n");
  });
  test("empty input stays empty", () => {
    expect(dotStuff(Buffer.from("")).length).toBe(0);
  });
  test("round-trips through DataDecoder byte-for-byte", () => {
    const body = "A\r\n.\r\n..\r\n.hidden\r\n...deep\r\nend\r\n";
    const wire = dotStuff(Buffer.from(body));
    const d = new DataDecoder(1_000_000, 998);
    const rest = d.push(Buffer.concat([wire, Buffer.from(".\r\n")]));
    expect(rest?.toString()).toBe("");
    expect(d.message().toString()).toBe(body);
  });
});

describe("splitMessage", () => {
  test("splits headers and body at the blank line", () => {
    const raw = Buffer.from("A: 1\r\nB: 2\r\n\r\nbody\r\nmore\r\n");
    const { headers, body } = splitMessage(raw);
    expect(headers.toString()).toBe("A: 1\r\nB: 2\r\n");
    expect(body.toString()).toBe("body\r\nmore\r\n");
  });
  test("no blank line: all headers", () => {
    const { headers, body } = splitMessage(Buffer.from("A: 1\r\n"));
    expect(headers.toString()).toBe("A: 1\r\n");
    expect(body.length).toBe(0);
  });
  test("leading blank line: all body", () => {
    const { headers, body } = splitMessage(Buffer.from("\r\nbody\r\n"));
    expect(headers.length).toBe(0);
    expect(body.toString()).toBe("body\r\n");
  });
});

describe("formatReply", () => {
  test("single line", () => {
    expect(formatReply(250, ["Ok"])).toBe("250 Ok\r\n");
  });
  test("multiline", () => {
    expect(formatReply(250, ["a", "b", "c"])).toBe("250-a\r\n250-b\r\n250 c\r\n");
  });
  test("bare code", () => {
    expect(formatReply(250, [""])).toBe("250\r\n");
  });
});

describe("ReplyParser", () => {
  test("single-line reply with enhanced code", () => {
    const p = new ReplyParser();
    const r = p.feed("250 2.1.0 Ok");
    expect(r).toEqual({
      code: 250,
      enhancedCode: "2.1.0",
      message: "2.1.0 Ok",
      lines: ["2.1.0 Ok"],
    });
  });
  test("multiline reply", () => {
    const p = new ReplyParser();
    expect(p.feed("250-first")).toBeNull();
    expect(p.feed("250-second")).toBeNull();
    const r = p.feed("250 third");
    expect(r?.code).toBe(250);
    expect(r?.lines).toEqual(["first", "second", "third"]);
    expect(r?.message).toBe("first\nsecond\nthird");
  });
  test("bare code line", () => {
    const p = new ReplyParser();
    const r = p.feed("354");
    expect(r?.code).toBe(354);
    expect(r?.enhancedCode).toBeUndefined();
  });
  test("enhanced code class must match reply class", () => {
    const p = new ReplyParser();
    const r = p.feed("550 4.2.1 mismatched");
    expect(r?.enhancedCode).toBeUndefined();
  });
  test("throws on garbage", () => {
    const p = new ReplyParser();
    expect(() => p.feed("BANANA")).toThrow();
  });
});

describe("parseCapabilities", () => {
  test("parses keywords and params, skipping the greeting line", () => {
    const caps = parseCapabilities([
      "mx.example ready",
      "PIPELINING",
      "SIZE 1000",
      "AUTH PLAIN LOGIN",
    ]);
    expect(caps.has("PIPELINING")).toBe(true);
    expect(caps.get("SIZE")).toBe("1000");
    expect(caps.get("AUTH")).toBe("PLAIN LOGIN");
    expect(caps.has("MX.EXAMPLE")).toBe(false);
  });
});

describe("parsePath", () => {
  test("plain path with params", () => {
    expect(parsePath("<a@b.c> SIZE=100 BODY=8BITMIME")).toEqual({
      address: "a@b.c",
      paramString: "SIZE=100 BODY=8BITMIME",
    });
  });
  test("null path", () => {
    expect(parsePath("<>")).toEqual({ address: "", paramString: "" });
  });
  test("space after colon tolerated by caller (leading spaces here)", () => {
    expect(parsePath("  <a@b.c>")?.address).toBe("a@b.c");
  });
  test("source route is stripped", () => {
    expect(parsePath("<@relay1,@relay2:user@dom>")?.address).toBe("user@dom");
  });
  test("quoted local part may contain > and spaces", () => {
    expect(parsePath('<"a > b"@dom>')?.address).toBe('"a > b"@dom');
  });
  test("bare address tolerated", () => {
    expect(parsePath("user@dom")?.address).toBe("user@dom");
  });
  test("unterminated bracket fails", () => {
    expect(parsePath("<a@b")).toBeNull();
  });
  test("empty fails", () => {
    expect(parsePath("")).toBeNull();
  });
});

describe("parseParams", () => {
  test("key=value and bare flags, uppercased", () => {
    expect(parseParams("size=99 smtputf8 Body=8bitmime")).toEqual({
      SIZE: "99",
      SMTPUTF8: true,
      BODY: "8bitmime",
    });
  });
  test("empty string is empty params", () => {
    expect(parseParams("")).toEqual({});
  });
  test("leading = fails", () => {
    expect(parseParams("=nope")).toBeNull();
  });
});

describe("bracket / base64", () => {
  test("bracket wraps once", () => {
    expect(bracket("a@b")).toBe("<a@b>");
    expect(bracket("<a@b>")).toBe("<a@b>");
    expect(bracket("")).toBe("<>");
  });
  test("decodeBase64 accepts valid input", () => {
    expect(decodeBase64("dGVzdA==")?.toString()).toBe("test");
  });
  test("decodeBase64 rejects invalid input", () => {
    expect(decodeBase64("!!!")).toBeNull();
    expect(decodeBase64("abc")).toBeNull();
  });
});
