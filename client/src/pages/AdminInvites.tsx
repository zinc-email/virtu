// Admin invites ("/admin/invites") — mint, list and revoke signup invite
// codes (ABUSE.md Tier 0: SIGNUP_INVITE_ONLY gates /auth/verify graduation).
// No detail page: an invite is one row of state, so the revoke action lives
// on the index row (Dialog-confirmed), unlike entity indexes that link out.
// Used invites are the permanent invite graph — the server refuses to
// delete them, and the UI shows them without a revoke action.

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { css, cx } from "styled-system/css";
import { apiErrorMessage } from "src/api/errors";
import {
  getAdminInvitesQueryKey,
  useDeleteAdminInvitesId,
  useGetAdminInvites,
  usePostAdminInvites,
} from "src/gen";
import type { AdminInvite } from "src/gen";
import { Dialog } from "src/overlays";
import { Alert, Button, EntityList, EntityRow, Field, Section, Tag, Tags, ui } from "src/ui";
import { AdminErrorAlert, timeAgo } from "src/pages/adminCommon";

function inviteState(inv: AdminInvite): "used" | "expired" | "unused" {
  if (inv.used_at !== null) return "used";
  if (inv.expires_at !== null && new Date(inv.expires_at).getTime() < Date.now()) return "expired";
  return "unused";
}

const STATE_TONE = { unused: "primary", used: "neutral", expired: "accent" } as const;

export function AdminInvitesPage() {
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");
  const [count, setCount] = useState("1");
  const [revoke, setRevoke] = useState<AdminInvite | null>(null);

  const list = useGetAdminInvites();
  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: getAdminInvitesQueryKey() });

  const mint = usePostAdminInvites({
    mutation: {
      onSuccess: () => {
        setNote("");
        invalidate();
      },
    },
  });
  const del = useDeleteAdminInvitesId({
    mutation: {
      onSuccess: () => {
        setRevoke(null);
        invalidate();
      },
    },
  });

  const countNum = Number(count);
  const countValid = Number.isInteger(countNum) && countNum >= 1 && countNum <= 100;

  const submitMint = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!countValid || mint.isPending) return;
    mint.mutate({ data: { count: countNum, note: note.trim() === "" ? undefined : note.trim() } });
  };

  const rows = list.data?.invites ?? [];

  return (
    <Section narrow>
      <header className={css({ marginBottom: "2.11rem" })}>
        <h1 className={ui.h1}>Invites.</h1>
        {list.isSuccess && (
          <p className={css({ color: "textDim", marginTop: "0.5rem" })}>
            {list.data.unused} unused of {list.data.total}
          </p>
        )}
      </header>

      {mint.isError && <Alert>{apiErrorMessage(mint.error)}</Alert>}
      {mint.isSuccess && (
        <Alert kind="success">
          Minted:{" "}
          {mint.data.invites.map((i, idx) => (
            <span key={i.id}>
              {idx > 0 && ", "}
              <span className={ui.mono}>{i.code}</span>
            </span>
          ))}
        </Alert>
      )}

      <form onSubmit={submitMint}>
        <Field
          label="Note"
          name="note"
          placeholder="who this invite is for"
          value={note}
          onChange={(e) => setNote(e.currentTarget.value)}
        />
        <Field
          label="How many"
          name="count"
          type="number"
          value={count}
          onChange={(e) => setCount(e.currentTarget.value)}
        />
        <div className={css({ marginTop: "1.6rem" })}>
          <Button type="submit" variant="submit" loading={mint.isPending} disabled={!countValid}>
            Mint invite{countValid && countNum > 1 ? "s" : ""}
          </Button>
        </div>
      </form>

      <h2 className={css({ marginTop: "2.5rem", marginBottom: "0.5rem" })}>All invites</h2>
      {list.isPending ? (
        <p className={css({ textAlign: "center", padding: "2rem", color: "textDim" })}>Loading…</p>
      ) : list.isError ? (
        <AdminErrorAlert error={list.error} />
      ) : rows.length > 0 ? (
        <EntityList>
          {rows.map((inv) => {
            const state = inviteState(inv);
            return (
              <EntityRow
                key={inv.id}
                title={inv.code}
                detail={
                  <>
                    <Tags>
                      <Tag tone={STATE_TONE[state]}>{state}</Tag>
                    </Tags>
                    {inv.note !== null && (
                      <span className={css({ display: "block", marginTop: "0.4rem" })}>
                        {inv.note}
                      </span>
                    )}
                    {inv.created_by !== null && (
                      <span className={css({ display: "block", marginTop: "0.4rem" })}>
                        minted by {inv.created_by.email}
                      </span>
                    )}
                    {inv.used_by !== null && (
                      <span className={css({ display: "block", marginTop: "0.4rem" })}>
                        used by {inv.used_by.email}
                        {inv.used_at !== null && ` · ${timeAgo(inv.used_at)}`}
                      </span>
                    )}
                    {state !== "used" && (
                      <span className={css({ display: "block", marginTop: "0.8rem" })}>
                        <Button size="tiny" variant="outline" onClick={() => setRevoke(inv)}>
                          Revoke
                        </Button>
                      </span>
                    )}
                  </>
                }
                meta={
                  <span className={css({ color: "textDim", fontSize: "0.85rem" })}>
                    {timeAgo(inv.created_at)}
                  </span>
                }
                hideMetaBelow="xs"
              />
            );
          })}
        </EntityList>
      ) : (
        <p className={css({ textAlign: "center", padding: "2rem", color: "textDim" })}>
          No invites yet.
        </p>
      )}

      <Dialog opened={revoke !== null} onClose={() => setRevoke(null)} title="Revoke this invite?">
        <p>
          <span className={cx(ui.mono)}>{revoke?.code}</span> stops working immediately. Anyone
          holding it will need a new invite.
        </p>
        {del.isError && <Alert>{apiErrorMessage(del.error)}</Alert>}
        <div className={ui.actionsCenter}>
          <Button size="tiny" onClick={() => setRevoke(null)}>
            Cancel
          </Button>
          <Button
            size="tiny"
            variant="outline"
            loading={del.isPending}
            onClick={() => revoke !== null && del.mutate({ id: revoke.id })}
          >
            Revoke invite
          </Button>
        </div>
      </Dialog>
    </Section>
  );
}
