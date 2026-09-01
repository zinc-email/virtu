// Notifications ("/notifications") — the bell's landing page: what the mail
// pipeline wants the user to know (an alias auto-disabled after bounces, a
// mailbox failing verification, an invalidated login code). Unread first,
// newest first, 20 per page (the server's SL-compatible ordering); rows are
// facts to acknowledge, so the only control is Mark read.

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { css } from "styled-system/css";
import { apiErrorMessage } from "src/api/errors";
import {
  getNotificationsQueryKey,
  useGetNotifications,
  usePostNotificationsNotificationIdRead,
} from "src/gen";
import { Alert, Button, EntityList, EntityRow, Section, Tag, ui } from "src/ui";

export function NotificationsPage() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(0);

  const notifications = useGetNotifications({ page: String(page) });
  const markRead = usePostNotificationsNotificationIdRead({
    mutation: {
      onSuccess: () => {
        // Every page's query (and the bell badge, which reads page 0).
        void queryClient.invalidateQueries({ queryKey: [{ url: "/notifications" }] });
      },
    },
  });

  const rows = notifications.data?.notifications ?? [];
  const more = notifications.data?.more ?? false;

  return (
    <Section narrow>
      <header className={css({ marginBottom: "2.11rem" })}>
        <h1 className={ui.h1}>Notifications.</h1>
      </header>

      {notifications.isPending ? (
        <p className={css({ textAlign: "center", padding: "2rem", color: "textDim" })}>Loading…</p>
      ) : notifications.isError ? (
        <Alert>{apiErrorMessage(notifications.error)}</Alert>
      ) : rows.length === 0 ? (
        <p className={ui.lead}>
          {page === 0
            ? "Nothing yet. When something needs your attention"
            : "No older notifications. When something needs your attention"}{" "}
          — an alias disabled after bounces, a mailbox that stopped verifying — it shows up here.
        </p>
      ) : (
        <EntityList>
          {rows.map((n) => (
            <EntityRow
              key={n.id}
              title={
                <span className={n.read ? css({ color: "textDim" }) : undefined}>
                  {n.title ?? n.message}
                </span>
              }
              detail={
                <>
                  {n.title !== null && <span>{n.message}</span>}
                  {/* The action rides the tag line, not a meta column — a
                      meta button starves the text of width on phones. */}
                  <span
                    className={css({
                      display: "flex",
                      alignItems: "center",
                      gap: "0.8rem",
                      marginTop: "0.3rem",
                    })}
                  >
                    {!n.read && <Tag tone="accent">New</Tag>}
                    <span className={css({ color: "textDim" })}>{n.created_at}</span>
                    {!n.read && (
                      <Button
                        variant="link"
                        loading={markRead.isPending && markRead.variables?.notification_id === n.id}
                        onClick={() => markRead.mutate({ notification_id: n.id })}
                      >
                        Mark read
                      </Button>
                    )}
                  </span>
                </>
              }
            />
          ))}
        </EntityList>
      )}

      {(page > 0 || more) && (
        <div
          className={css({
            display: "flex",
            justifyContent: "space-between",
            marginTop: "1.5rem",
          })}
        >
          {page > 0 ? (
            <Button variant="outline" onClick={() => setPage(page - 1)}>
              Newer
            </Button>
          ) : (
            <span />
          )}
          {more && (
            <Button variant="outline" onClick={() => setPage(page + 1)}>
              Older
            </Button>
          )}
        </div>
      )}
    </Section>
  );
}
