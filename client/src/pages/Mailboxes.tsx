// Mailboxes ("/mailboxes") — the destination manager: every mailbox mail can
// be delivered to, with verification (emailed 6-digit code), the default
// mailbox for new aliases, the trash inbox (where mail for OFF aliases
// lands), and deletion with an alias-transfer choice.

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { css, cx } from "styled-system/css";
import { apiErrorMessage } from "src/api/errors";
import {
  getV2MailboxesQueryKey,
  type Mailbox,
  useDeleteMailboxesMailboxId,
  useGetV2Mailboxes,
  usePostMailboxes,
  usePostMailboxesMailboxIdVerify,
  usePutMailboxesMailboxId,
} from "src/gen";
import { Dialog } from "src/overlays";
import {
  Alert,
  Button,
  Checklist,
  EntityList,
  EntityRow,
  Field,
  PinInput,
  Section,
  ui,
} from "src/ui";

function mailboxDetail(mb: Mailbox): string {
  const parts = [mb.verified ? "Verified." : "Not verified."];
  parts.push(mb.nb_alias === 1 ? "1 alias." : `${mb.nb_alias} aliases.`);
  if (mb.default) parts.push("Default.");
  if (mb.trash) parts.push("Trash inbox.");
  return parts.join(" ");
}

function VerifyDialog({
  mailbox,
  onClose,
  onVerified,
}: {
  mailbox: Mailbox;
  onClose: () => void;
  onVerified: () => void;
}) {
  const [code, setCode] = useState("");
  const verify = usePostMailboxesMailboxIdVerify({
    mutation: {
      onSuccess: () => {
        onVerified();
        onClose();
      },
    },
  });

  return (
    <Dialog opened onClose={onClose} title="Check your inbox.">
      <p className={css({ marginBottom: "1.5rem", color: "textDim", fontSize: "0.9rem" })}>
        We emailed a 6-digit code to <strong>{mailbox.email}</strong>. Enter it to verify the
        mailbox.
      </p>
      {verify.isError && <Alert>{apiErrorMessage(verify.error)}</Alert>}
      <PinInput
        label="Verification code"
        value={code}
        onChange={setCode}
        autoFocus
        disabled={verify.isPending}
        onComplete={(complete) =>
          verify.mutate({ mailbox_id: mailbox.id, data: { code: complete } })
        }
      />
      <div className={css({ marginTop: "1.5rem", display: "flex", justifyContent: "flex-end" })}>
        <Button
          variant="submit"
          loading={verify.isPending}
          disabled={code.length !== 6}
          onClick={() => verify.mutate({ mailbox_id: mailbox.id, data: { code } })}
        >
          Verify
        </Button>
      </div>
    </Dialog>
  );
}

function DeleteDialog({
  mailbox,
  defaultMailbox,
  onClose,
  onDeleted,
}: {
  mailbox: Mailbox;
  defaultMailbox: Mailbox | undefined;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const remove = useDeleteMailboxesMailboxId({
    mutation: {
      onSuccess: () => {
        onDeleted();
        onClose();
      },
    },
  });
  const canTransfer = defaultMailbox !== undefined && mailbox.nb_alias > 0;

  return (
    <Dialog opened onClose={onClose} title="Delete this mailbox?">
      <p className={css({ marginBottom: "1.5rem", color: "textDim", fontSize: "0.9rem" })}>
        <strong>{mailbox.email}</strong>
        {mailbox.nb_alias > 0
          ? ` currently receives mail for ${mailbox.nb_alias === 1 ? "1 alias" : `${mailbox.nb_alias} aliases`}. ` +
            "Deleting it deletes the aliases it is the primary mailbox for; aliases that " +
            "only deliver an extra copy here just stop receiving that copy."
          : " receives mail for no aliases."}
      </p>
      {remove.isError && <Alert>{apiErrorMessage(remove.error)}</Alert>}
      <div className={css({ display: "flex", flexDirection: "column", gap: "0.75rem" })}>
        {canTransfer && (
          <Button
            loading={remove.isPending}
            onClick={() =>
              remove.mutate({
                mailbox_id: mailbox.id,
                data: { transfer_aliases_to: defaultMailbox.id },
              })
            }
          >
            Delete, move its aliases to {defaultMailbox.email}
          </Button>
        )}
        <Button
          variant="cta"
          loading={remove.isPending}
          onClick={() =>
            remove.mutate({ mailbox_id: mailbox.id, data: { transfer_aliases_to: -1 } })
          }
        >
          {mailbox.nb_alias > 0 ? "Delete mailbox AND its aliases" : "Delete mailbox"}
        </Button>
      </div>
    </Dialog>
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
  const update = usePutMailboxesMailboxId({ mutation: { onSuccess: invalidate } });

  const rows = mailboxes.data?.mailboxes ?? [];
  const defaultMailbox = rows.find((m) => m.default);

  const actionsFor = (mb: Mailbox) => {
    const deleteButton = (
      <Button size="tiny" variant="cta" onClick={() => setDeleting(mb)}>
        Delete
      </Button>
    );
    if (!mb.verified) {
      // A typo'd address will never verify — it must still be removable.
      return (
        <>
          <Button size="tiny" onClick={() => setVerifying(mb)}>
            Enter code
          </Button>
          {deleteButton}
        </>
      );
    }
    return (
      <>
        {!mb.default && (
          <Button
            size="tiny"
            disabled={update.isPending}
            onClick={() => update.mutate({ mailbox_id: mb.id, data: { default: true } })}
          >
            Make default
          </Button>
        )}
        <Button
          size="tiny"
          disabled={update.isPending}
          onClick={() => update.mutate({ mailbox_id: mb.id, data: { trash: !mb.trash } })}
        >
          {mb.trash ? "Clear trash" : "Use as trash"}
        </Button>
        {!mb.default && deleteButton}
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
        {update.isError && <Alert>{apiErrorMessage(update.error)}</Alert>}
        <div className={css({ display: "flex", gap: "0.75rem", alignItems: "flex-end" })}>
          <div className={css({ flex: 1, minWidth: 0, "& > div": { marginBottom: 0 } })}>
            <Field
              label="Add a mailbox"
              name="mailbox-email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.currentTarget.value)}
            />
          </div>
          <Button
            type="submit"
            variant="submit"
            loading={create.isPending}
            className={css({ padding: "1rem 1.5rem 0.75rem 1.5rem", whiteSpace: "nowrap" })}
          >
            + Add
          </Button>
        </div>
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
                title={mb.email}
                detail={mailboxDetail(mb)}
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
