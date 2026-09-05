// Notifications page end-to-end against the RUNNING stack (real transport —
// no mocks). Prereqs: `just up && just db push`. Run: `just test-client`.
//
// Parallel-safe: every test logs in a fresh randomized user; notifications
// are minted via bin/notification-create over the process boundary (the
// pipeline produces them in real life — never a client DB reach-in).

import { beforeEach, describe, expect, test } from "bun:test";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NotificationsPage } from "src/pages/Notifications";
import { renderPage } from "../../test/render";
import { createNotification, createUser } from "../../test/tooling";

const uniqueEmail = () => `dom-${crypto.randomUUID()}@qmail.com`;

describe("NotificationsPage — real transport against the running stack", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("fresh account shows the empty state", async () => {
    await createUser(uniqueEmail()).then((k) => localStorage.setItem("virtu.apiKey", k));
    renderPage(NotificationsPage, "/notifications");

    await screen.findByText("Notifications.");
    await screen.findByText(/Nothing yet/);
  });

  test("lists pipeline notifications and marks one read", async () => {
    const email = uniqueEmail();
    const apiKey = await createUser(email);
    localStorage.setItem("virtu.apiKey", apiKey);
    await createNotification(email, "Alias disabled", "wes.abc@virtu.email was auto-disabled.");
    await createNotification(email, "Mailbox failing", "Your mailbox bounced a login code.");

    const user = userEvent.setup();
    renderPage(NotificationsPage, "/notifications");

    // Both rows render, unread, newest first.
    await screen.findByText("Alias disabled");
    await screen.findByText("Mailbox failing");
    expect(screen.getAllByText("New")).toHaveLength(2);
    expect(screen.getAllByText("just now").length).toBeGreaterThanOrEqual(2);

    // Mark the top one read: its New tag and button go away, the other stays.
    const buttons = screen.getAllByRole("button", { name: "Mark read" });
    expect(buttons).toHaveLength(2);
    await user.click(buttons[0]!);
    await waitFor(
      () => {
        expect(screen.getAllByText("New")).toHaveLength(1);
        expect(screen.getAllByRole("button", { name: "Mark read" })).toHaveLength(1);
      },
      { timeout: 15_000 },
    );
  });
});
