// Customize-alias page ("/aliases/new") — the old create-alias modal grown
// into a narrow page: GET /v5/alias/options -> prefix input + suffix picker
// (+ mailboxes + note), POST /v3/alias/custom/new, then straight to the new
// alias's detail page. A 412 (signed suffix expired) refetches options so
// the user can retry immediately. The prefix/suffix pair sits side by side
// where it fits and stacks on phones.

import { useQueryClient } from "@tanstack/react-query";
import { useCanGoBack, useNavigate, useRouter } from "@tanstack/react-router";
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
import { Alert, Button, CheckboxGroup, Field, Section, SelectField, TextArea, ui } from "src/ui";

export function AliasNewPage() {
  const navigate = useNavigate();
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const queryClient = useQueryClient();
  const [prefix, setPrefix] = useState("");
  const [signedSuffix, setSignedSuffix] = useState<string | null>(null);
  const [mailboxIds, setMailboxIds] = useState<string[]>([]);
  const [mailboxesSeeded, setMailboxesSeeded] = useState(false);
  const [note, setNote] = useState("");

  // Signed suffixes expire — always arrive with a fresh set.
  const options = useGetV5AliasOptions(undefined, {
    query: { refetchOnMount: "always", staleTime: 0 },
  });
  const mailboxes = useGetV2Mailboxes();

  // Default the pickers once data arrives.
  useEffect(() => {
    const first = options.data?.suffixes[0];
    if (first && signedSuffix === null) setSignedSuffix(first.signed_suffix);
  }, [options.data, signedSuffix]);
  useEffect(() => {
    const def = mailboxes.data?.mailboxes.find((m) => m.default) ?? mailboxes.data?.mailboxes[0];
    if (def && !mailboxesSeeded) {
      setMailboxIds([String(def.id)]);
      setMailboxesSeeded(true);
    }
  }, [mailboxes.data, mailboxesSeeded]);

  const create = usePostV3AliasCustomNew({
    mutation: {
      onSuccess: (alias) => {
        void queryClient.invalidateQueries({ queryKey: getV2AliasesQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getStatsQueryKey() });
        void navigate({ to: "/aliases/$aliasId", params: { aliasId: String(alias.id) } });
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

  // Cancel mirrors the shell's back arrow: a real history back when there is
  // an in-app entry (restoring the index scroll), the index otherwise.
  const cancel = () => {
    if (canGoBack) router.history.back();
    else void navigate({ to: "/" });
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
    <Section narrow>
      <header className={css({ marginBottom: "2.11rem" })}>
        <h1 className={ui.h1}>Customize your alias.</h1>
      </header>

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

        <div
          className={css({
            display: "flex",
            gap: "0.75rem",
            alignItems: "flex-start",
            // Phones: the pair stacks — a squeezed select shows no text.
            "@media (max-width: 480px)": { flexDirection: "column", alignItems: "stretch" },
          })}
        >
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

        {chosenSuffix?.suffix.startsWith("@") && (
          <p className={css({ margin: "0 0 1.2rem 0", fontSize: "0.9rem", color: "textDim" })}>
            Without a random suffix, addresses like{" "}
            <span className={css({ fontFamily: "mono" })}>billing{chosenSuffix.suffix}</span> are
            easy to guess, and readable names make your aliases easier to link together.
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
          <Button type="button" size="tiny" onClick={cancel}>
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
    </Section>
  );
}
