// Per-alias contacts drawer: list contacts (reverse aliases), create one,
// copy the reverse alias, block/unblock, delete.

import {
  Alert,
  Badge,
  Button,
  CopyButton,
  Divider,
  Drawer,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiErrorMessage } from "src/api/errors";
import {
  type Alias,
  getAliasesAliasIdContactsQueryKey,
  useDeleteContactsContactId,
  useGetAliasesAliasIdContacts,
  usePostAliasesAliasIdContacts,
  usePostContactsContactIdToggle,
} from "src/gen";

interface Props {
  alias: Alias | null;
  onClose: () => void;
}

export function ContactsDrawer({ alias, onClose }: Props) {
  const queryClient = useQueryClient();
  const [newContact, setNewContact] = useState("");
  const opened = alias !== null;
  const aliasId = alias?.id ?? -1;

  const contacts = useGetAliasesAliasIdContacts(
    aliasId,
    { page_id: "0" },
    { query: { enabled: opened } },
  );

  const invalidate = () =>
    void queryClient.invalidateQueries({
      queryKey: getAliasesAliasIdContactsQueryKey(aliasId, { page_id: "0" }),
    });

  const create = usePostAliasesAliasIdContacts({
    mutation: {
      onSuccess: () => {
        setNewContact("");
        invalidate();
      },
    },
  });
  const toggle = usePostContactsContactIdToggle({
    mutation: { onSuccess: invalidate },
  });
  const remove = useDeleteContactsContactId({
    mutation: { onSuccess: invalidate },
  });

  return (
    <Drawer
      opened={opened}
      onClose={() => {
        create.reset();
        setNewContact("");
        onClose();
      }}
      position="right"
      size="md"
      title={
        <Stack gap={0}>
          <Text fw={600}>Contacts</Text>
          <Text size="sm" c="dimmed" ff="monospace">
            {alias?.email}
          </Text>
        </Stack>
      }
    >
      <Stack gap="md">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!newContact.trim() || !alias) return;
            create.mutate({ alias_id: alias.id, data: { contact: newContact.trim() } });
          }}
        >
          <Stack gap="xs">
            <Group gap="xs" align="flex-end" wrap="nowrap">
              <TextInput
                label="New contact"
                placeholder="someone@example.com"
                value={newContact}
                onChange={(e) => setNewContact(e.currentTarget.value)}
                style={{ flex: 1 }}
              />
              <Button type="submit" loading={create.isPending}>
                Add
              </Button>
            </Group>
            {create.isError && (
              <Alert color="red" variant="light">
                {apiErrorMessage(create.error)}
              </Alert>
            )}
            <Text size="xs" c="dimmed">
              Sending to a contact's reverse alias delivers from your alias — the contact never sees
              your real address.
            </Text>
          </Stack>
        </form>

        <Divider />

        {contacts.isPending && opened ? (
          <Group justify="center" p="md">
            <Loader color="accent" size="sm" />
          </Group>
        ) : contacts.isError ? (
          <Alert color="red" variant="light">
            {apiErrorMessage(contacts.error)}
          </Alert>
        ) : (
          <Stack gap="sm">
            {contacts.data?.contacts.length === 0 && (
              <Text c="dimmed" size="sm" ta="center" p="md">
                No contacts yet. Add one to get its reverse alias.
              </Text>
            )}
            {contacts.data?.contacts.map((contact) => (
              <Paper key={contact.id} p="sm" radius="md" withBorder>
                <Stack gap={6}>
                  <Group justify="space-between" wrap="nowrap">
                    <Text size="sm" fw={500} truncate>
                      {contact.contact}
                    </Text>
                    {contact.block_forward && (
                      <Badge color="red" variant="light" size="sm">
                        Blocked
                      </Badge>
                    )}
                  </Group>
                  <Text size="xs" c="dimmed" ff="monospace" truncate>
                    {contact.reverse_alias_address}
                  </Text>
                  <Group gap="xs">
                    <CopyButton value={contact.reverse_alias_address}>
                      {({ copied, copy }) => (
                        <Button
                          size="compact-xs"
                          variant={copied ? "filled" : "light"}
                          color={copied ? "primary" : "accent"}
                          onClick={copy}
                        >
                          {copied ? "Copied" : "Copy reverse alias"}
                        </Button>
                      )}
                    </CopyButton>
                    <Button
                      size="compact-xs"
                      variant="subtle"
                      color={contact.block_forward ? "primary" : "yellow"}
                      loading={toggle.isPending && toggle.variables?.contact_id === contact.id}
                      onClick={() => toggle.mutate({ contact_id: contact.id })}
                    >
                      {contact.block_forward ? "Unblock" : "Block"}
                    </Button>
                    <Button
                      size="compact-xs"
                      variant="subtle"
                      color="red"
                      loading={remove.isPending && remove.variables?.contact_id === contact.id}
                      onClick={() => remove.mutate({ contact_id: contact.id })}
                    >
                      Delete
                    </Button>
                  </Group>
                </Stack>
              </Paper>
            ))}
          </Stack>
        )}
      </Stack>
    </Drawer>
  );
}
