import { describe, expect, test } from "bun:test";
import {
  destinationDomain,
  isDeferralSignal,
  pauseDurationMs,
  stepForCommand,
} from "./destinationThrottle.ts";

describe("isDeferralSignal", () => {
  test("421 at any step is a signal", () => {
    expect(isDeferralSignal({ code: 421, step: "greeting" })).toBe(true);
    expect(isDeferralSignal({ code: 421, enhancedCode: "4.7.0", step: "rcpt_to" })).toBe(true);
    expect(isDeferralSignal({ code: 421, enhancedCode: "4.3.2", step: "data" })).toBe(true);
  });

  test("4.7.x policy deferrals at non-recipient steps are signals", () => {
    expect(isDeferralSignal({ code: 450, enhancedCode: "4.7.1", step: "mail_from" })).toBe(true);
    expect(isDeferralSignal({ code: 451, enhancedCode: "4.7.650", step: "mail_from" })).toBe(true);
    expect(isDeferralSignal({ code: 451, enhancedCode: "4.7.0", step: "data" })).toBe(true);
    expect(isDeferralSignal({ code: 450, enhancedCode: "4.7.1", step: "ehlo" })).toBe(true);
  });

  test("RCPT-time 4.7.x is greylisting, not a signal", () => {
    expect(isDeferralSignal({ code: 451, enhancedCode: "4.7.1", step: "rcpt_to" })).toBe(false);
    expect(isDeferralSignal({ code: 450, enhancedCode: "4.7.1", step: "rcpt_to" })).toBe(false);
  });

  test("other 4xx (mailbox busy, storage, per-recipient rate) never pause the domain", () => {
    expect(isDeferralSignal({ code: 450, enhancedCode: "4.2.1", step: "rcpt_to" })).toBe(false);
    expect(isDeferralSignal({ code: 452, enhancedCode: "4.3.1", step: "mail_from" })).toBe(false);
    expect(isDeferralSignal({ code: 450, step: "data" })).toBe(false);
  });

  test("5xx and 2xx are never signals", () => {
    expect(isDeferralSignal({ code: 550, enhancedCode: "5.7.1", step: "data" })).toBe(false);
    expect(isDeferralSignal({ code: 250, step: "data" })).toBe(false);
  });
});

describe("pauseDurationMs", () => {
  const opts = { baseMs: 300_000, maxMs: 3_600_000 };
  test("doubles per strike from the base", () => {
    expect(pauseDurationMs(1, opts)).toBe(300_000);
    expect(pauseDurationMs(2, opts)).toBe(600_000);
    expect(pauseDurationMs(3, opts)).toBe(1_200_000);
  });
  test("caps at maxMs", () => {
    expect(pauseDurationMs(10, opts)).toBe(3_600_000);
  });
  test("strikes below 1 behave as 1", () => {
    expect(pauseDurationMs(0, opts)).toBe(300_000);
  });
});

describe("stepForCommand", () => {
  test("maps the SMTP client's command names", () => {
    expect(stepForCommand("greeting")).toBe("greeting");
    expect(stepForCommand("EHLO")).toBe("ehlo");
    expect(stepForCommand("HELO")).toBe("ehlo");
    expect(stepForCommand("STARTTLS")).toBe("starttls");
    expect(stepForCommand("MAIL FROM")).toBe("mail_from");
    expect(stepForCommand("RCPT TO")).toBe("rcpt_to");
    expect(stepForCommand("DATA")).toBe("data");
  });
});

describe("destinationDomain", () => {
  test("lowercased domain of the address; empty when malformed", () => {
    expect(destinationDomain("Wes@Gmail.com")).toBe("gmail.com");
    expect(destinationDomain("nobody")).toBe("");
  });
});
