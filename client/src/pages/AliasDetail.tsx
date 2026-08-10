// Alias detail ("/aliases/$aliasId") — the legacy "virtual" page. Two header
// states: a fresh alias gets the share checklist + copy button; a used alias
// gets name/email/copy + the big enable switch, then the activity list.
// Contacts and delete live here (moved off the index rows). The shell shows
// the big back arrow instead of the logo on this page.

import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { css, cx } from "styled-system/css";
import { apiErrorMessage } from "src/api/errors";
import { ContactsDrawer } from "src/components/ContactsDrawer";
import { Dialog } from "src/overlays";
import {
  getAliasesAliasIdQueryKey,
  getV2AliasesQueryKey,
  useDeleteAliasesAliasId,
  useGetAliasesAliasId,
  useGetAliasesAliasIdActivities,
  usePostAliasesAliasIdToggle,
} from "src/gen";
import { timeAgo } from "src/lib/time";
import {
  Alert,
  Button,
  Checklist,
  CopyButton,
  EntityList,
  EntityRow,
  Section,
  Switch,
  ui,
} from "src/ui";

const ACTION_LABEL: Record<string, string> = {
  forward: "Forwarded",
  reply: "Replied",
  block: "Blocked",
  bounced: "Bounced",
};

// Break long addresses before the @ like the legacy page did with <wbr>.
function EmailBreak({ email }: { email: string }) {
  const at = email.indexOf("@");
  if (at < 0) return <>{email}</>;
  return (
    <>
      {email.slice(0, at)}
      <wbr />
      {email.slice(at)}
    </>
  );
}

export function AliasDetailPage() {
  const params = useParams({ strict: false });
  const aliasId = Number(params.aliasId);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(0);
  const [contactsOpen, setContactsOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const alias = useGetAliasesAliasId(aliasId);
  const activities = useGetAliasesAliasIdActivities(aliasId, { page_id: String(page) });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: getAliasesAliasIdQueryKey(aliasId) });
    void queryClient.invalidateQueries({ queryKey: getV2AliasesQueryKey() });
  };
  const toggle = usePostAliasesAliasIdToggle({ mutation: { onSuccess: invalidate } });
  const remove = useDeleteAliasesAliasId({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getV2AliasesQueryKey() });
        void navigate({ to: "/" });
      },
    },
  });

  if (alias.isPending) {
    return (
      <Section>
        <p className={css({ textAlign: "center", padding: "3rem", color: "textDim" })}>Loading…</p>
      </Section>
    );
  }
  if (alias.isError) {
    return (
      <Section narrow>
        <Alert>{apiErrorMessage(alias.error)}</Alert>
      </Section>
    );
  }

  const a = alias.data;
  const isNew = a.latest_activity === null;
  const rows = activities.data?.activities ?? [];
  const hasNextPage = rows.length === 20;

  return (
    <Section>
      <header className={css({ textAlign: "center", padding: "0 2rem" })}>
        {isNew ? (
          <>
            <h1
              className={cx(
                ui.h1,
                // Long mono addresses scale with the viewport so they break
                // at the <wbr> before @, not mid-word.
                css({ marginBottom: "2rem", fontSize: "clamp(1.25rem, 5.8vw, 2rem)" }),
              )}
            >
              <span className={ui.mono}>
                <EmailBreak email={a.email} />
              </span>
            </h1>
            <Checklist
              items={[
                "Share this email alias with exactly one person or business.",
                "Messages will forward securely to your inbox.",
              ]}
            />
            <div className={ui.actionsCenter}>
              <CopyButton text={a.email} />
              <Switch
                checked={a.enabled}
                disabled={toggle.isPending}
                onChange={() => toggle.mutate({ alias_id: a.id })}
                label={a.enabled ? "Disable alias" : "Enable alias"}
              />
            </div>
          </>
        ) : (
          <>
            <h1
              className={cx(
                ui.h1,
                css({ marginBottom: "1rem", fontSize: "clamp(1.25rem, 5.8vw, 2rem)" }),
              )}
            >
              {a.name || <EmailBreak email={a.email} />}
            </h1>
            <div
              className={css({
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexWrap: "wrap",
                gap: "0.6rem",
                opacity: 0.8,
                marginBottom: "2.5rem",
              })}
            >
              <span className={css({ fontSize: "0.9rem", overflowWrap: "anywhere" })}>
                {a.email}
              </span>
              <CopyButton text={a.email} />
            </div>
            <div
              className={css({
                display: "flex",
                justifyContent: "center",
                marginBottom: "1.5rem",
              })}
            >
              <Switch
                checked={a.enabled}
                disabled={toggle.isPending}
                onChange={() => toggle.mutate({ alias_id: a.id })}
                label={a.enabled ? "Disable alias" : "Enable alias"}
                size="1.15rem"
              />
            </div>
          </>
        )}

        {a.note && <p className={ui.finePrint}>{a.note}</p>}
        {a.mailboxes.length > 1 && (
          <p className={ui.finePrint}>Delivers to {a.mailboxes.map((m) => m.email).join(", ")}</p>
        )}
        {toggle.isError && <Alert>{apiErrorMessage(toggle.error)}</Alert>}
      </header>

      {!isNew && (
        <div className={css({ marginTop: "3rem" })}>
          {activities.isError ? (
            <Alert>{apiErrorMessage(activities.error)}</Alert>
          ) : (
            <EntityList>
              {rows.map((act, i) => (
                <EntityRow
                  key={`${act.timestamp}-${i}`}
                  title={act.action === "reply" ? act.to : act.from}
                  detail={`${timeAgo(act.timestamp)} · ${ACTION_LABEL[act.action] ?? act.action}`}
                />
              ))}
            </EntityList>
          )}
          {(page > 0 || hasNextPage) && (
            <div className={cx(ui.actionsCenter, css({ marginTop: "2rem" }))}>
              <Button
                size="tiny"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                Previous
              </Button>
              <Button size="tiny" disabled={!hasNextPage} onClick={() => setPage((p) => p + 1)}>
                Next
              </Button>
            </div>
          )}
        </div>
      )}

      <div className={cx(ui.actionsCenter, css({ marginTop: "4rem" }))}>
        <Button variant="link" onClick={() => setContactsOpen(true)}>
          » Contacts
        </Button>
        <Button variant="link" onClick={() => setConfirmingDelete(true)}>
          » Delete this alias
        </Button>
      </div>

      <ContactsDrawer alias={contactsOpen ? a : null} onClose={() => setContactsOpen(false)} />

      <Dialog
        opened={confirmingDelete}
        onClose={() => {
          remove.reset();
          setConfirmingDelete(false);
        }}
        title="Delete alias"
      >
        <div className={css({ display: "flex", flexDirection: "column", gap: "1rem" })}>
          <p>
            Delete <span className={ui.mono}>{a.email}</span>? This can't be undone.
          </p>
          {remove.isError && <Alert>{apiErrorMessage(remove.error)}</Alert>}
          <div className={css({ display: "flex", justifyContent: "flex-end", gap: "0.75rem" })}>
            <Button size="tiny" onClick={() => setConfirmingDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="cta"
              size="tiny"
              loading={remove.isPending}
              onClick={() => remove.mutate({ alias_id: a.id })}
            >
              Delete
            </Button>
          </div>
        </div>
      </Dialog>
    </Section>
  );
}
