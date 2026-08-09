// One alias row: address + copy, enabled switch, note, activity counts,
// contacts and delete actions.

import { Badge, Button, CopyButton, Group, Paper, Stack, Switch, Text } from "@mantine/core";
import type { Alias } from "src/gen";

interface Props {
  alias: Alias;
  toggling: boolean;
  onToggle: (alias: Alias) => void;
  onContacts: (alias: Alias) => void;
  onDelete: (alias: Alias) => void;
}

export function AliasCard({ alias, toggling, onToggle, onContacts, onDelete }: Props) {
  return (
    <Paper p="md" radius="md" bg="dark.6" opacity={alias.enabled ? 1 : 0.6}>
      <Stack gap="xs">
        <Group justify="space-between" wrap="nowrap">
          <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
            <Text fw={600} ff="monospace" truncate>
              {alias.email}
            </Text>
            <CopyButton value={alias.email}>
              {({ copied, copy }) => (
                <Button
                  size="compact-xs"
                  variant={copied ? "filled" : "light"}
                  color={copied ? "teal" : "brand.5"}
                  onClick={copy}
                >
                  {copied ? "Copied" : "Copy"}
                </Button>
              )}
            </CopyButton>
          </Group>
          <Switch
            checked={alias.enabled}
            disabled={toggling}
            onChange={() => onToggle(alias)}
            color="brand.5"
            size="md"
            aria-label={alias.enabled ? "Disable alias" : "Enable alias"}
          />
        </Group>

        {alias.note && (
          <Text size="sm" c="dimmed">
            {alias.note}
          </Text>
        )}

        <Group justify="space-between">
          <Group gap="xs">
            <Badge variant="light" color="gray" size="sm">
              {alias.nb_forward} forwarded
            </Badge>
            <Badge variant="light" color="gray" size="sm">
              {alias.nb_reply} replied
            </Badge>
            <Badge variant="light" color="gray" size="sm">
              {alias.nb_block} blocked
            </Badge>
          </Group>
          <Group gap="xs">
            <Button
              size="compact-sm"
              variant="subtle"
              color="brand.5"
              onClick={() => onContacts(alias)}
            >
              Contacts
            </Button>
            <Button size="compact-sm" variant="subtle" color="red" onClick={() => onDelete(alias)}>
              Delete
            </Button>
          </Group>
        </Group>
      </Stack>
    </Paper>
  );
}
