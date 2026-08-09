// Register page ("/register"): the two-step SimpleLogin sign-up, kept on one
// route so onboarding never bounces. Phase "details" registers the account
// (POST /auth/register emails a 6-digit code); phase "code" activates it
// (POST /auth/activate) and then logs in with the credentials still in state,
// so a fresh user lands straight on their aliases. Resend goes through
// /auth/reactivate. All three calls run through the generated SDK.

import {
  Alert,
  Anchor,
  Button,
  Group,
  Paper,
  PasswordInput,
  PinInput,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { apiErrorMessage } from "src/api/errors";
import { setApiKey } from "src/auth";
import {
  usePostAuthActivate,
  usePostAuthLogin,
  usePostAuthReactivate,
  usePostAuthRegister,
} from "src/gen";

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
    <Stack align="center" mt="4rem">
      <Title order={1}>virtu</Title>
      <Text c="dimmed">One alias per sign-up. Revoke when leaked.</Text>
      <Paper w="100%" maw="26rem" p="lg" radius="md" bg="dark.6">
        {phase === "details" ? (
          <form onSubmit={submitDetails}>
            <Stack>
              <Title order={3}>Create your account</Title>
              {register.isError && (
                <Alert color="red" variant="light">
                  {apiErrorMessage(register.error)}
                </Alert>
              )}
              <TextInput
                label="Email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.currentTarget.value)}
                error={email.length > 0 && !emailValid ? "Enter a valid email address" : null}
                required
              />
              <PasswordInput
                label="Password"
                description={`At least ${MIN_PASSWORD} characters`}
                value={password}
                onChange={(e) => setPassword(e.currentTarget.value)}
                error={password.length > 0 && !passwordValid ? "Too short" : null}
                required
              />
              <Button
                type="submit"
                loading={register.isPending}
                disabled={!emailValid || !passwordValid}
                color="brand.5"
                c="dark.8"
              >
                Create account
              </Button>
              <Text size="sm" c="dimmed" ta="center">
                Already have an account?{" "}
                <Anchor component={Link} to="/login" c="brand.5">
                  Log in
                </Anchor>
              </Text>
            </Stack>
          </form>
        ) : (
          <Stack>
            <Title order={3}>Enter your code</Title>
            <Text size="sm" c="dimmed">
              We emailed a 6-digit code to <b>{email}</b>. It expires in 15 minutes.
            </Text>
            {codeError && (
              <Alert color="red" variant="light">
                {codeError}
              </Alert>
            )}
            {reactivate.isSuccess && !reactivate.isError && (
              <Alert color="green" variant="light">
                A new code is on its way.
              </Alert>
            )}
            <Group justify="center">
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
            </Group>
            <Button
              onClick={() => submitCode(code)}
              loading={activate.isPending || login.isPending}
              disabled={code.length !== 6}
              color="brand.5"
              c="dark.8"
            >
              Verify &amp; continue
            </Button>
            <Group justify="space-between">
              <Anchor component="button" type="button" size="sm" c="dimmed" onClick={changeEmail}>
                Use a different email
              </Anchor>
              <Anchor
                component="button"
                type="button"
                size="sm"
                c="brand.5"
                onClick={() => reactivate.mutate({ data: { email: email.trim() } })}
                aria-disabled={reactivate.isPending}
              >
                {reactivate.isPending ? "Resending…" : "Resend code"}
              </Anchor>
            </Group>
          </Stack>
        )}
      </Paper>
    </Stack>
  );
}
