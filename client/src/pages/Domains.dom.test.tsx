// Custom-domain flow end-to-end against the RUNNING stack (real transport —
// no mocks). Prereqs: `just up && just db push`. Run: `just test-client`.
//
// Parallel-safe: every test creates its own user (via bin/user-create over
// the process boundary — fresh users carry the premium trial) and its own
// unique domain name. POST .../verify runs REAL DNS lookups from the API
// server; the reserved example.com namespace guarantees NXDOMAIN, so this
// tier exercises the honest failure path — the success path (records
// actually published, checks green) lives in the story tier against the
// simulated internet (server/test/customDomainApi.story.test.ts).

import { beforeEach, describe, expect, test } from "bun:test";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DomainDetailPage } from "src/pages/DomainDetail";
import { DomainsPage } from "src/pages/Domains";
import { renderPage } from "../../test/render";
import { createUser } from "../../test/tooling";

const PASSWORD = "password1234";
const uniqueEmail = () => `dom-${crypto.randomUUID()}@qmail.com`;
const uniqueDomain = () => `d${crypto.randomUUID().slice(0, 12).replace(/-/g, "")}.example.com`;

const DETAIL_ROUTE = { path: "/domains/$domainId", component: DomainDetailPage };

async function loginFreshUser(): Promise<void> {
  const apiKey = await createUser(uniqueEmail(), PASSWORD);
  localStorage.setItem("virtu.apiKey", apiKey);
}

describe("DomainsPage — real transport against the running stack", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("add a domain → records to publish render → verify fails honestly against real DNS", async () => {
    const user = userEvent.setup();
    const domainName = uniqueDomain();
    await loginFreshUser();
    renderPage(DomainsPage, "/domains", "", [DETAIL_ROUTE]);

    await screen.findByText("Customize your domain.");
    await user.type(screen.getByLabelText("Add a domain"), domainName);
    await user.click(screen.getByRole("button", { name: "+ Add" }));

    // Creation navigates to the detail page: the records to publish.
    await screen.findByText("Configure your domain.");
    // The name appears in several record rows (apex TXT/MX names + status).
    expect(screen.getAllByText(domainName).length).toBeGreaterThan(0);
    // Ownership TXT, SPF, DKIM and DMARC values are all on screen.
    expect(screen.getByText(/vt-verification=/)).toBeTruthy();
    expect(screen.getByText(/v=spf1 include:/)).toBeTruthy();
    expect(screen.getByText(/v=DKIM1; k=rsa; p=/)).toBeTruthy();
    expect(screen.getByText(/v=DMARC1/)).toBeTruthy();
    expect(screen.getByText(`_dmarc.${domainName}`)).toBeTruthy();

    // Real DNS says no such records exist: every check fails, the UI says
    // so, and the domain stays unverified.
    await user.click(screen.getByRole("button", { name: "Verify" }));
    await screen.findByText(/Sometimes DNS changes take a few minutes/, undefined, {
      timeout: 30_000,
    });
    expect(screen.getByText("Not verified")).toBeTruthy();
  }, 60_000);

  test("the index lists the domain; catch-all toggles and persists", async () => {
    const user = userEvent.setup();
    const domainName = uniqueDomain();
    await loginFreshUser();

    // Create through the form…
    const first = renderPage(DomainsPage, "/domains", "", [DETAIL_ROUTE]);
    await screen.findByText("Customize your domain.");
    await user.type(screen.getByLabelText("Add a domain"), domainName);
    await user.click(screen.getByRole("button", { name: "+ Add" }));
    await screen.findByText("Configure your domain.");

    // …flip catch-all on the detail page; the PATCH + refetch round-trip
    // lands back as a checked switch.
    const catchAll = screen.getByRole("switch", { name: "Catch-all" });
    expect(catchAll.getAttribute("aria-checked")).toBe("false");
    await user.click(catchAll);
    await waitFor(
      () => {
        expect(screen.getByRole("switch", { name: "Catch-all" }).getAttribute("aria-checked")).toBe(
          "true",
        );
      },
      { timeout: 15_000 },
    );
    first.unmount();

    // A fresh mount of the index lists it, unverified.
    renderPage(DomainsPage, "/domains", "", [DETAIL_ROUTE]);
    await screen.findByText(domainName);
    expect(screen.getAllByText("Not verified.").length).toBeGreaterThan(0);
  }, 60_000);
});
