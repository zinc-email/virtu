// Create-alias modal: GET /v5/alias/options -> prefix input + suffix picker
// (+ mailboxes + note), POST /v3/alias/custom/new. A 412 (signed suffix
// expired) refetches options so the user can retry immediately.

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { css } from "styled-system/css";
import { apiErrorMessage } from "src/api/errors";
import {
  getStatsQueryKey,
  getV2AliasesQueryKey,
  useGetV2Mailboxes,
  useGetV5AliasOptions,
  usePostV3AliasCustomNew,
} from "src/gen";
import { Dialog } from "src/overlays";
import { Alert, Button, CheckboxGroup, Field, SelectField, TextArea } from "src/ui";

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

  const suffixOptions =
    options.data?.suffixes.map((s) => ({ value: s.signed_suffix, label: s.suffix })) ?? [];
  const mailboxOptions =
    mailboxes.data?.mailboxes.map((m) => ({ value: String(m.id), label: m.email })) ?? [];
  const chosenSuffix = options.data?.suffixes.find((s) => s.signed_suffix === signedSuffix);
  const canSubmit =
    prefix.trim().length > 0 &&
    signedSuffix !== null &&
    mailboxIds.length > 0 &&
    options.data?.can_create !== false;

  return (
    <Dialog opened={opened} onClose={handleClose} title="New alias">
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
        {options.data?.can_create === false && (
          <Alert>You have reached your alias limit. Upgrade to create more aliases.</Alert>
        )}
        {create.isError && <Alert>{apiErrorMessage(create.error)}</Alert>}

        <div className={css({ display: "flex", gap: "0.75rem", alignItems: "flex-start" })}>
          <div className={css({ flex: "1 1 55%", minWidth: 0 })}>
            <Field
              label="Alias"
              name="alias-prefix"
              placeholder="prefix"
              value={prefix}
              onChange={(e) => setPrefix(e.currentTarget.value)}
              autoFocus
            />
          </div>
          <div className={css({ flex: "1 1 45%", minWidth: 0 })}>
            <SelectField
              label="Suffix"
              name="alias-suffix"
              options={suffixOptions}
              value={signedSuffix ?? ""}
              onChange={(e) => setSignedSuffix(e.currentTarget.value)}
            />
          </div>
        </div>

        {chosenSuffix && prefix.trim() && (
          <p className={css({ margin: "0 0 1.2rem 0", fontSize: "0.9rem", color: "textDim" })}>
            Will create{" "}
            <span className={css({ fontFamily: "mono", color: "primary" })}>
              {prefix.trim().toLowerCase()}
              {chosenSuffix.suffix}
            </span>
          </p>
        )}

        <CheckboxGroup
          label="Mailboxes"
          hint="Where forwarded emails arrive (the first is the primary)"
          options={mailboxOptions}
          value={mailboxIds}
          onChange={setMailboxIds}
        />

        <TextArea
          label="Note"
          name="alias-note"
          placeholder="Where is this alias used?"
          value={note}
          onChange={(e) => setNote(e.currentTarget.value)}
        />

        <div className={css({ display: "flex", justifyContent: "flex-end", gap: "0.75rem" })}>
          <Button type="button" size="tiny" onClick={handleClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="submit"
            size="tiny"
            className={css({ fontSize: "0.7rem" })}
            loading={create.isPending}
            disabled={!canSubmit}
          >
            Create alias
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
