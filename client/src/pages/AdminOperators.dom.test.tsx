// Admin operator-mail page end-to-end against the RUNNING stack (real
// transport — no mocks). Prereqs: `just up && just db push`. Run:
// `just test-client`. Parallel-safe: a fresh randomized admin per test
// (granted via bin/admin-grant over the process boundary); the switch it
// flips is its own row, and it flips it back at the end so the shared
// "effective set" rule is left as found.

import { beforeEach, describe, expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AdminOperatorsPage } from "src/pages/AdminOperators";
import { renderPage } from "../../test/render";
import { createUser, grantAdmin } from "../../test/tooling";

const uniqueEmail = () => `dom-ops-${crypto.randomUUID()}@qmail.com`;

describe("Admin operator mail — real transport against the running stack", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("an operator opts in to operator mail with the switch and becomes a receiver", async () => {
    const user = userEvent.setup();
    const email = uniqueEmail();
    const apiKey = await createUser(email);
    await grantAdmin(email);
    localStorage.setItem("virtu.apiKey", apiKey);

    renderPage(AdminOperatorsPage, "/admin/operators");

    await screen.findByText("Operator mail.");
    // The role addresses the server routes are listed in the intro.
    await screen.findByText("postmaster@");
    const toggle = await screen.findByRole(
      "switch",
      { name: `Operator mail to ${email}` },
      { timeout: 15_000 },
    );
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    await user.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"), {
      timeout: 15_000,
    });
    // Opted in ⇒ in the effective set: the row now carries the receiving tag.
    const row = toggle.closest("div");
    if (!row) throw new Error("switch row missing");
    await within(row.parentElement ?? row).findByText("receiving");

    // Flip back so the shared fallback rule is left as we found it.
    await user.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"), {
      timeout: 15_000,
    });
  }, 60_000);
});
