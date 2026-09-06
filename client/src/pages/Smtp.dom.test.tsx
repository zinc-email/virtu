// Mail-client setup page end-to-end against the RUNNING stack (real
// transport — no mocks). Prereqs: `just up`. Run: `just test-client`.
//
// Parallel-safe: every test logs in a fresh randomized user (bin/user-create
// over the process boundary) and uses unique device names.

import { beforeEach, describe, expect, test } from "bun:test";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SmtpPage } from "src/pages/Smtp";
import { renderPage, waitForGone } from "../../test/render";
import { createUser } from "../../test/tooling";

const uniqueEmail = () => `dom-${crypto.randomUUID()}@qmail.com`;

async function loginFreshUser(): Promise<string> {
  const email = uniqueEmail();
  const apiKey = await createUser(email);
  localStorage.setItem("virtu.apiKey", apiKey);
  return email;
}

describe("SMTP setup page — real transport against the running stack", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("connection settings come from the server, with the account's own address as username", async () => {
    const email = await loginFreshUser();
    renderPage(SmtpPage, "/smtp");

    // The username is the account address — never an alias. Proving it comes
    // back from GET /smtp/settings is the point: the page must not hardcode
    // deployment config.
    await screen.findByText(email, undefined, { timeout: 15_000 });
    // Both ports are offered, and the strip names which is which.
    await screen.findByText(/STARTTLS/);
    await screen.findByText(/SSL\/TLS/);
  }, 60_000);

  test("create shows the password exactly once; revoke removes the device", async () => {
    const user = userEvent.setup();
    await loginFreshUser();
    renderPage(SmtpPage, "/smtp");

    await screen.findByText("Device passwords.");
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
    await waitForGone(() => screen.queryByText("My phone"));
  }, 60_000);
});
