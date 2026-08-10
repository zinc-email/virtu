// Create-alias modal: GET /v5/alias/options -> prefix input + suffix picker
// (+ mailbox + note), POST /v3/alias/custom/new. A 412 (signed suffix
// expired) refetches options so the user can retry immediately.

import {
  Alert,
  Button,
  Group,
  Modal,
  MultiSelect,
  Select,
  Stack,
  Text,
  TextInput,
  Textarea,
} from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiErrorMessage } from "src/api/errors";
import {
  getStatsQueryKey,
  getV2AliasesQueryKey,
  useGetV2Mailboxes,
  useGetV5AliasOptions,
  usePostV3AliasCustomNew,
} from "src/gen";

interface Props {
  opened: boolean;
  onClose: () => void;
}

export function CreateAliasModal({ opened, onClose }: Props) {
  const queryClient = useQueryClient();
  const [prefix, setPrefix] = useState("");
  const [signedSuffix, setSignedSuffix] = useState<string | null>(null);
  const [mailboxIds, setMailboxIds] = useState<string[]>([]);
  const [mailboxesSeeded, setMailboxesSeeded] = useState(false);
  const [note, setNote] = useState("");

  const options = useGetV5AliasOptions(undefined, {
    query: { enabled: opened, refetchOnMount: "always", staleTime: 0 },
  });
  const mailboxes = useGetV2Mailboxes({ query: { enabled: opened } });

  // Default the pickers once data arrives.
  useEffect(() => {
    const first = options.data?.suffixes[0];
    if (opened && first && signedSuffix === null) setSignedSuffix(first.signed_suffix);
  }, [opened, options.data, signedSuffix]);
  useEffect(() => {
    const def = mailboxes.data?.mailboxes.find((m) => m.default) ?? mailboxes.data?.mailboxes[0];
    if (opened && def && !mailboxesSeeded) {
      setMailboxIds([String(def.id)]);
      setMailboxesSeeded(true);
    }
  }, [opened, mailboxes.data, mailboxesSeeded]);

  const create = usePostV3AliasCustomNew({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getV2AliasesQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getStatsQueryKey() });
        handleClose();
      },
      onError: (err) => {
        // Signed suffix expired: fetch fresh options so a retry can succeed.
        if (err.response?.status === 412) {
          setSignedSuffix(null);
          void options.refetch();
        }
      },
    },
  });

  const handleClose = () => {
    setPrefix("");
    setSignedSuffix(null);
    setMailboxIds([]);
    setMailboxesSeeded(false);
    setNote("");
    create.reset();
    onClose();
  };

  const suffixData =
    options.data?.suffixes.map((s) => ({ value: s.signed_suffix, label: s.suffix })) ?? [];
  const mailboxData =
    mailboxes.data?.mailboxes.map((m) => ({ value: String(m.id), label: m.email })) ?? [];
  const chosenSuffix = options.data?.suffixes.find((s) => s.signed_suffix === signedSuffix);
  const canSubmit =
    prefix.trim().length > 0 &&
    signedSuffix !== null &&
    mailboxIds.length > 0 &&
    options.data?.can_create !== false;

  return (
    <Modal opened={opened} onClose={handleClose} title="New alias" centered>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!canSubmit || signedSuffix === null || mailboxIds.length === 0) return;
          create.mutate({
            data: {
              alias_prefix: prefix.trim(),
              signed_suffix: signedSuffix,
              // The first entry becomes the primary mailbox.
              mailbox_ids: mailboxIds.map(Number),
              ...(note.trim() ? { note: note.trim() } : {}),
            },
          });
        }}
      >
        <Stack>
          {options.data?.can_create === false && (
            <Alert color="yellow" variant="light">
              You have reached your alias limit. Upgrade to create more aliases.
            </Alert>
          )}
          {create.isError && (
            <Alert color="red" variant="light">
              {apiErrorMessage(create.error)}
            </Alert>
          )}
          <Group align="flex-end" gap="xs" wrap="nowrap">
            <TextInput
              label="Alias"
              placeholder="prefix"
              value={prefix}
              onChange={(e) => setPrefix(e.currentTarget.value)}
              style={{ flex: 1 }}
              data-autofocus
            />
            <Select
              label="Suffix"
              data={suffixData}
              value={signedSuffix}
              onChange={setSignedSuffix}
              allowDeselect={false}
              w="14rem"
              comboboxProps={{ withinPortal: false }}
            />
          </Group>
          {chosenSuffix && prefix.trim() && (
            <Text size="sm" c="dimmed">
              Will create{" "}
              <Text span c="primary.4" ff="monospace">
                {prefix.trim().toLowerCase()}
                {chosenSuffix.suffix}
              </Text>
            </Text>
          )}
          <MultiSelect
            label="Mailboxes"
            description="Where forwarded emails arrive (the first is the primary)"
            data={mailboxData}
            value={mailboxIds}
            onChange={setMailboxIds}
            comboboxProps={{ withinPortal: false }}
          />
          <Textarea
            label="Note"
            placeholder="Where is this alias used?"
            value={note}
            onChange={(e) => setNote(e.currentTarget.value)}
            autosize
            minRows={2}
          />
          <Group justify="flex-end">
            <Button variant="subtle" color="gray" onClick={handleClose}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending} disabled={!canSubmit}>
              Create alias
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
