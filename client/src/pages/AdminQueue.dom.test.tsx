// Admin queue pages end-to-end against the RUNNING stack (real transport —
// no mocks). Prereqs: `just up && just db push`. Run: `just test-client`.
//
// Parallel-safe: each test mints a fresh randomized user; the admin flag is
// granted via bin/admin-grant over the process boundary (test/tooling.ts) —
// the same tool an operator uses, never a client DB reach-in. The queue row
// each test inspects is the fresh user's own signup-code email, which sits
// in the dev queue (no deliverd runs) with a unique recipient address.

import { beforeEach, describe, expect, test } from "bun:test";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AdminOverviewPage } from "src/pages/AdminOverview";
import { AdminQueuePage } from "src/pages/AdminQueue";
import { AdminQueueMessagePage } from "src/pages/AdminQueueMessage";
import { renderPage, waitForGone } from "../../test/render";
import { createUser, grantAdmin } from "../../test/tooling";

const uniqueEmail = () => `dom-admin-${crypto.randomUUID()}@qmail.com`;

const DETAIL_ROUTE = { path: "/admin/queue/$messageId", component: AdminQueueMessagePage };

describe("Admin queue — real transport against the running stack", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("admin inspects a queue row and drops it via the confirm dialog", async () => {
    const user = userEvent.setup();
    const email = uniqueEmail();
    const apiKey = await createUser(email);
    await grantAdmin(email);
    localStorage.setItem("virtu.apiKey", apiKey);

    renderPage(AdminQueuePage, "/admin/queue", "", [DETAIL_ROUTE]);

    // The fresh user's own signup-code email is the newest queue row.
    await screen.findByText("Delivery queue.");
    const row = await screen.findByText(email, undefined, { timeout: 15_000 });

    // Into the detail: envelope facts + the decoded transactional owner.
    const link = row.closest("a");
    if (!link) throw new Error("queue row is not a link");
    await user.click(link);
    await screen.findByText(/Queue #\d+/, undefined, { timeout: 15_000 });
    await screen.findAllByText("transactional");
    // The owner resolves back to the user the code was for — the email shows
    // as both the envelope recipient and the decoded owner.
    const emailHits = await screen.findAllByText(email);
    expect(emailHits.length).toBeGreaterThanOrEqual(2);
    // Privacy: routing headers only — the codes' Subject must not render.
    expect(screen.queryByText(/Subject/i)).toBeNull();

    // Drop behind the native-dialog confirm, landing back on the queue page.
    await user.click(screen.getByRole("button", { name: "Drop" }));
    await screen.findByText("Drop this message?");
    await user.click(screen.getByRole("button", { name: "Drop message" }));
    await waitForGone(() => screen.queryByText("Drop this message?"));
    await screen.findByText("Delivery queue.");
  }, 60_000);

  test("a non-admin gets the not-found page — /admin looks like a bogus URL", async () => {
    const apiKey = await createUser(uniqueEmail());
    localStorage.setItem("virtu.apiKey", apiKey);

    renderPage(AdminOverviewPage, "/admin");

    await screen.findByText("Not found.", undefined, { timeout: 15_000 });
    expect(screen.queryByText("Admin.")).toBeNull();
    // No authorization language anywhere — existence stays unadvertised.
    expect(screen.queryByText(/authorized|operator|admin/i)).toBeNull();
  }, 60_000);
});
