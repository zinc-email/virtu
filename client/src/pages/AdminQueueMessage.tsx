// Admin queue detail ("/admin/queue/$messageId") — one row's envelope and
// error state, the allowlisted routing headers (never Subject or body), the
// owner decoded from VERP, and the operator actions, each behind a native
// Dialog confirm:
//
//   Requeue — failed rows with raw intact: back to pending, tries reset.
//   Bounce  — DSN the originator, then failed ("bounced by operator"); only
//             when the return path decodes to a forward/reply VERP. Never
//             advances the alias auto-disable ledger.
//   Drop    — pending/sending: failed silently, no DSN.
//   Delete  — terminal rows: gone now, ahead of retention.

import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { css } from "styled-system/css";
import {
  getAdminOverviewQueryKey,
  getAdminQueueMessageIdQueryKey,
  getAdminQueueQueryKey,
  useGetAdminQueueMessageId,
  usePostAdminQueueBounce,
  usePostAdminQueueDelete,
  usePostAdminQueueDrop,
  usePostAdminQueueRequeue,
} from "src/gen";
import { Dialog } from "src/overlays";
import { Alert, Button, KeyValue, KV, Section, Tag, Tags, ui } from "src/ui";
import { useHead } from "src/head";
import { apiErrorMessage } from "src/api/errors";
import { AdminErrorAlert, STATUS_TONE, timeAgo } from "src/pages/adminCommon";
import { NotFoundPage } from "src/pages/NotFound";

const h2 = css({ marginTop: "2.5rem", marginBottom: "0.5rem" });

type ConfirmKind = "drop" | "bounce" | "delete";

export function AdminQueueMessagePage() {
  const { messageId } = useParams({ from: "/admin/queue/$messageId" });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState<ConfirmKind | null>(null);

  const id = Number(messageId);
  useHead({ title: `Queue #${id}` });
  const detail = useGetAdminQueueMessageId(id);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: getAdminQueueQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getAdminOverviewQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getAdminQueueMessageIdQueryKey(id) });
  };
  const closeAndRefresh = () => {
    setConfirm(null);
    invalidate();
  };
  const backToQueue = () => {
    closeAndRefresh();
    void navigate({ to: "/admin/queue" });
  };
  const drop = usePostAdminQueueDrop({ mutation: { onSuccess: backToQueue } });
  const bounce = usePostAdminQueueBounce({ mutation: { onSuccess: closeAndRefresh } });
  const del = usePostAdminQueueDelete({
    mutation: {
      onSuccess: () => {
        setConfirm(null);
        // The row is gone: REMOVE its detail query (a refetch would 404 and
        // flash the error state before navigation unmounts this page).
        queryClient.removeQueries({ queryKey: getAdminQueueMessageIdQueryKey(id) });
        void queryClient.invalidateQueries({ queryKey: getAdminQueueQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getAdminOverviewQueryKey() });
        void navigate({ to: "/admin/queue" });
      },
    },
  });
  const requeue = usePostAdminQueueRequeue({ mutation: { onSuccess: invalidate } });

  // A non-numeric id can't exist: same not-found page as any bogus URL
  // (the generated hook auto-disables on NaN, which would otherwise leave
  // this page as a permanent spinner).
  if (!Number.isInteger(id) || id < 1) {
    return <NotFoundPage />;
  }

  if (detail.isPending) {
    return (
      <Section narrow>
        <p className={css({ textAlign: "center", padding: "2rem", color: "textDim" })}>Loading…</p>
      </Section>
    );
  }
  if (detail.isError) {
    return (
      <Section narrow>
        <AdminErrorAlert error={detail.error} />
      </Section>
    );
  }

  const { message, headers, owner } = detail.data;
  const droppable = message.status === "pending" || message.status === "sending";
  const requeueable = message.status === "failed" && message.size_bytes > 0;
  // Bounce needs a decodable forward/reply return path and the raw bytes
  // (the DSN quotes the original headers); the server re-checks all of it.
  const bounceable =
    message.status !== "sent" &&
    message.size_bytes > 0 &&
    (message.verp_type === "bounce_forward" || message.verp_type === "bounce_reply");
  const deletable = message.status === "failed" || message.status === "sent";

  return (
    <Section narrow>
      <header className={css({ marginBottom: "2.11rem" })}>
        <h1 className={ui.h1}>Queue #{message.id}.</h1>
        <Tags>
          <Tag tone={STATUS_TONE[message.status]}>{message.status}</Tag>
          {message.verp_type !== null && <Tag tone="neutral">{message.verp_type}</Tag>}
        </Tags>
      </header>

      {drop.isError && <Alert>{apiErrorMessage(drop.error)}</Alert>}
      {bounce.isError && <Alert>{apiErrorMessage(bounce.error)}</Alert>}
      {del.isError && <Alert>{apiErrorMessage(del.error)}</Alert>}
      {requeue.isError && <Alert>{apiErrorMessage(requeue.error)}</Alert>}
      {bounce.isSuccess && bounce.data.bounced === 0 && (
        <Alert>
          Not bounced: {bounce.data.skipped.map((s) => s.reason.replaceAll("_", " ")).join(", ")}.
        </Alert>
      )}

      <KeyValue>
        <KV k="To">{message.envelope_to}</KV>
        <KV k="Return path">{message.envelope_from === "" ? "(null — no bounces)" : "VERP"}</KV>
        <KV k="Tries">{message.tries}</KV>
        <KV k="Next attempt">{new Date(message.next_attempt_at).toLocaleString()}</KV>
        <KV k="Created">{`${new Date(message.created_at).toLocaleString()} (${timeAgo(message.created_at)})`}</KV>
        <KV k="Size">
          {message.size_bytes === 0 ? "raw cleared (delivered)" : `${message.size_bytes} bytes`}
        </KV>
        {message.last_error !== null && <KV k="Last error">{message.last_error}</KV>}
      </KeyValue>

      <h2 className={h2}>Owner</h2>
      {owner === null ? (
        <p className={css({ color: "textDim" })}>
          No VERP mapping — a system message (DSN, trash copy) or an expired return path.
        </p>
      ) : (
        <KeyValue>
          {owner.user !== null && <KV k="User">{owner.user.email}</KV>}
          {owner.alias !== null && <KV k="Alias">{owner.alias.email}</KV>}
          {owner.email_log_id !== null && <KV k="Email log">#{owner.email_log_id}</KV>}
          {owner.verification_code_id !== null && (
            <KV k="Verification code">#{owner.verification_code_id}</KV>
          )}
        </KeyValue>
      )}

      <h2 className={h2}>Routing headers</h2>
      {headers.length === 0 ? (
        <p className={css({ color: "textDim" })}>
          {message.size_bytes === 0
            ? "None — the raw bytes were cleared after delivery."
            : "None on the allowlist."}
        </p>
      ) : (
        <KeyValue>
          {headers.map((h, i) => (
            <KV key={`${h.name}-${i}`} k={h.name}>
              <span className={ui.mono}>{h.value}</span>
            </KV>
          ))}
        </KeyValue>
      )}

      {(droppable || requeueable || bounceable || deletable) && (
        <div className={css({ marginTop: "3rem" })}>
          <div className={ui.actionsCenter}>
            {requeueable && (
              <Button
                size="tiny"
                loading={requeue.isPending}
                onClick={() => requeue.mutate({ data: { ids: [message.id] } })}
              >
                Requeue now
              </Button>
            )}
            {bounceable && (
              <Button size="tiny" variant="outline" onClick={() => setConfirm("bounce")}>
                Bounce
              </Button>
            )}
            {droppable && (
              <Button size="tiny" variant="outline" onClick={() => setConfirm("drop")}>
                Drop
              </Button>
            )}
            {deletable && (
              <Button size="tiny" variant="outline" onClick={() => setConfirm("delete")}>
                Delete
              </Button>
            )}
          </div>
        </div>
      )}

      <Dialog
        opened={confirm !== null}
        onClose={() => setConfirm(null)}
        title={
          confirm === "bounce"
            ? "Bounce this message?"
            : confirm === "delete"
              ? "Delete this message?"
              : "Drop this message?"
        }
      >
        {confirm === "bounce" ? (
          <p>
            The sender gets a standard failure notice and #{message.id} is marked failed — it will
            never be delivered. The alias's bounce ledger is not affected.
          </p>
        ) : confirm === "delete" ? (
          <p>
            #{message.id} is removed from the queue permanently, ahead of retention. There is no
            undo{message.status === "failed" ? " — a deleted row can no longer be requeued" : ""}.
          </p>
        ) : (
          <p>
            #{message.id} to {message.envelope_to} will be marked failed and never delivered. No
            bounce is sent — the sender learns nothing.
          </p>
        )}
        <div className={ui.actionsCenter}>
          <Button size="tiny" onClick={() => setConfirm(null)}>
            Cancel
          </Button>
          <Button
            size="tiny"
            variant="outline"
            loading={drop.isPending || bounce.isPending || del.isPending}
            onClick={() => {
              const data = { data: { ids: [message.id] } };
              if (confirm === "bounce") bounce.mutate(data);
              else if (confirm === "delete") del.mutate(data);
              else drop.mutate(data);
            }}
          >
            {confirm === "bounce"
              ? "Bounce message"
              : confirm === "delete"
                ? "Delete message"
                : "Drop message"}
          </Button>
        </div>
      </Dialog>
    </Section>
  );
}
