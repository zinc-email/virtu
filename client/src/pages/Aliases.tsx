// The alias-management dashboard ("/"): account header, stats, filterable
// alias list with enabled toggles / copy / delete-with-confirm, the
// create-alias modal, and the per-alias contacts drawer. All data flows
// through the Kubb-generated hooks.

import {
  Alert,
  Badge,
  Button,
  Group,
  Loader,
  Modal,
  SegmentedControl,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { apiErrorMessage } from "src/api/errors";
import { clearApiKey } from "src/auth";
import { AliasCard } from "src/components/AliasCard";
import { ContactsDrawer } from "src/components/ContactsDrawer";
import { CreateAliasModal } from "src/components/CreateAliasModal";
import {
  type Alias,
  getLogout,
  getStatsQueryKey,
  getV2AliasesQueryKey,
  useDeleteAliasesAliasId,
  useGetStats,
  useGetUserInfo,
  useGetV2Aliases,
  usePostAliasesAliasIdToggle,
} from "src/gen";

type Filter = "all" | "enabled" | "disabled";

const PAGE_SIZE = 20;

export function AliasesPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState<Filter>("all");
  const [creating, setCreating] = useState(false);
  const [contactsFor, setContactsFor] = useState<Alias | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Alias | null>(null);

  const userInfo = useGetUserInfo();
  const stats = useGetStats();

  const params = {
    page_id: String(page),
    // Presence-based filters: the empty string makes axios send `enabled=`.
    ...(filter === "enabled" ? { enabled: "" } : {}),
    ...(filter === "disabled" ? { disabled: "" } : {}),
  };
  const aliases = useGetV2Aliases(params);

  const invalidateAliases = () => {
    void queryClient.invalidateQueries({ queryKey: getV2AliasesQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getStatsQueryKey() });
  };

  const toggle = usePostAliasesAliasIdToggle({
    mutation: { onSuccess: invalidateAliases },
  });
  const remove = useDeleteAliasesAliasId({
    mutation: {
      onSuccess: () => {
        setDeleteTarget(null);
        invalidateAliases();
      },
    },
  });

  const logout = async () => {
    try {
      await getLogout(); // revokes the api key server-side
    } catch {
      // Key may already be dead — local logout proceeds either way.
    }
    clearApiKey();
    void navigate({ to: "/login" });
  };

  const rows = aliases.data?.aliases ?? [];
  const hasNextPage = rows.length === PAGE_SIZE;

  return (
    <Stack mt="3rem" mb="4rem" gap="lg">
      <Group justify="space-between" align="flex-start">
        <Stack gap={4}>
          <Title order={2}>Aliases</Title>
          {userInfo.data && (
            <Group gap="xs">
              <Text size="sm" c="dimmed">
                {userInfo.data.email}
              </Text>
              {userInfo.data.is_premium ? (
                <Badge size="sm" color="brand.5" c="dark.8">
                  {userInfo.data.in_trial ? "Trial" : "Premium"}
                </Badge>
              ) : (
                <Badge size="sm" color="gray">
                  Free
                </Badge>
              )}
            </Group>
          )}
        </Stack>
        <Group gap="xs">
          <Button color="brand.5" c="dark.8" onClick={() => setCreating(true)}>
            New alias
          </Button>
          <Button variant="subtle" color="gray" onClick={() => void navigate({ to: "/billing" })}>
            Billing
          </Button>
          <Button variant="subtle" color="gray" onClick={() => void logout()}>
            Log out
          </Button>
        </Group>
      </Group>

      {stats.data && (
        <Group gap="xs">
          <Badge variant="light" color="brand.5">
            {stats.data.nb_alias} aliases
          </Badge>
          <Badge variant="light" color="gray">
            {stats.data.nb_forward} forwarded
          </Badge>
          <Badge variant="light" color="gray">
            {stats.data.nb_reply} replied
          </Badge>
          <Badge variant="light" color="gray">
            {stats.data.nb_block} blocked
          </Badge>
        </Group>
      )}

      <SegmentedControl
        value={filter}
        onChange={(v) => {
          setFilter(v as Filter);
          setPage(0);
        }}
        data={[
          { value: "all", label: "All" },
          { value: "enabled", label: "Enabled" },
          { value: "disabled", label: "Disabled" },
        ]}
        w="fit-content"
      />

      {aliases.isPending ? (
        <Stack align="center" p="xl">
          <Loader color="brand.5" />
        </Stack>
      ) : aliases.isError ? (
        <Alert color="red" variant="light">
          {apiErrorMessage(aliases.error)}
        </Alert>
      ) : rows.length === 0 ? (
        <Stack align="center" p="xl" gap="xs">
          <Text c="dimmed">
            {filter === "all" && page === 0
              ? "No aliases yet. Create one alias per sign-up; revoke it when it leaks."
              : "Nothing here."}
          </Text>
          {filter === "all" && page === 0 && (
            <Button color="brand.5" c="dark.8" onClick={() => setCreating(true)}>
              Create your first alias
            </Button>
          )}
        </Stack>
      ) : (
        <Stack gap="sm">
          {rows.map((alias) => (
            <AliasCard
              key={alias.id}
              alias={alias}
              toggling={toggle.isPending && toggle.variables?.alias_id === alias.id}
              onToggle={(a) => toggle.mutate({ alias_id: a.id })}
              onContacts={setContactsFor}
              onDelete={setDeleteTarget}
            />
          ))}
        </Stack>
      )}

      {(page > 0 || hasNextPage) && (
        <Group justify="center" gap="xs">
          <Button
            variant="subtle"
            color="gray"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            Previous
          </Button>
          <Text size="sm" c="dimmed">
            Page {page + 1}
          </Text>
          <Button
            variant="subtle"
            color="gray"
            disabled={!hasNextPage}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </Group>
      )}

      <CreateAliasModal opened={creating} onClose={() => setCreating(false)} />
      <ContactsDrawer alias={contactsFor} onClose={() => setContactsFor(null)} />

      <Modal
        opened={deleteTarget !== null}
        onClose={() => {
          remove.reset();
          setDeleteTarget(null);
        }}
        title="Delete alias"
        centered
      >
        <Stack>
          <Text size="sm">
            Delete{" "}
            <Text span ff="monospace" c="brand.5">
              {deleteTarget?.email}
            </Text>
            ? Emails sent to it will bounce, and the address can never be used again.
          </Text>
          {remove.isError && (
            <Alert color="red" variant="light">
              {apiErrorMessage(remove.error)}
            </Alert>
          )}
          <Group justify="flex-end">
            <Button variant="subtle" color="gray" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              color="red"
              loading={remove.isPending}
              onClick={() => deleteTarget && remove.mutate({ alias_id: deleteTarget.id })}
            >
              Delete forever
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
