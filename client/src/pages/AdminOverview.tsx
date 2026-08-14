// Admin landing ("/admin") — the operator numbers: queue state, 24h mail
// activity, accounts. KV rows in kit style (no chart primitives in P1);
// pending/failed link into the filtered queue view.

import { Link } from "@tanstack/react-router";
import { css } from "styled-system/css";
import { useGetAdminOverview } from "src/gen";
import { KeyValue, KV, Section, ui } from "src/ui";
import { AdminErrorAlert } from "src/pages/adminCommon";

const h2 = css({ marginTop: "2.5rem", marginBottom: "0.5rem" });

export function AdminOverviewPage() {
  const overview = useGetAdminOverview();

  if (overview.isPending) {
    return (
      <Section narrow>
        <p className={css({ textAlign: "center", padding: "2rem", color: "textDim" })}>Loading…</p>
      </Section>
    );
  }
  if (overview.isError) {
    return (
      <Section narrow>
        <AdminErrorAlert error={overview.error} />
      </Section>
    );
  }

  const { queue, activity_24h, users } = overview.data;
  const oldest =
    queue.oldest_pending_age_seconds === null
      ? "—"
      : `${Math.round(queue.oldest_pending_age_seconds / 60)}m`;

  return (
    <Section narrow>
      <header className={css({ marginBottom: "2.11rem" })}>
        <h1 className={ui.h1}>Admin.</h1>
      </header>

      <h2 className={h2}>Queue</h2>
      <KeyValue>
        <KV k="Pending">
          <Link to="/admin/queue" search={{ status: "pending" }} className={ui.link}>
            {queue.pending}
          </Link>
        </KV>
        <KV k="Sending">{queue.sending}</KV>
        <KV k="Failed">
          <Link to="/admin/queue" search={{ status: "failed" }} className={ui.link}>
            {queue.failed}
          </Link>
        </KV>
        <KV k="Sent (24h)">{queue.sent_24h}</KV>
        <KV k="Oldest due pending">{oldest}</KV>
      </KeyValue>

      <h2 className={h2}>Last 24 hours</h2>
      <KeyValue>
        <KV k="Forwards">{activity_24h.forwards}</KV>
        <KV k="Replies">{activity_24h.replies}</KV>
        <KV k="Bounces">{activity_24h.bounces}</KV>
        <KV k="Blocked">{activity_24h.blocked}</KV>
      </KeyValue>

      <h2 className={h2}>Users</h2>
      <KeyValue>
        <KV k="Total">{users.total}</KV>
        <KV k="Disabled">{users.disabled}</KV>
      </KeyValue>
    </Section>
  );
}
