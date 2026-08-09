/**
 * The pre-queue policy table (decideRcpt), pure over injected facts — no DB.
 * Order is part of the contract: VERP beats everything, existence beats
 * account standing, account standing beats alias standing.
 */

import { describe, expect, test } from "bun:test";
import type { Alias, Mailbox, User } from "../db/schema.ts";
import type { VerpInfo } from "../mail/index.ts";
import { decideRcpt, type RcptFacts } from "./policy.ts";

const NOW = new Date("2026-08-08T12:00:00Z");

function fakeUser(over: Partial<User> = {}): User {
  return {
    id: 1,
    email: "wes@qmail.com",
    name: "Wes",
    passwordHash: "x",
    activated: true,
    disabled: false,
    lifetime: false,
    trialEnd: null,
    defaultMailboxId: 10,
    maxSpamScore: null,
    notification: true,
    flags: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function fakeAlias(over: Partial<Alias> = {}): Alias {
  return {
    id: 5,
    userId: 1,
    email: "wes.abc@virtu.email",
    name: null,
    enabled: true,
    note: null,
    mailboxId: 10,
    customDomainId: null,
    cannotBeDisabled: false,
    automaticCreation: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function fakeMailbox(over: Partial<Mailbox> = {}): Mailbox {
  return {
    id: 10,
    userId: 1,
    email: "wes@qmail.com",
    verified: true,
    disabled: false,
    nbFailedChecks: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function facts(over: Partial<RcptFacts> = {}): RcptFacts {
  return {
    verp: null,
    isLocalDomain: true,
    alias: fakeAlias(),
    user: fakeUser(),
    mailbox: fakeMailbox(),
    ...over,
  };
}

describe("decideRcpt", () => {
  test("VERP wins over everything else", () => {
    const verp: VerpInfo = { type: "bounce_forward", id: 42 };
    const decision = decideRcpt(facts({ verp, alias: null, user: null, mailbox: null }));
    expect(decision).toEqual({ kind: "verp", info: verp });
  });

  test("nonexistent alias on our domain: 550 5.1.1", () => {
    const decision = decideRcpt(facts({ alias: null, user: null, mailbox: null }));
    expect(decision).toMatchObject({ kind: "reject", code: 550, enhanced: "5.1.1" });
  });

  test("nonexistent alias on a foreign domain: relay denied 554", () => {
    const decision = decideRcpt(
      facts({ alias: null, user: null, mailbox: null, isLocalDomain: false }),
    );
    expect(decision).toMatchObject({ kind: "reject", code: 554, enhanced: "5.7.1" });
  });

  test("disabled user account: 550 5.7.1 even for an enabled alias", () => {
    const decision = decideRcpt(facts({ user: fakeUser({ disabled: true }) }));
    expect(decision).toMatchObject({ kind: "reject", code: 550, enhanced: "5.7.1" });
  });

  test("disabled alias: accept-and-drop, never a reject (existence not probed)", () => {
    const decision = decideRcpt(facts({ alias: fakeAlias({ enabled: false }) }));
    expect(decision).toEqual({ kind: "drop", reason: "alias_disabled" });
  });

  test("disabled alias of a disabled user still rejects (account beats alias)", () => {
    const decision = decideRcpt(
      facts({ alias: fakeAlias({ enabled: false }), user: fakeUser({ disabled: true }) }),
    );
    expect(decision).toMatchObject({ kind: "reject", code: 550 });
  });

  test("missing mailbox row: drop, not reject", () => {
    const decision = decideRcpt(facts({ mailbox: null }));
    expect(decision).toEqual({ kind: "drop", reason: "mailbox_unavailable" });
  });

  test("disabled mailbox: drop", () => {
    const decision = decideRcpt(facts({ mailbox: fakeMailbox({ disabled: true }) }));
    expect(decision).toEqual({ kind: "drop", reason: "mailbox_unavailable" });
  });

  test("healthy alias/user/mailbox: deliver", () => {
    expect(decideRcpt(facts())).toEqual({ kind: "deliver" });
  });
});
