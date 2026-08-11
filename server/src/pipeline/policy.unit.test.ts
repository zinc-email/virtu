/**
 * The pre-queue policy table (decideRcpt), pure over injected facts — no DB.
 * Order is part of the contract: VERP beats everything, existence beats
 * account standing, account standing beats alias standing.
 */

import { describe, expect, test } from "bun:test";
import type { Alias, Domain, Mailbox, User } from "../db/schema.ts";
import type { VerpInfo } from "../mail/index.ts";
import { type CatchAllFacts, decideRcpt, type RcptFacts } from "./policy.ts";

const NOW = new Date("2026-08-08T12:00:00Z");

function fakeUser(over: Partial<User> = {}): User {
  return {
    id: 1,
    email: "wes@qmail.com",
    name: "Wes",
    activated: true,
    disabled: false,
    lifetime: false,
    trialEnd: null,
    defaultMailboxId: 10,
    maxSpamScore: null,
    notification: true,
    aliasGenerator: "word",
    senderFormat: "AT",
    randomAliasSuffix: "random_string",
    defaultAliasDomain: null,
    flags: 0,
    trashMailboxId: null,
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
    domainId: null,
    cannotBeDisabled: false,
    automaticCreation: false,
    pinned: false,
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

function fakeCustomDomain(over: Partial<Domain> = {}): Domain {
  return {
    id: 7,
    userId: 1,
    nameRequested: "user.com",
    name: "user.com", // owned (verifiedOwner) => generated name is populated
    fromName: null,
    verifiedMx: true,
    verifiedDkim: false,
    verifiedSpf: false,
    verifiedDmarc: false,
    verifiedOwner: true,
    ownershipTxtToken: "tok",
    catchAll: true,
    nbFailedChecks: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function fakeCatchAll(over: Partial<CatchAllFacts> = {}): CatchAllFacts {
  return {
    domain: fakeCustomDomain(),
    owner: fakeUser(),
    mailbox: fakeMailbox(),
    tombstoned: false,
    ...over,
  };
}

function facts(over: Partial<RcptFacts> = {}): RcptFacts {
  const base: RcptFacts = {
    verp: null,
    isLocalDomain: true,
    alias: fakeAlias(),
    user: fakeUser(),
    mailbox: fakeMailbox(),
    deliveryMailboxes: [],
    trashMailbox: null,
    catchAll: null,
    ...over,
  };
  // Delivery set defaults to the healthy primary, like evaluateRcpt gathers.
  if (over.deliveryMailboxes === undefined) {
    base.deliveryMailboxes = base.mailbox !== null && !base.mailbox.disabled ? [base.mailbox] : [];
  }
  return base;
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

  test("disabled primary with a healthy extra mailbox: still deliver", () => {
    const extra = fakeMailbox({ id: 12, email: "second@qmail.com" });
    const decision = decideRcpt(
      facts({ mailbox: fakeMailbox({ disabled: true }), deliveryMailboxes: [extra] }),
    );
    expect(decision).toEqual({ kind: "deliver" });
  });

  test("healthy alias/user/mailbox: deliver", () => {
    expect(decideRcpt(facts())).toEqual({ kind: "deliver" });
  });
});

describe("decideRcpt — trash inbox", () => {
  const off = () => fakeAlias({ enabled: false });
  const trash = (over: Partial<Mailbox> = {}) =>
    fakeMailbox({ id: 11, email: "trash@qmail.com", ...over });

  test("disabled alias with a healthy trash mailbox: deliver flagged trash", () => {
    const decision = decideRcpt(facts({ alias: off(), trashMailbox: trash() }));
    expect(decision).toEqual({ kind: "deliver", trash: true });
  });

  test("unverified trash mailbox: fall back to accept-and-drop", () => {
    const decision = decideRcpt(facts({ alias: off(), trashMailbox: trash({ verified: false }) }));
    expect(decision).toEqual({ kind: "drop", reason: "alias_disabled" });
  });

  test("disabled trash mailbox: fall back to accept-and-drop", () => {
    const decision = decideRcpt(facts({ alias: off(), trashMailbox: trash({ disabled: true }) }));
    expect(decision).toEqual({ kind: "drop", reason: "alias_disabled" });
  });

  test("enabled alias ignores the trash mailbox entirely", () => {
    expect(decideRcpt(facts({ trashMailbox: trash() }))).toEqual({ kind: "deliver" });
  });

  test("disabled user beats trash routing (account standing first)", () => {
    const decision = decideRcpt(
      facts({ alias: off(), user: fakeUser({ disabled: true }), trashMailbox: trash() }),
    );
    expect(decision).toMatchObject({ kind: "reject", code: 550 });
  });
});

describe("decideRcpt — catch-all", () => {
  const noAlias = { alias: null, user: null, mailbox: null };

  test("unknown localpart on a catch-all domain with a healthy owner: mint", () => {
    const decision = decideRcpt(facts({ ...noAlias, catchAll: fakeCatchAll() }));
    expect(decision).toEqual({ kind: "mint" });
  });

  test("catch-all off: plain user unknown (domain is still local)", () => {
    const decision = decideRcpt(
      facts({
        ...noAlias,
        catchAll: fakeCatchAll({ domain: fakeCustomDomain({ catchAll: false }) }),
      }),
    );
    expect(decision).toMatchObject({ kind: "reject", code: 550, enhanced: "5.1.1" });
  });

  test("tombstoned address never re-mints: user unknown, indistinguishable", () => {
    const decision = decideRcpt(
      facts({ ...noAlias, catchAll: fakeCatchAll({ tombstoned: true }) }),
    );
    expect(decision).toMatchObject({ kind: "reject", code: 550, enhanced: "5.1.1" });
  });

  test("disabled owner account: user unknown, not mint", () => {
    const decision = decideRcpt(
      facts({ ...noAlias, catchAll: fakeCatchAll({ owner: fakeUser({ disabled: true }) }) }),
    );
    expect(decision).toMatchObject({ kind: "reject", code: 550, enhanced: "5.1.1" });
  });

  test("no default mailbox: user unknown, not mint", () => {
    const decision = decideRcpt(facts({ ...noAlias, catchAll: fakeCatchAll({ mailbox: null }) }));
    expect(decision).toMatchObject({ kind: "reject", code: 550, enhanced: "5.1.1" });
  });

  test("disabled mailbox: user unknown, not mint", () => {
    const decision = decideRcpt(
      facts({
        ...noAlias,
        catchAll: fakeCatchAll({ mailbox: fakeMailbox({ disabled: true }) }),
      }),
    );
    expect(decision).toMatchObject({ kind: "reject", code: 550, enhanced: "5.1.1" });
  });

  test("VERP still wins over a mintable catch-all", () => {
    const verp: VerpInfo = { type: "bounce_forward", id: 42 };
    const decision = decideRcpt(facts({ ...noAlias, verp, catchAll: fakeCatchAll() }));
    expect(decision).toEqual({ kind: "verp", info: verp });
  });

  test("an existing alias is untouched by catch-all facts", () => {
    const decision = decideRcpt(facts({ catchAll: fakeCatchAll() }));
    expect(decision).toEqual({ kind: "deliver" });
  });
});
