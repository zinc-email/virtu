// LoginPage end-to-end against the RUNNING stack (real transport — no
// mocks). Prereqs: `just up && just db push`. Run: `just test-client`.
//
// One page covers login AND signup (the passwordless flow), so these tests
// are the whole auth surface: a fresh email round-trips to a working session,
// the homepage CTA's ?email= auto-submits into the code step, and a wrong
// code stays put. Parallel-safe by construction (like the int tier): every
// test uses a fresh randomized email, so runs don't collide and order doesn't
// matter. The emailed login code is fetched over a process boundary
// (test/tooling.ts → bin/login-code), never a DB reach-in from the client.

import { beforeEach, describe, expect, test } from "bun:test";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LoginPage } from "src/pages/Login";
import { HOME_MARKER, renderPage } from "../../test/render";
import { latestLoginCode } from "../../test/tooling";

const uniqueEmail = () => `dom-${crypto.randomUUID()}@qmail.com`;

type User = ReturnType<typeof userEvent.setup>;

/** Fill the six PinInput boxes; the last keystroke fires onComplete → submit. */
async function fillCode(user: User, code: string): Promise<void> {
  // Our PinInput (src/ui.tsx) renders 6 boxes tagged data-pin.
  const boxes = document.querySelectorAll<HTMLInputElement>("input[data-pin]");
  expect(boxes.length).toBe(6);
  for (let i = 0; i < 6; i++) {
    const box = boxes[i];
    if (!box) throw new Error(`missing pin input ${i}`);
    await user.type(box, code[i] ?? "");
  }
}

async function submitEmail(user: User, email: string): Promise<void> {
  // The memory router mounts the route asynchronously; wait for it.
  await screen.findByText("Log-in or sign-up.");
  const emailInput = document.querySelector<HTMLInputElement>('input[type="email"]');
  if (!emailInput) throw new Error("email input not found");
  await user.type(emailInput, email);
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByText(/We sent a confirmation email/i);
}

describe("LoginPage — real transport against the running stack", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("fresh email → emailed code → lands in the app (signup path)", async () => {
    const user = userEvent.setup();
    const email = uniqueEmail();
    renderPage(LoginPage, "/login");

    await submitEmail(user, email);

    const code = await latestLoginCode(email);
    await fillCode(user, code);

    // Reaching the home stub proves the verify graduated the fresh account
    // AND minted a key, and the key was stored.
    await screen.findByText(HOME_MARKER);
    expect(localStorage.getItem("virtu.apiKey")).toBeTruthy();
  });

  test("the homepage CTA's ?email= auto-submits straight into the code step", async () => {
    const user = userEvent.setup();
    const email = uniqueEmail();
    renderPage(LoginPage, "/login", `?email=${encodeURIComponent(email)}`);

    // No button press needed: the www form submit WAS step one.
    await screen.findByText(/We sent a confirmation email/i);
    expect(screen.getByText(email)).toBeTruthy();

    const code = await latestLoginCode(email);
    await fillCode(user, code);
    await screen.findByText(HOME_MARKER);
    expect(localStorage.getItem("virtu.apiKey")).toBeTruthy();
  });

  test("a wrong code surfaces the API error and stays on the code step", async () => {
    const user = userEvent.setup();
    const email = uniqueEmail();
    renderPage(LoginPage, "/login");

    await submitEmail(user, email);

    const code = await latestLoginCode(email);
    const wrong = code.slice(0, 5) + ((Number(code[5]) + 1) % 10);
    await fillCode(user, wrong);

    await screen.findByText("Wrong email or code");
    expect(localStorage.getItem("virtu.apiKey")).toBeNull();
  });
});
