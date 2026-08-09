// Authed shell: proves the whole pipeline by rendering GET /api/user_info
// through the generated react-query hook. Not the dashboard — just a shell.

import { Badge, Button, Group, Loader, Paper, Stack, Text, Title } from "@mantine/core";
import { useNavigate } from "@tanstack/react-router";
import { clearApiKey } from "src/auth";
import { useGetUserInfo } from "src/gen";

export function HomePage() {
  const navigate = useNavigate();
  const userInfo = useGetUserInfo();

  const logout = () => {
    clearApiKey();
    void navigate({ to: "/login" });
  };

  if (userInfo.isPending) {
    return (
      <Stack align="center" mt="4rem">
        <Loader color="brand.5" />
      </Stack>
    );
  }

  if (userInfo.isError) {
    return (
      <Stack align="center" mt="4rem">
        <Text>Could not load your account.</Text>
        <Button variant="outline" color="brand.5" onClick={logout}>
          Back to login
        </Button>
      </Stack>
    );
  }

  const user = userInfo.data;

  return (
    <Stack mt="3rem">
      <Group justify="space-between">
        <Title order={2}>Welcome{user.name ? `, ${user.name}` : ""}</Title>
        <Button variant="subtle" color="brand.5" onClick={logout}>
          Log out
        </Button>
      </Group>
      <Paper p="lg" radius="md" bg="dark.6">
        <Stack gap="xs">
          <Group>
            <Text c="dimmed" w="12rem">
              Email
            </Text>
            <Text>{user.email}</Text>
          </Group>
          <Group>
            <Text c="dimmed" w="12rem">
              Plan
            </Text>
            {user.is_premium ? (
              <Badge color="brand.5" c="dark.8">
                {user.in_trial ? "Trial" : "Premium"}
              </Badge>
            ) : (
              <Badge color="gray">Free ({user.max_alias_free_plan} aliases)</Badge>
            )}
          </Group>
          {user.in_trial && user.trial_end_timestamp !== null && (
            <Group>
              <Text c="dimmed" w="12rem">
                Trial ends
              </Text>
              <Text>{new Date(user.trial_end_timestamp * 1000).toLocaleDateString()}</Text>
            </Group>
          )}
        </Stack>
      </Paper>
      <Text c="dimmed" size="sm">
        Alias management lands with Lane E/F — this shell only proves login and user_info.
      </Text>
    </Stack>
  );
}
