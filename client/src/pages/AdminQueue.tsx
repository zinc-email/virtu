// Admin queue index ("/admin/queue") — the outbound_messages table as an
// EntityList: status filter (URL search param), paged with the admin API's
// total. Index rows are minimal and carry no buttons (house convention —
// the detail page owns Drop/Requeue).

import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { css } from "styled-system/css";
import { useGetAdminQueue } from "src/gen";
import { Button, EntityList, EntityRow, SelectField, Section, Tag, Tags, ui } from "src/ui";
import { useHead } from "src/head";
import { AdminErrorAlert, STATUS_TONE, timeAgo } from "src/pages/adminCommon";

const PAGE_SIZE = 20;

export function AdminQueuePage() {
  useHead({ title: "Queue" });
  const navigate = useNavigate();
  const { status } = useSearch({ from: "/admin/queue" });
  const [page, setPage] = useState(0);

  // The select's onChange resets the page, but the filter can also change
  // via history back/forward with this component still mounted — a stale
  // page against a shorter filtered list would render a phantom empty page.
  useEffect(() => {
    setPage(0);
  }, [status]);

  const queue = useGetAdminQueue({ status, page_id: page, limit: PAGE_SIZE });

  const total = queue.data?.total ?? 0;
  const rows = queue.data?.messages ?? [];
  const hasNextPage = (page + 1) * PAGE_SIZE < total;

  return (
    <Section>
      <header className={css({ textAlign: "center", marginBottom: "2rem" })}>
        <h1 className={ui.h1}>Delivery queue.</h1>
        {queue.isSuccess && (
          <p className={css({ color: "textDim", marginTop: "0.5rem" })}>
            {total} {status ?? "total"} message{total === 1 ? "" : "s"}
          </p>
        )}
      </header>

      <div className={css({ maxWidth: "20rem", margin: "0 auto 2rem auto" })}>
        <SelectField
          label="Status"
          name="status"
          value={status ?? ""}
          onChange={(e) => {
            const value = e.currentTarget.value;
            setPage(0);
            void navigate({
              to: "/admin/queue",
              search:
                value === "" ||
                (value !== "pending" &&
                  value !== "sending" &&
                  value !== "sent" &&
                  value !== "failed")
                  ? {}
                  : { status: value },
            });
          }}
          options={[
            { value: "", label: "All" },
            { value: "pending", label: "Pending" },
            { value: "sending", label: "Sending" },
            { value: "sent", label: "Sent" },
            { value: "failed", label: "Failed" },
          ]}
        />
      </div>

      {queue.isPending ? (
        <p className={css({ textAlign: "center", padding: "2rem", color: "textDim" })}>Loading…</p>
      ) : queue.isError ? (
        <AdminErrorAlert error={queue.error} />
      ) : rows.length > 0 ? (
        <EntityList>
          {rows.map((m) => (
            <EntityRow
              key={m.id}
              to="/admin/queue/$messageId"
              params={{ messageId: String(m.id) }}
              title={m.envelope_to}
              detail={
                <>
                  <Tags>
                    <Tag tone={STATUS_TONE[m.status]}>{m.status}</Tag>
                    {m.verp_type !== null && <Tag tone="neutral">{m.verp_type}</Tag>}
                  </Tags>
                  {m.last_error !== null && (
                    <span className={css({ display: "block", marginTop: "0.4rem" })}>
                      {m.last_error.length > 120 ? `${m.last_error.slice(0, 120)}…` : m.last_error}
                    </span>
                  )}
                </>
              }
              meta={
                <span className={css({ color: "textDim", fontSize: "0.85rem" })}>
                  #{m.id} · tries {m.tries} · {timeAgo(m.created_at)}
                </span>
              }
              hideMetaBelow="xs"
            />
          ))}
        </EntityList>
      ) : (
        <p className={css({ textAlign: "center", padding: "2rem", color: "textDim" })}>
          Nothing here.
        </p>
      )}

      {(page > 0 || hasNextPage) && (
        <div className={css({ marginTop: "2rem" })}>
          <div className={ui.actionsCenter}>
            <Button
              size="tiny"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              Previous
            </Button>
            <span className={css({ color: "textDim", fontSize: "0.9rem" })}>Page {page + 1}</span>
            <Button size="tiny" disabled={!hasNextPage} onClick={() => setPage((p) => p + 1)}>
              Next
            </Button>
          </div>
        </div>
      )}
    </Section>
  );
}
