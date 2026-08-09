// Settings ("/settings"): alias generator, random-alias suffix + default
// domain, sender address format, notification emails — wired to
// GET/PATCH /setting and GET /v2/setting/domains through the Kubb hooks.
// Every control saves on change.

import {
  Alert,
  Button,
  Group,
  Loader,
  Paper,
  Select,
  Stack,
  Switch,
  Text,
  Title,
} from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { apiErrorMessage } from "src/api/errors";
import {
  getSettingQueryKey,
  type UpdateSettingRequest,
  useGetSetting,
  useGetV2SettingDomains,
  usePatchSetting,
} from "src/gen";

const GENERATOR_OPTIONS = [
  { value: "word", label: "Random words (breeze_cedar123)" },
  { value: "uuid", label: "UUID (8d39e4b6-…)" },
];

const SUFFIX_OPTIONS = [
  { value: "random_string", label: "Random characters (.xk3f9)" },
  { value: "word", label: "Random word (.cedar381)" },
];

// SimpleLogin's sender_format variants, illustrated with its docs' example.
const SENDER_FORMAT_OPTIONS = [
  { value: "AT", label: "John Wick - john at wick.com" },
  { value: "A", label: "John Wick - john(a)wick.com" },
  { value: "NAME_ONLY", label: "John Wick" },
  { value: "AT_ONLY", label: "john at wick.com" },
  { value: "NO_NAME", label: "No name" },
];

export function SettingsPage() {
  const queryClient = useQueryClient();
  const setting = useGetSetting();
  const domains = useGetV2SettingDomains();

  const update = usePatchSetting({
    mutation: {
      onSuccess: (data) => {
        queryClient.setQueryData(getSettingQueryKey(), data);
      },
    },
  });
  const save = (patch: UpdateSettingRequest) => update.mutate({ data: patch });

  const domainData =
    domains.data?.map((d) => ({
      value: d.domain,
      label: d.is_custom ? `${d.domain} (custom domain)` : d.domain,
    })) ?? [];

  return (
    <Stack mt="3rem" mb="4rem" gap="lg">
      <Group justify="space-between" align="flex-start">
        <Title order={2}>Settings</Title>
        <Button component={Link} to="/" variant="subtle" color="gray">
          Back to aliases
        </Button>
      </Group>

      {setting.isPending ? (
        <Stack align="center" p="xl">
          <Loader color="brand.5" />
        </Stack>
      ) : setting.isError ? (
        <Alert color="red" variant="light">
          {apiErrorMessage(setting.error)}
        </Alert>
      ) : (
        <Stack gap="md">
          {update.isError && (
            <Alert color="red" variant="light">
              {apiErrorMessage(update.error)}
            </Alert>
          )}

          <Paper p="md" radius="md" bg="dark.6">
            <Stack gap="sm">
              <Title order={4}>Random aliases</Title>
              <Select
                label="Alias generator"
                description="How addresses for one-click random aliases are built"
                data={GENERATOR_OPTIONS}
                value={setting.data.alias_generator}
                onChange={(v) => v && save({ alias_generator: v })}
                allowDeselect={false}
                disabled={update.isPending}
                comboboxProps={{ withinPortal: false }}
              />
              <Select
                label="Default domain"
                description="The domain random aliases are created on"
                data={domainData}
                value={setting.data.random_alias_default_domain}
                onChange={(v) => v && save({ random_alias_default_domain: v })}
                allowDeselect={false}
                disabled={update.isPending || domains.isPending}
                comboboxProps={{ withinPortal: false }}
              />
              <Select
                label="Custom-alias suffix"
                description="The random suffix offered when creating a custom alias"
                data={SUFFIX_OPTIONS}
                value={setting.data.random_alias_suffix}
                onChange={(v) => v && save({ random_alias_suffix: v })}
                allowDeselect={false}
                disabled={update.isPending}
                comboboxProps={{ withinPortal: false }}
              />
            </Stack>
          </Paper>

          <Paper p="md" radius="md" bg="dark.6">
            <Stack gap="sm">
              <Title order={4}>Forwarded mail</Title>
              <Select
                label="Sender address format"
                description="How the original sender appears on emails forwarded to you"
                data={SENDER_FORMAT_OPTIONS}
                value={setting.data.sender_format}
                onChange={(v) => v && save({ sender_format: v })}
                allowDeselect={false}
                disabled={update.isPending}
                comboboxProps={{ withinPortal: false }}
              />
            </Stack>
          </Paper>

          <Paper p="md" radius="md" bg="dark.6">
            <Stack gap="sm">
              <Title order={4}>Notifications</Title>
              <Switch
                label="Email notifications"
                description="Receive account notification emails (bounce alerts etc.)"
                checked={setting.data.notification}
                onChange={(e) => save({ notification: e.currentTarget.checked })}
                color="brand.5"
                disabled={update.isPending}
              />
            </Stack>
          </Paper>

          {update.isSuccess && !update.isPending && (
            <Text size="sm" c="dimmed">
              Saved.
            </Text>
          )}
        </Stack>
      )}
    </Stack>
  );
}
