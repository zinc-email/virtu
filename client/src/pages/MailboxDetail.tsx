// Mailbox detail ("/mailboxes/$mailboxId") — the home of a mailbox's
// controls (verify, make default, trash inbox, delete). The index hides its
// row controls on small screens and taps land here. The shell shows the big
// back arrow on this page.

import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { css, cx } from "styled-system/css";
import { apiErrorMessage } from "src/api/errors";
import { DeleteDialog, VerifyDialog } from "src/components/MailboxDialogs";
import {
  getV2MailboxesQueryKey,
  type Mailbox,
  useGetV2Mailboxes,
  usePostMailboxesMailboxIdVerifyRequest,
  usePutMailboxesMailboxId,
} from "src/gen";
import { Alert, Button, EmailBreak, KV, KVSwitch, KeyValue, Section, ui } from "src/ui";

export function MailboxDetailPage() {
  const params = useParams({ strict: false });
  const mailboxId = Number(params.mailboxId);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [verifying, setVerifying] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // There is no GET-one endpoint (SimpleLogin parity); the list is small.
  const mailboxes = useGetV2Mailboxes();
  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: getV2MailboxesQueryKey() });

  const update = usePutMailboxesMailboxId({ mutation: { onSuccess: invalidate } });
  // Resume flow for a bounce-paused mailbox: email a fresh code, then the
  // same verify dialog — a successful code proof clears the suppression.
  const requestCode = usePostMailboxesMailboxIdVerifyRequest({
    mutation: { onSuccess: () => setVerifying(true) },
  });

  if (mailboxes.isPending) {
    return (
      <Section>
        <p className={css({ textAlign: "center", padding: "3rem", color: "textDim" })}>Loading…</p>
      </Section>
    );
  }
  if (mailboxes.isError) {
    return (
      <Section narrow>
        <Alert>{apiErrorMessage(mailboxes.error)}</Alert>
      </Section>
    );
  }

  const rows = mailboxes.data.mailboxes;
  const mailbox: Mailbox | undefined = rows.find((m) => m.id === mailboxId);
  if (!mailbox) {
    return (
      <Section narrow>
        <Alert>Mailbox not found.</Alert>
      </Section>
    );
  }
  const defaultMailbox = rows.find((m) => m.default);

  return (
    <Section>
      <header className={css({ textAlign: "center", padding: "0 2rem" })}>
        <h1
          className={cx(
            ui.h1,
            // Long mono addresses scale with the viewport so they break at
            // the <wbr> before @, not mid-word.
            css({ marginBottom: "1rem", fontSize: "clamp(1.25rem, 5.8vw, 2rem)" }),
          )}
        >
          <span className={ui.mono}>
            <EmailBreak email={mailbox.email} />
          </span>
        </h1>
        {update.isError && <Alert>{apiErrorMessage(update.error)}</Alert>}
      </header>

      <KeyValue>
        <KV k="Status">
          {mailbox.suppressed
            ? "Paused — mail was bouncing"
            : mailbox.verified
              ? "Verified"
              : "Not verified"}
        </KV>
        <KV k="Aliases">
          {mailbox.nb_alias === 1
            ? "1 alias delivers here"
            : `${mailbox.nb_alias} aliases deliver here`}
        </KV>
        {mailbox.verified && (
          <>
            <KVSwitch
              k="Default"
              checked={mailbox.default}
              // Some mailbox must always be the default — it can only move,
              // never switch off. The holder's switch is ON and locked.
              disabled={update.isPending || mailbox.default}
              onChange={(v) =>
                v && update.mutate({ mailbox_id: mailbox.id, data: { default: true } })
              }
              hint={
                mailbox.default
                  ? "New aliases deliver here. Make another mailbox default to change this."
                  : "Make new aliases deliver here."
              }
            />
            <KVSwitch
              k="Trash inbox"
              checked={mailbox.trash}
              disabled={update.isPending}
              onChange={(v) => update.mutate({ mailbox_id: mailbox.id, data: { trash: v } })}
              hint="Mail for aliases you turned off lands here instead of disappearing."
            />
          </>
        )}
      </KeyValue>

      {!mailbox.verified && (
        // A typo'd address will never verify — delete stays available below.
        <div className={ui.actionsCenter}>
          <Button onClick={() => setVerifying(true)}>Enter code</Button>
        </div>
      )}

      {mailbox.suppressed && (
        <>
          <p
            className={css({
              margin: "2rem auto 0",
              maxWidth: "34rem",
              padding: "0 2rem",
              color: "textDim",
              fontSize: "0.9rem",
            })}
          >
            This mailbox rejected forwarded mail as undeliverable, so forwarding to it is paused for
            every alias that delivers here — incoming mail is dropped while paused. Once the mailbox
            works again, re-verify it to resume.
          </p>
          {requestCode.isError && (
            <div className={css({ margin: "1rem auto 0", maxWidth: "34rem", padding: "0 2rem" })}>
              <Alert>{apiErrorMessage(requestCode.error)}</Alert>
            </div>
          )}
          <div className={cx(ui.actionsCenter, css({ marginTop: "1.5rem" }))}>
            <Button
              loading={requestCode.isPending}
              onClick={() => requestCode.mutate({ mailbox_id: mailbox.id })}
            >
              Re-verify this mailbox
            </Button>
          </div>
        </>
      )}

      {!mailbox.default && (
        <div className={cx(ui.actionsCenter, css({ marginTop: "4rem" }))}>
          <Button variant="link" onClick={() => setConfirmingDelete(true)}>
            » Delete this mailbox
          </Button>
        </div>
      )}

      {verifying && (
        <VerifyDialog
          mailbox={mailbox}
          onClose={() => setVerifying(false)}
          onVerified={invalidate}
        />
      )}
      {confirmingDelete && (
        <DeleteDialog
          mailbox={mailbox}
          defaultMailbox={defaultMailbox}
          onClose={() => setConfirmingDelete(false)}
          onDeleted={() => {
            invalidate();
            void navigate({ to: "/mailboxes" });
          }}
        />
      )}
    </Section>
  );
}
