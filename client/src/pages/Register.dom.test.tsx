// RegisterPage end-to-end against the RUNNING stack (real transport — no
// mocks). Prereqs: `just up && just db push`. Run: `just test-client`.
//
// Parallel-safe by construction (like the int tier): every test registers a
// fresh randomized email, so runs don't collide and order doesn't matter. The
// emailed activation code is fetched over a process boundary (test/tooling.ts
// → bin/login-code), never a DB reach-in from the client.

import { beforeEach, describe, expect, test } from "bun:test";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RegisterPage } from "src/pages/Register";
import { HOME_MARKER, renderPage } from "../../test/render";
import { latestLoginCode } from "../../test/tooling";

const PASSWORD = "password1234";
const uniqueEmail = () => `dom-${crypto.randomUUID()}@qmail.com`;

type User = ReturnType<typeof userEvent.setup>;

/** Fill the six PinInput boxes; the last keystroke fires onComplete → submit. */
async function fillCode(user: User, code: string): Promise<void> {
  // PinInput renders 6 visible boxes (+ a hidden aggregate input we skip).
  const boxes = document.querySelectorAll<HTMLInputElement>(".mantine-PinInput-input");
  expect(boxes.length).toBe(6);
  for (let i = 0; i < 6; i++) {
    const box = boxes[i];
    if (!box) throw new Error(`missing pin input ${i}`);
    await user.type(box, code[i] ?? "");
  }
}

async function submitDetails(user: User, email: string): Promise<void> {
  // The memory router mounts the route asynchronously; wait for it.
  await screen.findByText("Create your account");
  // Select by input type: Mantine's PasswordInput wraps its inner input, so
  // RTL's label association doesn't reach it. In phase 1 there's exactly one
  // of each.
  const emailInput = document.querySelector<HTMLInputElement>('input[type="email"]');
  const passwordInput = document.querySelector<HTMLInputElement>('input[type="password"]');
  if (!emailInput || !passwordInput) throw new Error("register form inputs not found");
  await user.type(emailInput, email);
  await user.type(passwordInput, PASSWORD);
  await user.click(screen.getByRole("button", { name: "Create account" }));
  await screen.findByText(/We emailed a 6-digit code/i);
}

describe("RegisterPage — real transport against the running stack", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("register → emailed code → auto-login lands in the app", async () => {
    const user = userEvent.setup();
    const email = uniqueEmail();
    renderPage(RegisterPage);

    await submitDetails(user, email);

    const code = await latestLoginCode(email);
    await fillCode(user, code);

    // Reaching the home stub proves activate AND login both succeeded (login
    // 422s until the account is activated), and the key was stored.
    await screen.findByText(HOME_MARKER);
    expect(localStorage.getItem("virtu.apiKey")).toBeTruthy();
  });

  test("a wrong code surfaces the API error and stays on the code step", async () => {
    const user = userEvent.setup();
    const email = uniqueEmail();
    renderPage(RegisterPage);

    await submitDetails(user, email);

    const code = await latestLoginCode(email);
    const wrong = code.slice(0, 5) + ((Number(code[5]) + 1) % 10);
    await fillCode(user, wrong);

    await screen.findByText("Wrong email or code");
    expect(localStorage.getItem("virtu.apiKey")).toBeNull();
  });
});
