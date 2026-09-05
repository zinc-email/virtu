// Admin destinations ("/admin/destinations") — recipient domains the
// outbound throttle has heard a deferral signal from (a 421, or a 4.7.x
// policy deferral at a non-recipient step), paused ones first, with the
// reply that caused the latest pause and a Resume lever. The rate view of
// the same thing lives in Grafana (grafana/deliverability.json).

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { css } from "styled-system/css";
import { apiErrorMessage } from "src/api/errors";
import type { AdminDestination } from "src/gen";
import {
  getAdminDestinationsQueryKey,
  getAdminOverviewQueryKey,
  useDeleteAdminDestinationsDomain,
  useGetAdminDestinations,
} from "src/gen";
import { Dialog } from "src/overlays";
import { Alert, Button, EntityList, EntityRow, Section, Tag, Tags, ui } from "src/ui";
import { useHead } from "src/head";
import { AdminErrorAlert, timeAgo } from "src/pages/adminCommon";

function pausedFor(until: string): string {
  const ms = new Date(until).getTime() - Date.now();
  if (ms <= 0) return "lifting";
  const min = Math.round(ms / 60_000);
  return min < 1 ? "under a minute" : `${min}m`;
}

export function AdminDestinationsPage() {
  useHead({ title: "Destinations" });
  const queryClient = useQueryClient();
  const [resume, setResume] = useState<AdminDestination | null>(null);
  const list = useGetAdminDestinations();
  const clear = useDeleteAdminDestinationsDomain({
    mutation: {
      onSuccess: () => {
        setResume(null);
        void queryClient.invalidateQueries({ queryKey: getAdminDestinationsQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getAdminOverviewQueryKey() });
      },
    },
  });

  const rows = list.data?.destinations ?? [];

  return (
    <Section narrow>
      <header className={css({ marginBottom: "2.11rem" })}>
        <h1 className={ui.h1}>Destinations.</h1>
        {list.isSuccess && (
          <p className={css({ color: "textDim", marginTop: "0.5rem" })}>
            {list.data.paused} paused of {rows.length} that have ever pushed back.
          </p>
        )}
      </header>

      {list.isPending ? (
        <p className={css({ textAlign: "center", padding: "2rem", color: "textDim" })}>Loading…</p>
      ) : list.isError ? (
        <AdminErrorAlert error={list.error} />
      ) : rows.length > 0 ? (
        <EntityList>
          {rows.map((d) => {
            const paused = d.paused_until !== null;
            return (
              <EntityRow
                key={d.domain}
                title={d.domain}
                detail={
                  <>
                    <Tags>
                      <Tag tone={paused ? "accent" : "neutral"}>
                        {paused ? `paused ${pausedFor(d.paused_until!)}` : "not paused"}
                      </Tag>
                      <Tag tone="neutral">{d.provider}</Tag>
                    </Tags>
                    <span className={css({ display: "block", marginTop: "0.4rem" })}>
                      {d.strikes} strike{d.strikes === 1 ? "" : "s"} · {d.pauses} pause
                      {d.pauses === 1 ? "" : "s"} lifetime
                    </span>
                    {d.last_code !== null && (
                      <span className={css({ display: "block", marginTop: "0.4rem" })}>
                        last: <span className={ui.mono}>{d.last_code}</span>
                        {d.last_enhanced !== null && (
                          <>
                            {" "}
                            <span className={ui.mono}>{d.last_enhanced}</span>
                          </>
                        )}
                        {d.last_step !== null && ` at ${d.last_step.replace("_", " ")}`}
                        {d.last_reply !== null && d.last_reply !== "" && ` — ${d.last_reply}`}
                      </span>
                    )}
                    {paused && (
                      <span className={css({ display: "block", marginTop: "0.8rem" })}>
                        <Button size="tiny" variant="outline" onClick={() => setResume(d)}>
                          Resume now
                        </Button>
                      </span>
                    )}
                  </>
                }
                meta={
                  <span className={css({ color: "textDim", fontSize: "0.85rem" })}>
                    {d.last_deferred_at !== null && timeAgo(d.last_deferred_at)}
                  </span>
                }
                hideMetaBelow="xs"
              />
            );
          })}
        </EntityList>
      ) : (
        <p className={css({ textAlign: "center", padding: "2rem", color: "textDim" })}>
          No destination has asked us to slow down.
        </p>
      )}

      <Dialog opened={resume !== null} onClose={() => setResume(null)} title="Resume deliveries?">
        <p>
          Queued mail for <span className={ui.mono}>{resume?.domain}</span> goes out on its next due
          attempt instead of waiting out the pause. If the destination is still refusing us, the
          next deferral pauses it again — for longer.
        </p>
        {clear.isError && <Alert>{apiErrorMessage(clear.error)}</Alert>}
        <div className={ui.actionsCenter}>
          <Button size="tiny" onClick={() => setResume(null)}>
            Cancel
          </Button>
          <Button
            size="tiny"
            variant="outline"
            loading={clear.isPending}
            onClick={() => resume !== null && clear.mutate({ domain: resume.domain })}
          >
            Resume now
          </Button>
        </div>
      </Dialog>
    </Section>
  );
}
