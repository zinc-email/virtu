// Login page: calls the real POST /api/auth/login through the generated SDK
// and stores the returned api_key (SimpleLogin flow).

import { Alert, Button, Paper, PasswordInput, Stack, Text, TextInput, Title } from "@mantine/core";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { apiErrorMessage } from "src/api/errors";
import { setApiKey } from "src/auth";
import { usePostAuthLogin } from "src/gen";

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
    <Stack align="center" mt="4rem">
      <Title order={1}>virtu</Title>
      <Text c="dimmed">One alias per sign-up. Revoke when leaked.</Text>
      <Paper w="100%" maw="26rem" p="lg" radius="md" bg="dark.6">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            login.mutate({ data: { email, password, device: "virtu-web" } });
          }}
        >
          <Stack>
            {login.isError && (
              <Alert color="red" variant="light">
                {apiErrorMessage(login.error)}
              </Alert>
            )}
            <TextInput
              label="Email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.currentTarget.value)}
              required
            />
            <PasswordInput
              label="Password"
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
              required
            />
            <Button type="submit" loading={login.isPending} color="brand.5" c="dark.8">
              Log in
            </Button>
          </Stack>
        </form>
      </Paper>
    </Stack>
  );
}
