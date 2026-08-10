// Register page ("/register"): the two-step SimpleLogin sign-up, kept on one
// route so onboarding never bounces. Phase "details" registers the account
// (POST /auth/register emails a 6-digit code); phase "code" activates it
// (POST /auth/activate) and then logs in with the credentials still in state,
// so a fresh user lands straight on their aliases. Resend goes through
// /auth/reactivate. All three calls run through the generated SDK.
//
// Legacy Panda styling, except the PinInput (Mantine) — the code boxes and
// their DOM-test selectors stay until a headless replacement lands.

import { PinInput } from "@mantine/core";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { css, cx } from "styled-system/css";
import { apiErrorMessage } from "src/api/errors";
import { setApiKey } from "src/auth";
import {
  usePostAuthActivate,
  usePostAuthLogin,
  usePostAuthReactivate,
  usePostAuthRegister,
} from "src/gen";
import { Alert, Button, Field, Section, ui } from "src/ui";

// Mirror the server's cheap guards (auth.ts) so obvious mistakes don't cost a
// round trip. The real validation still lives on the server.
const MIN_PASSWORD = 8;
function looksLikeEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function RegisterPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [phase, setPhase] = useState<"details" | "code">("details");
  // The homepage CTA (www CtaForm) submits GET /app/register?email=…; prefill it.
  const [email, setEmail] = useState(
    () => new URLSearchParams(location.searchStr).get("email") ?? "",
  );
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");

  const register = usePostAuthRegister({
    mutation: { onSuccess: () => setPhase("code") },
  });

  // After activation, log in with the credentials the user just entered.
  const login = usePostAuthLogin({
    mutation: {
      onSuccess: (data) => {
        if (data.api_key) {
          setApiKey(data.api_key);
          void navigate({ to: "/" });
        }
      },
    },
  });

  const activate = usePostAuthActivate({
    mutation: {
      onSuccess: () => login.mutate({ data: { email, password, device: "virtu-web" } }),
    },
  });

  const reactivate = usePostAuthReactivate();

  const emailValid = looksLikeEmail(email);
  const passwordValid = password.length >= MIN_PASSWORD;

  const submitDetails = (e: React.FormEvent) => {
    e.preventDefault();
    if (!emailValid || !passwordValid) return;
    register.mutate({ data: { email: email.trim(), password } });
  };

  const submitCode = (value: string) => {
    if (value.length !== 6 || activate.isPending || login.isPending) return;
    activate.mutate({ data: { email: email.trim(), code: value } });
  };

  const changeEmail = () => {
    setPhase("details");
    setCode("");
    activate.reset();
    login.reset();
    reactivate.reset();
    register.reset();
  };

  // In the code phase, surface whichever call last failed (activate → auto
  // login → resend). 410 means the code was retried too often; hint at resend.
  const codeError = activate.isError
    ? apiErrorMessage(activate.error)
    : login.isError
      ? apiErrorMessage(login.error)
      : reactivate.isError
        ? apiErrorMessage(reactivate.error)
        : null;

  return (
    <Section narrow>
      {phase === "details" ? (
        <form onSubmit={submitDetails}>
          <header className={css({ textAlign: "center", marginBottom: "2.5rem" })}>
            <h1 className={ui.h1}>Create your account</h1>
            <p className={cx(ui.lead, ui.dim, css({ marginTop: "1rem" }))}>
              One alias per sign-up. Revoke when leaked.
            </p>
          </header>

          {register.isError && <Alert>{apiErrorMessage(register.error)}</Alert>}

          <Field
            label="Email"
            name="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.currentTarget.value)}
            hint={email.length > 0 && !emailValid ? "Enter a valid email address" : undefined}
            required
          />
          <Field
            label="Password"
            name="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.currentTarget.value)}
            hint={
              password.length > 0 && !passwordValid
                ? "Too short"
                : `At least ${MIN_PASSWORD} characters`
            }
            required
          />

          <div className={css({ marginTop: "2.42rem" })}>
            <Button
              type="submit"
              variant="submit"
              loading={register.isPending}
              disabled={!emailValid || !passwordValid}
              className={css({ width: "100%" })}
            >
              Create account
            </Button>
          </div>

          <p
            className={css({
              marginTop: "1.6rem",
              textAlign: "center",
              color: "textDim",
              fontSize: "0.9rem",
            })}
          >
            Already have an account?{" "}
            <Link to="/login" className={ui.link}>
              Log in
            </Link>
          </p>
        </form>
      ) : (
        <div className={css({ textAlign: "center" })}>
          <header className={css({ marginBottom: "2rem" })}>
            <h1 className={ui.h1}>Enter your code</h1>
            <p className={cx(ui.lead, ui.dim, css({ marginTop: "1rem" }))}>
              We emailed a 6-digit code to <strong>{email}</strong>. It expires in 15 minutes.
            </p>
          </header>

          {codeError && <Alert>{codeError}</Alert>}
          {reactivate.isSuccess && !reactivate.isError && (
            <Alert kind="success">A new code is on its way.</Alert>
          )}

          <div className={css({ display: "flex", justifyContent: "center", marginBottom: "2rem" })}>
            <PinInput
              length={6}
              type="number"
              inputMode="numeric"
              oneTimeCode
              autoFocus
              value={code}
              onChange={(v) => {
                setCode(v);
                if (activate.isError) activate.reset();
              }}
              onComplete={submitCode}
              aria-label="Activation code"
              disabled={activate.isPending || login.isPending}
            />
          </div>

          <Button
            variant="submit"
            onClick={() => submitCode(code)}
            loading={activate.isPending || login.isPending}
            disabled={code.length !== 6}
            className={css({ width: "100%" })}
          >
            Verify &amp; continue
          </Button>

          <div
            className={css({
              display: "flex",
              justifyContent: "space-between",
              marginTop: "1.6rem",
              fontSize: "0.9rem",
            })}
          >
            <button
              type="button"
              className={cx(ui.link, css({ color: "textDim", _hover: { color: "navLink" } }))}
              onClick={changeEmail}
            >
              Use a different email
            </button>
            <button
              type="button"
              className={ui.link}
              onClick={() => reactivate.mutate({ data: { email: email.trim() } })}
              aria-disabled={reactivate.isPending}
            >
              {reactivate.isPending ? "Resending…" : "Resend code"}
            </button>
          </div>
        </div>
      )}
    </Section>
  );
}
