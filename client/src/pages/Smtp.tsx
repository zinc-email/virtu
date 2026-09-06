// Mail-client setup + the per-device SMTP passwords that make it work.
//
// The page teaches the two sending modes submission.ts actually implements,
// in the order a user meets them:
//
//   1. Reply mode  — MAIL FROM = your mailbox. What a stock mail client does
//      when you hit Reply on a forwarded message. Zero extra setup beyond
//      pointing the outgoing server here; recipients must all be reverse
//      aliases of one alias.
//   2. Send mode   — MAIL FROM = the alias. Cold mail *from* an alias, which
//      needs a per-alias identity in the client. This is the feature people
//      actually come for.
//
// Host/ports/username are deployment config (GET /smtp/settings), never
// hardcoded — zinc, lmnop and localhost all differ.
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { css, cx } from "styled-system/css";
import {
  getSmtpCredentialsQueryKey,
  type SmtpCredentialCreated,
  useDeleteSmtpCredentialsCredentialId,
  useGetSmtpCredentials,
  useGetSmtpSettings,
  usePostSmtpCredentials,
} from "src/gen";
import { useHead } from "src/head";
import { apiErrorMessage } from "src/api/errors";
import { Dialog } from "src/overlays";
import { timeAgo } from "src/lib/time";
import {
  Alert,
  Button,
  CodeBlock,
  CopyButton,
  Field,
  FieldRow,
  KeyValue,
  KV,
  Section,
  ui,
} from "src/ui";

// A labeled line whose value is a copyable code strip — the same shape
// DomainDetail uses for DNS records, because it's the same job: values to
// paste into somebody else's settings screen.
function SettingRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      className={css({
        display: "flex",
        alignItems: "flex-start",
        gap: "0.9rem",
        marginTop: "0.75rem",
        "@media (max-width: 480px)": { flexDirection: "column", gap: "0.25rem" },
      })}
    >
      <span
        className={css({
          flex: "0 0 7rem",
          textAlign: "right",
          color: "primary",
          fontFamily: "mono",
          fontSize: "0.85rem",
          paddingTop: "0.65rem",
          // Stacked: the row becomes a column, where flex-basis is the main
          // size — leaving 7rem of empty label box above every value.
          "@media (max-width: 480px)": { flex: "0 0 auto", textAlign: "left", paddingTop: 0 },
        })}
      >
        {label}
      </span>
      <div className={css({ flex: 1, minWidth: 0, width: "100%" })}>{children}</div>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <div className={css({ display: "flex", gap: "1rem", marginTop: "1.75rem" })}>
      <span
        className={css({
          flex: "0 0 1.8rem",
          height: "1.8rem",
          borderRadius: "50%",
          border: "0.111rem solid token(colors.border)",
          color: "primary",
          fontFamily: "mono",
          fontSize: "0.9rem",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        })}
      >
        {n}
      </span>
      <div className={css({ flex: 1, minWidth: 0 })}>
        <h3
          className={css({
            fontFamily: "sans",
            fontWeight: "bold",
            color: "heading",
            marginBottom: "0.4rem",
            lineHeight: "1.8rem",
          })}
        >
          {title}
        </h3>
        <div className={ui.finePrint}>{children}</div>
      </div>
    </div>
  );
}

// The connection settings, straight from the server — the page can't guess
// these and must never hardcode them.
function ServerSettingsSection() {
  const settings = useGetSmtpSettings();

  if (settings.isPending) {
    return <p className={css({ padding: "2rem", color: "textDim" })}>Loading…</p>;
  }
  if (settings.isError) {
    return <Alert>{apiErrorMessage(settings.error)}</Alert>;
  }
  const s = settings.data;

  return (
    <>
      <SettingRow label="Server">
        <CodeBlock compact>{s.hostname}</CodeBlock>
      </SettingRow>
      <SettingRow label="Port">
        <CodeBlock compact>{String(s.port_starttls)}</CodeBlock>
        <div className={cx(ui.finePrint, css({ marginTop: "0.35rem" }))}>
          STARTTLS. Or <span className={ui.mono}>{s.port_tls}</span> if your app wants SSL/TLS
          instead — either is fine, both are encrypted.
        </div>
      </SettingRow>
      <SettingRow label="Username">
        <CodeBlock compact>{s.username}</CodeBlock>
      </SettingRow>
      <SettingRow label="Password">
        <div className={cx(ui.finePrint, css({ paddingTop: "0.65rem" }))}>
          A device password you create below — not your login code.
        </div>
      </SettingRow>
    </>
  );
}

// Per-device passwords: list, create (revealed once in a dialog), revoke.
// The account has no password, so these are the only thing SMTP AUTH accepts.
function CredentialsSection() {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [created, setCreated] = useState<SmtpCredentialCreated | null>(null);

  const credentials = useGetSmtpCredentials();
  // Cancel before invalidating, and hand the promise back to react-query so
  // the mutation stays pending until the list is actually re-read. Without
  // the cancel, a GET still in flight from the previous mutation resolves
  // *after* the DELETE and repopulates the row that was just revoked.
  const invalidate = async () => {
    const queryKey = getSmtpCredentialsQueryKey();
    await queryClient.cancelQueries({ queryKey });
    await queryClient.invalidateQueries({ queryKey });
  };
  const create = usePostSmtpCredentials({
    mutation: {
      onSuccess: (credential) => {
        setCreated(credential);
        setName("");
        invalidate();
      },
    },
  });
  const revoke = useDeleteSmtpCredentialsCredentialId({ mutation: { onSuccess: invalidate } });

  const rows = credentials.data?.credentials ?? [];

  return (
    <div className={css({ marginTop: "4rem" })}>
      <h2 className={cx(ui.h2, css({ marginBottom: "1rem" }))}>Device passwords.</h2>
      <p className={cx(ui.finePrint, css({ marginBottom: "2rem" }))}>
        One password per device — phone, laptop, mail client. Each is shown once and can be revoked
        on its own; the others keep working. "Last used" is stamped every time a device
        authenticates, so an entry that has never been used, or went quiet, is safe to revoke.
      </p>

      {create.isError && <Alert>{apiErrorMessage(create.error)}</Alert>}
      {revoke.isError && <Alert>{apiErrorMessage(revoke.error)}</Alert>}

      {credentials.isPending ? (
        <p className={css({ textAlign: "center", padding: "2rem", color: "textDim" })}>Loading…</p>
      ) : credentials.isError ? (
        <Alert>{apiErrorMessage(credentials.error)}</Alert>
      ) : (
        rows.length > 0 && (
          <KeyValue>
            {rows.map((c) => (
              <KV key={c.id} k={c.name}>
                <span className={css({ color: "textDim" })}>
                  {c.last_used_timestamp === null
                    ? "Never used"
                    : `Last used ${timeAgo(c.last_used_timestamp)}`}
                </span>
                <Button
                  size="tiny"
                  variant="cta"
                  disabled={revoke.isPending}
                  onClick={() => revoke.mutate({ credential_id: c.id })}
                  className={css({ marginLeft: "1rem" })}
                >
                  Revoke
                </Button>
              </KV>
            ))}
          </KeyValue>
        )
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = name.trim();
          if (!trimmed) return;
          create.mutate({ data: { name: trimmed } });
        }}
      >
        <FieldRow
          field={
            <Field
              label="New device name"
              name="credential-name"
              placeholder="My phone"
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
            />
          }
          button={
            <Button
              type="submit"
              variant="submit"
              loading={create.isPending}
              className={css({ padding: "1rem 1.5rem 0.75rem 1.5rem", whiteSpace: "nowrap" })}
            >
              + Create
            </Button>
          }
        />
      </form>

      {created !== null && (
        <Dialog opened onClose={() => setCreated(null)} title="Save this password now.">
          <p className={css({ marginBottom: "1.5rem", color: "textDim", fontSize: "0.9rem" })}>
            This is the only time it will be shown. Enter it as the SMTP password for{" "}
            <strong>{created.name}</strong>.
          </p>
          <div
            className={css({
              display: "flex",
              alignItems: "center",
              gap: "1rem",
              padding: "1rem",
              backgroundColor: "surface",
              borderRadius: "0.25rem",
              fontFamily: "mono",
              wordBreak: "break-all",
            })}
          >
            <span data-testid="smtp-password">{created.password}</span>
            <CopyButton text={created.password} />
          </div>
          <div
            className={css({ marginTop: "1.5rem", display: "flex", justifyContent: "flex-end" })}
          >
            <Button variant="submit" onClick={() => setCreated(null)}>
              I saved it
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

export function SmtpPage() {
  useHead({ title: "Mail client" });
  const settings = useGetSmtpSettings();
  const mailDomain = settings.data?.mail_domain ?? "your alias domain";

  return (
    <Section narrow>
      <h1 className={cx(ui.h1, css({ marginBottom: "1rem" }))}>Send from your aliases.</h1>
      <p className={ui.lead}>
        Point your mail app's outgoing server here and replies to forwarded mail go back out as the
        alias — your real address never appears. Set up an identity per alias and you can start new
        conversations from one too.
      </p>

      <div className={css({ marginTop: "3rem" })}>
        <h2 className={cx(ui.h2, css({ marginBottom: "1rem" }))}>Connection settings.</h2>
        <p className={cx(ui.finePrint, css({ marginBottom: "1rem" }))}>
          Outgoing (SMTP) only — leave your incoming server alone, since alias mail arrives in your
          normal inbox.
        </p>
        <ServerSettingsSection />
      </div>

      <div className={css({ marginTop: "4rem" })}>
        <h2 className={cx(ui.h2, css({ marginBottom: "0.5rem" }))}>Replying.</h2>
        <p className={ui.finePrint}>
          This works as soon as the settings above are in place — no per-alias configuration.
        </p>
        <Step n={1} title="Add the outgoing server">
          In your mail app's account settings, set the outgoing (SMTP) server to the values above.
          Most apps ask you to confirm the password once.
        </Step>
        <Step n={2} title="Hit reply like normal">
          Forwarded mail arrives from a reverse-alias address that stands in for the real sender.
          Replying to it sends through us, and the recipient sees the alias.
        </Step>
        <Step n={3} title="One alias per message">
          Every recipient on a reply has to belong to the same alias — mixing two aliases is refused
          rather than guessed at. Your own mailbox address in To or Cc is refused too: it would put
          your real address in front of the recipient.
        </Step>
      </div>

      <div className={css({ marginTop: "4rem" })}>
        <h2 className={cx(ui.h2, css({ marginBottom: "0.5rem" }))}>Starting a new conversation.</h2>
        <p className={ui.finePrint}>
          To email someone <em>as</em> an alias — before they've ever written to you — your mail app
          needs to know that alias as a sending identity.
        </p>
        <Step n={1} title="Add the alias as an identity">
          Apple Mail calls it an alias, Thunderbird an identity, Gmail "Send mail as". Give it the
          alias address and the same outgoing server.
        </Step>
        <Step n={2} title="Pick it in the From field">
          Compose as usual and choose the alias in From. We rewrite the message so it comes from{" "}
          <span className={ui.mono}>{mailDomain}</span> and file the recipient as a contact, so
          their reply threads back to you.
        </Step>
        <Step n={3} title="Keep the alias enabled">
          A disabled alias refuses to send as well as to receive — that's the point of the switch.
        </Step>
      </div>

      <CredentialsSection />

      <p className={cx(ui.finePrint, css({ marginTop: "3rem" }))}>
        Sending fails with an error that names the reason — an alias that isn't yours, a disabled
        alias, a recipient that would leak your mailbox. The message is refused, never silently
        delivered wrong.
      </p>
    </Section>
  );
}
