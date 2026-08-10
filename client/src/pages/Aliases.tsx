// Alias index ("/") — the legacy landing: commanding centered hero, one
// primary action (mint a random alias now), a "customize" escape hatch, and a
// plain list of aliases with a switch (or a copy button while unused). Stats
// and filters were deliberate cruft-cuts; each row shows its last activity
// and total message count instead.

import { useState } from "react";
import { css } from "styled-system/css";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { apiErrorMessage } from "src/api/errors";
import { CreateAliasModal } from "src/components/CreateAliasModal";
import {
  type Alias,
  getV2AliasesQueryKey,
  useGetV2Aliases,
  usePostAliasRandomNew,
  usePostAliasesAliasIdToggle,
} from "src/gen";
import { timeAgo } from "src/lib/time";
import {
  Alert,
  Button,
  CopyButton,
  EntityList,
  EntityRow,
  Hero,
  Section,
  Switch,
  ui,
} from "src/ui";

const PAGE_SIZE = 20;

const ACTION_LABEL: Record<string, string> = {
  forward: "forwarded",
  reply: "replied",
  block: "blocked",
  bounced: "bounced",
};

function activityLine(alias: Alias): string {
  const messages = alias.nb_forward + alias.nb_reply;
  const count = `${messages} message${messages === 1 ? "" : "s"}`;
  if (!alias.latest_activity) return "No emails yet";
  const { action, timestamp, contact } = alias.latest_activity;
  const verb = ACTION_LABEL[action] ?? action;
  const who = contact.email ? ` · ${contact.email}` : "";
  return `${timeAgo(timestamp)} — ${verb}${who} · ${count}`;
}

export function AliasesPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(0);
  const [customizing, setCustomizing] = useState(false);

  const aliases = useGetV2Aliases({ page_id: String(page) });
  const invalidateAliases = () =>
    void queryClient.invalidateQueries({ queryKey: getV2AliasesQueryKey() });

  const createRandom = usePostAliasRandomNew({
    mutation: {
      onSuccess: (alias) => {
        invalidateAliases();
        void navigate({ to: "/aliases/$aliasId", params: { aliasId: String(alias.id) } });
      },
    },
  });
  const toggle = usePostAliasesAliasIdToggle({ mutation: { onSuccess: invalidateAliases } });

  const rows = aliases.data?.aliases ?? [];
  const hasNextPage = rows.length === PAGE_SIZE;

  return (
    <Section>
      <Hero title="Protect your real email address.">
        <p className={ui.lead}>Share a unique, secure email alias instead.</p>
        <div
          className={css({
            display: "flex",
            alignItems: "center",
            flexFlow: "column",
            marginTop: "2rem",
          })}
        >
          <Button
            variant="submit"
            loading={createRandom.isPending}
            onClick={() => createRandom.mutate({})}
            className={css({ marginBottom: "2rem" })}
          >
            ➜&nbsp;&nbsp;Share an email alias
          </Button>
          <p className={ui.lead}>
            <button type="button" className={ui.link} onClick={() => setCustomizing(true)}>
              Customize an email alias
            </button>
          </p>
        </div>
        {createRandom.isError && <Alert>{apiErrorMessage(createRandom.error)}</Alert>}
      </Hero>

      {aliases.isError ? (
        <Alert>{apiErrorMessage(aliases.error)}</Alert>
      ) : (
        <EntityList>
          {rows.map((alias) => (
            <EntityRow
              key={alias.id}
              to="/aliases/$aliasId"
              params={{ aliasId: String(alias.id) }}
              title={alias.name || alias.email}
              detail={activityLine(alias)}
              // Phones: the copy/toggle conveniences hide — tap the row, the
              // detail page has them.
              hideMetaBelow="xs"
              meta={
                <>
                  <CopyButton text={alias.email} />
                  <Switch
                    checked={alias.enabled}
                    disabled={toggle.isPending && toggle.variables?.alias_id === alias.id}
                    onChange={() => toggle.mutate({ alias_id: alias.id })}
                    label={alias.enabled ? "Disable alias" : "Enable alias"}
                  />
                </>
              }
            />
          ))}
        </EntityList>
      )}

      {rows.length === 0 && !aliases.isPending && page > 0 && (
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

      <CreateAliasModal opened={customizing} onClose={() => setCustomizing(false)} />
    </Section>
  );
}
