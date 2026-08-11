// Mailboxes manager + SMTP device passwords end-to-end against the RUNNING
// stack (real transport — no mocks). Prereqs: `just up && just db push`.
// Run: `just test-client`.
//
// Parallel-safe: every test logs in a fresh randomized user (bin/user-create
// over the process boundary) and uses unique addresses/device names. The
// mailbox verification code is fetched via bin/login-code — the same tool a
// developer uses — never a DB reach-in from the client.

import { beforeEach, describe, expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MailboxDetailPage } from "src/pages/MailboxDetail";
import { MailboxesPage } from "src/pages/Mailboxes";
import { SettingsPage } from "src/pages/Settings";
import { renderPage } from "../../test/render";
import { createUser, latestLoginCode } from "../../test/tooling";

const uniqueEmail = () => `dom-${crypto.randomUUID()}@qmail.com`;

const DETAIL_ROUTE = { path: "/mailboxes/$mailboxId", component: MailboxDetailPage };

type User = ReturnType<typeof userEvent.setup>;

async function loginFreshUser(): Promise<void> {
  const apiKey = await createUser(uniqueEmail());
  localStorage.setItem("virtu.apiKey", apiKey);
}

/** Fill the six PinInput boxes; the last keystroke fires onComplete. */
async function fillCode(user: User, code: string): Promise<void> {
  const boxes = document.querySelectorAll<HTMLInputElement>("input[data-pin]");
  expect(boxes.length).toBe(6);
  for (let i = 0; i < 6; i++) {
    const box = boxes[i];
    if (!box) throw new Error(`missing pin input ${i}`);
    await user.type(box, code[i] ?? "");
  }
}

describe("MailboxesPage — real transport against the running stack", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("add → verify with the emailed code → set as trash → clear", async () => {
    const user = userEvent.setup();
    const mailboxEmail = uniqueEmail();
    await loginFreshUser();
    renderPage(MailboxesPage, "/mailboxes", "", [DETAIL_ROUTE]);

    // The registration mailbox renders, verified and default.
    await screen.findByText("Your mailboxes.");
    await screen.findByText("Default");

    // Add a second mailbox → the verify dialog opens with the code prompt.
    await user.type(screen.getByLabelText("Add a mailbox"), mailboxEmail);
    await user.click(screen.getByRole("button", { name: "+ Add" }));
    await screen.findByText("Check your inbox.");

    // The emailed 6-digit code verifies it.
    const code = await latestLoginCode(mailboxEmail);
    await fillCode(user, code);
    await waitFor(
      () => {
        expect(screen.queryByText("Check your inbox.")).toBeNull();
      },
      { timeout: 15_000 },
    );
    // Both mailboxes now read Verified (registration one + the new one).
    await waitFor(
      () => {
        expect(screen.getAllByText("Verified").length).toBe(2);
      },
      { timeout: 15_000 },
    );

    // Verified rows carry no manage controls — the row links to the detail
    // page, where trash/default are switches showing the current state.
    const row = screen.getByText(mailboxEmail).closest("li");
    if (!row) throw new Error(`no row for ${mailboxEmail}`);
    expect(within(row).queryByRole("button")).toBeNull();
    await user.click(within(row).getByRole("link"));

    // Flip the trash switch on: the PUT + refetch round-trip lands back as a
    // checked switch, and the index detail line gains the flag.
    const trashSwitch = await screen.findByRole("switch", { name: "Trash inbox" });
    expect(trashSwitch.getAttribute("aria-checked")).toBe("false");
    await user.click(trashSwitch);
    await waitFor(
      () => {
        expect(
          screen.getByRole("switch", { name: "Trash inbox" }).getAttribute("aria-checked"),
        ).toBe("true");
      },
      { timeout: 15_000 },
    );

    // …and off again.
    await user.click(screen.getByRole("switch", { name: "Trash inbox" }));
    await waitFor(
      () => {
        expect(
          screen.getByRole("switch", { name: "Trash inbox" }).getAttribute("aria-checked"),
        ).toBe("false");
      },
      { timeout: 15_000 },
    );

    // The non-default mailbox's Default switch is live; the flag can move
    // but never switch off, so the holder's switch would be disabled.
    const defaultSwitch = screen.getByRole("switch", { name: "Default" });
    expect(defaultSwitch.getAttribute("aria-checked")).toBe("false");
    expect(defaultSwitch.hasAttribute("disabled")).toBe(false);
  }, 60_000);

  test("an unverified mailbox offers the code entry, not the manage actions", async () => {
    const user = userEvent.setup();
    const mailboxEmail = uniqueEmail();
    await loginFreshUser();
    renderPage(MailboxesPage, "/mailboxes");
    await screen.findByText("Your mailboxes.");

    await user.type(screen.getByLabelText("Add a mailbox"), mailboxEmail);
    await user.click(screen.getByRole("button", { name: "+ Add" }));
    await screen.findByText("Check your inbox.");
    // Close the dialog without verifying.
    await user.click(screen.getByRole("button", { name: "Close" }));

    await screen.findByText("Not verified");
    expect(screen.getByRole("button", { name: "Enter code" })).toBeTruthy();
  }, 60_000);
});

describe("Settings SMTP passwords — real transport against the running stack", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("create shows the password exactly once; revoke removes the device", async () => {
    const user = userEvent.setup();
    await loginFreshUser();
    renderPage(SettingsPage, "/settings");

    await screen.findByText("SMTP passwords.");
    await user.type(screen.getByLabelText("New device name"), "My phone");
    await user.click(screen.getByRole("button", { name: "+ Create" }));

    // The one-time reveal dialog, with an app-password-shaped secret.
    await screen.findByText("Save this password now.");
    const password = screen.getByTestId("smtp-password").textContent ?? "";
    expect(password).toMatch(/^[a-z2-9]{5}(-[a-z2-9]{5}){3}$/);
    await user.click(screen.getByRole("button", { name: "I saved it" }));

    // Listed by device name, never used, password nowhere on the page.
    await screen.findByText("My phone", undefined, { timeout: 15_000 });
    await screen.findByText("Never used");
    expect(screen.queryByText(password)).toBeNull();

    // Revoke removes the row.
    await user.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(
      () => {
        expect(screen.queryByText("My phone")).toBeNull();
      },
      { timeout: 15_000 },
    );
  }, 60_000);
});
