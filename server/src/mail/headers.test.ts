import { describe, expect, test } from "bun:test";
import {
  formatAddress,
  formatAddressList,
  formatDateHeader,
  HeaderBlock,
  parseAddressList,
  parseMessage,
  serializeMessage,
  unfoldValue,
} from "./headers.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

const SIMPLE =
  "From: milton@initech.com\r\n" +
  "To: asdf@user.com\r\n" +
  "Subject: TPS reports\r\n" +
  "\r\n" +
  "Please find attached.\r\n";

describe("parseMessage", () => {
  test("splits headers and body, ordered fields", () => {
    const { headers, body } = parseMessage(enc.encode(SIMPLE));
    expect(headers.fields.map((f) => f.name)).toEqual(["From", "To", "Subject"]);
    expect(dec.decode(body)).toBe("Please find attached.\r\n");
    expect(headers.get("subject")).toBe("TPS reports");
  });

  test("preserves folded headers and unfolds on get", () => {
    const raw =
      "Subject: a very\r\n long subject\r\n\tthat folds twice\r\n" + "\r\n" + "body";
    const { headers } = parseMessage(enc.encode(raw));
    expect(headers.fields).toHaveLength(1);
    expect(headers.fields[0]!.rawValue).toBe(" a very\r\n long subject\r\n\tthat folds twice");
    expect(headers.get("Subject")).toBe("a very long subject\tthat folds twice");
  });

  test("handles UTF-8 header values (RFC 6532)", () => {
    const raw = "From: Renée Müller <renée@exämple.com>\r\nSubject: héllo 你好\r\n\r\n";
    const { headers } = parseMessage(enc.encode(raw));
    expect(headers.get("Subject")).toBe("héllo 你好");
    expect(headers.get("From")).toBe("Renée Müller <renée@exämple.com>");
  });

  test("tolerates bare-LF line endings", () => {
    const raw = "From: a@b.c\nTo: d@e.f\n\nbody\n";
    const { headers, body } = parseMessage(enc.encode(raw));
    expect(headers.get("From")).toBe("a@b.c");
    expect(headers.get("To")).toBe("d@e.f");
    expect(dec.decode(body)).toBe("body\n");
  });

  test("message with no body / no blank line", () => {
    const raw = "From: a@b.c\r\nTo: d@e.f\r\n";
    const { headers, body } = parseMessage(enc.encode(raw));
    expect(headers.fields).toHaveLength(2);
    expect(body.length).toBe(0);
    expect(headers.separator.length).toBe(0);
  });

  test("keeps a colon-less garbage line as an opaque round-tripping field", () => {
    const raw = "From: a@b.c\r\nthis is not a header\r\nTo: d@e.f\r\n\r\nbody";
    const parsed = parseMessage(enc.encode(raw));
    expect(parsed.headers.get("To")).toBe("d@e.f");
    expect(dec.decode(serializeMessage(parsed.headers, parsed.body))).toBe(raw);
  });
});

describe("round-trip fidelity", () => {
  const cases: [string, string][] = [
    ["simple CRLF", SIMPLE],
    [
      "folded + tabs + trailing spaces",
      "Received: from a\r\n\tby b\r\n  with ESMTP  \r\nX-Odd:   spaces \r\n\r\nbody\r\n.\r\n",
    ],
    ["bare LF endings", "From: a@b.c\nSubject: x\n\nbody\n"],
    ["mixed endings", "From: a@b.c\nSubject: x\r\n\r\nbody"],
    ["UTF-8 bytes", "Subject: héllo 你好 \r\nX-Emoji: 🦊\r\n\r\n\xff-body"],
    ["no body", "From: a@b.c\r\nTo: d@e.f\r\n"],
    ["empty body after blank line", "From: a@b.c\r\n\r\n"],
    ["body with fake headers", "From: a@b.c\r\n\r\nTo: not-a-header\r\n\r\nmore"],
  ];
  for (const [name, raw] of cases) {
    test(name, () => {
      const bytes = enc.encode(raw);
      const { headers, body } = parseMessage(bytes);
      expect(Array.from(serializeMessage(headers, body))).toEqual(Array.from(bytes));
    });
  }

  test("untouched fields keep exact bytes even when others are modified", () => {
    const raw =
      "Received: from a\r\n by b\r\n" +
      "From: milton@initech.com\r\n" +
      "Subject: folded\r\n over lines\r\n" +
      "\r\nbody";
    const { headers, body } = parseMessage(enc.encode(raw));
    headers.replace("From", "someone@else.example");
    const out = dec.decode(serializeMessage(headers, body));
    expect(out).toContain("Received: from a\r\n by b\r\n");
    expect(out).toContain("Subject: folded\r\n over lines\r\n");
    expect(out).toContain("From: someone@else.example\r\n");
  });
});

describe("helpers", () => {
  test("get/getAll are case-insensitive; getAll ordered", () => {
    const raw = "Received: one\r\nreceived: two\r\nRECEIVED: three\r\n\r\n";
    const { headers } = parseMessage(enc.encode(raw));
    expect(headers.get("Received")).toBe("one");
    expect(headers.getAll("rEcEiVeD")).toEqual(["one", "two", "three"]);
  });

  test("remove removes all occurrences and reports count", () => {
    const raw = "A: 1\r\nB: 2\r\nA: 3\r\n\r\n";
    const { headers } = parseMessage(enc.encode(raw));
    expect(headers.remove("a")).toBe(2);
    expect(headers.fields.map((f) => f.name)).toEqual(["B"]);
  });

  test("replace keeps position, drops duplicates, appends when missing", () => {
    const raw = "A: 1\r\nB: 2\r\nA: 3\r\n\r\n";
    const { headers } = parseMessage(enc.encode(raw));
    headers.replace("A", "new");
    expect(headers.fields.map((f) => f.name)).toEqual(["A", "B"]);
    expect(headers.get("A")).toBe("new");
    headers.replace("C", "created");
    expect(headers.fields.map((f) => f.name)).toEqual(["A", "B", "C"]);
  });

  test("prepend/append position fields at top/bottom", () => {
    const { headers } = parseMessage(enc.encode("A: 1\r\n\r\n"));
    headers.prepend("Top", "t");
    headers.append("Bottom", "b");
    expect(headers.fields.map((f) => f.name)).toEqual(["Top", "A", "Bottom"]);
  });

  test("generated values are sanitized against header injection", () => {
    const headers = new HeaderBlock();
    headers.append("Subject", "hello\r\nBcc: evil@example.com");
    const out = dec.decode(headers.serialize());
    expect(out).toBe("Subject: hello Bcc: evil@example.com\r\n");
  });

  test("long generated values fold at whitespace under 78 chars", () => {
    const headers = new HeaderBlock();
    const list = Array.from({ length: 6 }, (_, i) => `contact_${i}_at_example_com_xyz${i}@proxy.example`);
    headers.append("To", list.join(", "));
    const out = dec.decode(headers.serialize());
    for (const line of out.split("\r\n")) {
      expect(line.length).toBeLessThanOrEqual(78);
    }
    // still parses back to the same list
    const parsed = parseMessage(enc.encode(`${out}\r\n`));
    expect(parseAddressList(parsed.headers.get("To")!)).toHaveLength(6);
  });

  test("unfoldValue strips CRLF and LF before WSP", () => {
    expect(unfoldValue("a\r\n b")).toBe("a b");
    expect(unfoldValue("a\n\tb")).toBe("a\tb");
  });
});

describe("parseAddressList", () => {
  test("single bare address", () => {
    expect(parseAddressList("milton@initech.com")).toEqual([
      { address: "milton@initech.com" },
    ]);
  });

  test("angle-addr with display name", () => {
    expect(parseAddressList("Milton Waddams <milton@initech.com>")).toEqual([
      { name: "Milton Waddams", address: "milton@initech.com" },
    ]);
  });

  test("quoted display name containing commas and escapes", () => {
    expect(parseAddressList('"Waddams, Milton \\"Red\\"" <milton@initech.com>')).toEqual([
      { name: 'Waddams, Milton "Red"', address: "milton@initech.com" },
    ]);
  });

  test("comma-separated list, mixed forms", () => {
    expect(
      parseAddressList('a@x.com, "B, b" <b@y.com>, C <c@z.com>'),
    ).toEqual([
      { address: "a@x.com" },
      { name: "B, b", address: "b@y.com" },
      { name: "C", address: "c@z.com" },
    ]);
  });

  test("group syntax flattened to members", () => {
    expect(parseAddressList("Team: a@x.com, B <b@y.com>;, c@z.com")).toEqual([
      { address: "a@x.com" },
      { name: "B", address: "b@y.com" },
      { address: "c@z.com" },
    ]);
  });

  test("empty group (undisclosed-recipients) yields no addresses", () => {
    expect(parseAddressList("undisclosed-recipients:;")).toEqual([]);
  });

  test("comments are dropped", () => {
    expect(parseAddressList("milton@initech.com (Milton)")).toEqual([
      { address: "milton@initech.com" },
    ]);
    expect(parseAddressList("(hi) Milton <milton@initech.com> (bye)")).toEqual([
      { name: "Milton", address: "milton@initech.com" },
    ]);
  });

  test("UTF-8 display names pass through raw", () => {
    expect(parseAddressList("Renée Müller <renee@example.com>")).toEqual([
      { name: "Renée Müller", address: "renee@example.com" },
    ]);
  });

  test("obsolete route in angle-addr is tolerated", () => {
    expect(parseAddressList("<@relay1.example,@relay2.example:user@example.com>")).toEqual([
      { address: "user@example.com" },
    ]);
  });

  test("empty and whitespace-only input", () => {
    expect(parseAddressList("")).toEqual([]);
    expect(parseAddressList("  ")).toEqual([]);
    expect(parseAddressList(" , ,")).toEqual([]);
  });
});

describe("formatAddress / formatAddressList", () => {
  test("bare address when no name", () => {
    expect(formatAddress({ address: "a@b.c" })).toBe("a@b.c");
  });

  test("plain name unquoted", () => {
    expect(formatAddress({ name: "Milton Waddams", address: "m@i.com" })).toBe(
      "Milton Waddams <m@i.com>",
    );
  });

  test("name with specials gets quoted and escaped", () => {
    expect(formatAddress({ name: 'Waddams, "Red"', address: "m@i.com" })).toBe(
      '"Waddams, \\"Red\\"" <m@i.com>',
    );
  });

  test("UTF-8 name emitted raw (RFC 6532)", () => {
    expect(formatAddress({ name: "Renée Müller", address: "r@e.com" })).toBe(
      "Renée Müller <r@e.com>",
    );
  });

  test("round-trips through parseAddressList", () => {
    const list = [
      { address: "a@x.com" },
      { name: "B, b", address: "b@y.com" },
      { name: 'Say "hi"', address: "c@z.com" },
      { name: "Renée", address: "d@w.com" },
    ];
    expect(parseAddressList(formatAddressList(list))).toEqual(list);
  });
});

describe("formatDateHeader", () => {
  test("formats RFC 5322 UTC date", () => {
    expect(formatDateHeader(new Date(Date.UTC(2026, 7, 8, 9, 5, 3)))).toBe(
      "Sat, 08 Aug 2026 09:05:03 +0000",
    );
  });
});
