// Mailboxes ("/mailboxes") — the destination manager: every mailbox mail can
// be delivered to, with verification (emailed 6-digit code), the default
// mailbox for new aliases, the trash inbox (where mail for OFF aliases
// lands), and deletion with an alias-transfer choice. Narrow/left-aligned
// like the domains index; rows link to the detail page, which owns the
// controls on small screens.

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { css, cx } from "styled-system/css";
import { apiErrorMessage } from "src/api/errors";
import { DeleteDialog, VerifyDialog } from "src/components/MailboxDialogs";
import { getV2MailboxesQueryKey, type Mailbox, useGetV2Mailboxes, usePostMailboxes } from "src/gen";
import {
  Alert,
  Button,
  Checklist,
  EntityList,
  EntityRow,
  Field,
  FieldRow,
  Section,
  Tag,
  Tags,
  ui,
} from "src/ui";

export function mailboxTags(mb: Mailbox) {
  return (
    <Tags>
      {/* Paused (bounce-suppressed) outranks Verified: it's the state that
          needs the user's attention — the detail page owns the fix. */}
      {mb.suppressed ? (
        <Tag tone="accent">Paused</Tag>
      ) : mb.verified ? (
        <Tag tone="primary">Verified</Tag>
      ) : (
        <Tag tone="accent">Not verified</Tag>
      )}
      <Tag>{mb.nb_alias === 1 ? "1 alias" : `${mb.nb_alias} aliases`}</Tag>
      {mb.default && <Tag>Default</Tag>}
      {mb.trash && <Tag>Trash inbox</Tag>}
    </Tags>
  );
}

export function MailboxesPage() {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [verifying, setVerifying] = useState<Mailbox | null>(null);
  const [deleting, setDeleting] = useState<Mailbox | null>(null);

  const mailboxes = useGetV2Mailboxes();
  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: getV2MailboxesQueryKey() });

  const create = usePostMailboxes({
    mutation: {
      onSuccess: (mb) => {
        setEmail("");
        invalidate();
        setVerifying(mb);
      },
    },
  });
  const rows = mailboxes.data?.mailboxes ?? [];
  const defaultMailbox = rows.find((m) => m.default);

  // Row controls only for the unverified state (a typo'd address will never
  // verify — it must be fixable without leaving the list). Verified mailboxes
  // are managed on their detail page; the row's detail line shows the state.
  const actionsFor = (mb: Mailbox) => {
    if (mb.verified) return null;
    return (
      <>
        <Button size="tiny" onClick={() => setVerifying(mb)}>
          Enter code
        </Button>
        <Button size="tiny" variant="cta" onClick={() => setDeleting(mb)}>
          Delete
        </Button>
      </>
    );
  };

  return (
    <Section narrow>
      <header className={css({ marginBottom: "2.11rem" })}>
        <h1 className={ui.h1}>Your mailboxes.</h1>
      </header>
      <p className={ui.lead}>Choose where your mail is delivered.</p>
      <Checklist
        items={[
          "Deliver an alias to several inboxes at once.",
          "New aliases go to your default mailbox.",
          <span key="trash">
            Pick a <strong>trash inbox</strong>: mail for aliases you turned off lands there instead
            of disappearing.
          </span>,
        ]}
      />

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = email.trim().toLowerCase();
          if (!trimmed) return;
          create.mutate({ data: { email: trimmed } });
        }}
        className={css({ marginTop: "2rem" })}
      >
        {create.isError && <Alert>{apiErrorMessage(create.error)}</Alert>}
        <FieldRow
          field={
            <Field
              label="Add a mailbox"
              name="mailbox-email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.currentTarget.value)}
            />
          }
          button={
            <Button
              type="submit"
              variant="submit"
              loading={create.isPending}
              className={css({ padding: "1rem 1.5rem 0.75rem 1.5rem", whiteSpace: "nowrap" })}
            >
              + Add
            </Button>
          }
        />
        <p className={cx(ui.finePrint, css({ marginTop: "0.8rem", marginBottom: 0 }))}>
          We'll email a 6-digit code to verify the address.
        </p>
      </form>

      <div className={css({ marginTop: "3rem" })}>
        {mailboxes.isPending ? (
          <p className={css({ textAlign: "center", padding: "2rem", color: "textDim" })}>
            Loading…
          </p>
        ) : mailboxes.isError ? (
          <Alert>{apiErrorMessage(mailboxes.error)}</Alert>
        ) : (
          <EntityList>
            {rows.map((mb) => (
              <EntityRow
                key={mb.id}
                to="/mailboxes/$mailboxId"
                params={{ mailboxId: String(mb.id) }}
                title={mb.email}
                detail={mailboxTags(mb)}
                // Below the desktop nav the controls hide — tap the row, the
                // detail page has them.
                hideMetaBelow="md"
                meta={actionsFor(mb)}
              />
            ))}
          </EntityList>
        )}
      </div>

      {verifying !== null && (
        <VerifyDialog
          mailbox={verifying}
          onClose={() => setVerifying(null)}
          onVerified={invalidate}
        />
      )}
      {deleting !== null && (
        <DeleteDialog
          mailbox={deleting}
          defaultMailbox={defaultMailbox}
          onClose={() => setDeleting(null)}
          onDeleted={invalidate}
        />
      )}
    </Section>
  );
}
