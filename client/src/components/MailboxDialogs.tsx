// The two mailbox dialogs, shared by the index ("/mailboxes") and the detail
// page ("/mailboxes/$mailboxId"): code verification (emailed 6-digit code)
// and deletion with the alias-transfer choice.

import { useState } from "react";
import { css } from "styled-system/css";
import { apiErrorMessage } from "src/api/errors";
import {
  type Mailbox,
  useDeleteMailboxesMailboxId,
  usePostMailboxesMailboxIdVerify,
} from "src/gen";
import { Dialog } from "src/overlays";
import { Alert, Button, PinInput } from "src/ui";

export function VerifyDialog({
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

export function DeleteDialog({
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
