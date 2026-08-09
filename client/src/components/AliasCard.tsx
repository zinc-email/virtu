// One alias row: pin toggle, address + copy, enabled switch, note, mailbox
// list, activity counts, contacts and delete actions.

import {
  ActionIcon,
  Badge,
  Button,
  CopyButton,
  Group,
  Paper,
  Stack,
  Switch,
  Text,
} from "@mantine/core";
import type { Alias } from "src/gen";

interface Props {
  alias: Alias;
  toggling: boolean;
  pinning: boolean;
  onToggle: (alias: Alias) => void;
  onPin: (alias: Alias) => void;
  onContacts: (alias: Alias) => void;
  onDelete: (alias: Alias) => void;
}

/** Inline pushpin glyph (no icon dependency): filled when pinned. */
function PinIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 4h6l-1 7 3 3v1H7v-1l3-3z" />
      <path d="M12 15v6" />
    </svg>
  );
}

export function AliasCard({
  alias,
  toggling,
  pinning,
  onToggle,
  onPin,
  onContacts,
  onDelete,
}: Props) {
  return (
    <Paper p="md" radius="md" bg="dark.6" opacity={alias.enabled ? 1 : 0.6}>
      <Stack gap="xs">
        <Group justify="space-between" wrap="nowrap">
          <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
            <ActionIcon
              variant="subtle"
              color={alias.pinned ? "brand.5" : "gray"}
              size="sm"
              disabled={pinning}
              onClick={() => onPin(alias)}
              aria-label={alias.pinned ? "Unpin alias" : "Pin alias"}
              title={alias.pinned ? "Unpin" : "Pin"}
            >
              <PinIcon filled={alias.pinned} />
            </ActionIcon>
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

        {alias.mailboxes.length > 1 && (
          <Text size="xs" c="dimmed">
            Delivers to {alias.mailboxes.map((m) => m.email).join(", ")}
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
