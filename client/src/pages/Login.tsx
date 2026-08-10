// Login page — legacy auth styling: narrow centered column, commanding h1,
// old-style form fields, teal submit. Calls POST /api/auth/login via the
// generated SDK and stores the returned api_key.

import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { css, cx } from "styled-system/css";
import { apiErrorMessage } from "src/api/errors";
import { setApiKey } from "src/auth";
import { usePostAuthLogin } from "src/gen";
import { Alert, Button, Field, Section, ui } from "src/ui";

export function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

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

  return (
    <Section narrow>
      <header className={css({ textAlign: "center", marginBottom: "2.5rem" })}>
        <h1 className={ui.h1}>Welcome back.</h1>
        <p className={cx(ui.lead, ui.dim, css({ marginTop: "1rem" }))}>
          One alias per sign-up. Revoke when leaked.
        </p>
      </header>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          login.mutate({ data: { email, password, device: "virtu-web" } });
        }}
      >
        {login.isError && <Alert>{apiErrorMessage(login.error)}</Alert>}

        <Field
          label="Email"
          name="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.currentTarget.value)}
          required
        />
        <Field
          label="Password"
          name="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
          required
        />

        <div className={css({ marginTop: "2.42rem" })}>
          <Button
            type="submit"
            variant="submit"
            loading={login.isPending}
            className={css({ width: "100%" })}
          >
            Log in
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
          No account yet?{" "}
          <Link to="/register" className={ui.link}>
            Create one
          </Link>
        </p>
      </form>
    </Section>
  );
}
