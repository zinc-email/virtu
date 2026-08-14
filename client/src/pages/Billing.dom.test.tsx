// BillingPage against the RUNNING stack (real transport — no mocks; see
// Login.dom.test.tsx for the tier's ground rules). What's under test here is
// the mobile-shell seam (src/shell.md): inside a shell the page must show NO
// purchase actions — the stores' consumption-only rule (plans/mobile.md).
// Android gets the Google-blessed plain "visit the web" line; iOS gets
// status only (Apple's anti-steering rule outside the US storefront has
// caught even non-tappable wording). Assertions are chosen to hold whether
// or not this dev stack has Stripe configured, so the test is portable.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { screen } from "@testing-library/react";
import { BillingPage } from "src/pages/Billing";
import type { VirtuShell } from "src/shell";
import { renderPage } from "../../test/render";
import { createUser } from "../../test/tooling";

const uniqueEmail = () => `dom-${crypto.randomUUID()}@qmail.com`;

const fakeShell: VirtuShell = {
  platform: "android",
  shellVersion: "0.0.0-test",
  protocol: 1,
  request: () => Promise.resolve(JSON.stringify({ ok: true })),
};

describe("BillingPage — mobile-shell seam", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    delete window.virtuShell;
  });

  test("Android shell: no purchase UI, just the visit-the-web line", async () => {
    const key = await createUser(uniqueEmail());
    localStorage.setItem("virtu.apiKey", key);
    window.virtuShell = fakeShell;

    renderPage(BillingPage, "/billing");

    // Status loaded (fresh users are on the trial).
    await screen.findByText("Free trial");
    // The consumption-only line replaces every action, configured or not.
    screen.getByText(/visit .* in your web browser/);
    expect(screen.queryByText("» Upgrade to Premium")).toBeNull();
    expect(screen.queryByText("» Manage subscription")).toBeNull();
  });

  test("iOS shell: no purchase UI and no steering wording at all", async () => {
    const key = await createUser(uniqueEmail());
    localStorage.setItem("virtu.apiKey", key);
    window.virtuShell = { ...fakeShell, platform: "ios" };

    renderPage(BillingPage, "/billing");

    await screen.findByText("Free trial");
    expect(screen.queryByText(/visit .* in your web browser/)).toBeNull();
    expect(screen.queryByText("» Upgrade to Premium")).toBeNull();
    expect(screen.queryByText("» Manage subscription")).toBeNull();
  });

  test("on the web: no shell line; actions render per server config", async () => {
    const key = await createUser(uniqueEmail());
    localStorage.setItem("virtu.apiKey", key);

    renderPage(BillingPage, "/billing");

    await screen.findByText("Free trial");
    expect(screen.queryByText(/visit .* in your web browser/)).toBeNull();
    // With Stripe configured the trial user gets the upgrade action; without,
    // the not-configured line. Either way it must NOT be the shell posture.
    const upgrade = screen.queryByText("» Upgrade to Premium");
    const notConfigured = screen.queryByText("Billing is not configured on this server.");
    expect(upgrade !== null || notConfigured !== null).toBe(true);
  });
});
