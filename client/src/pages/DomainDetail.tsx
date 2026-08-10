// Domain detail ("/domains/$domainId") — the legacy "Configure your domain."
// page: one section per DNS record (ownership TXT, MX, SPF, DKIM, DMARC) with
// the exact values to publish, a verify button running the real checks, the
// catch-all switch, and delete. The shell shows the back arrow here.

import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { css, cx } from "styled-system/css";
import { apiErrorMessage } from "src/api/errors";
import {
  type CustomDomain,
  type DnsRecord,
  getCustomDomainsQueryKey,
  useDeleteCustomDomainsCustomDomainId,
  useGetCustomDomains,
  useGetCustomDomainsCustomDomainIdDns,
  usePatchCustomDomainsCustomDomainId,
  usePostCustomDomainsCustomDomainIdVerify,
  type VerifyCustomDomainResponse,
} from "src/gen";
import { Dialog } from "src/overlays";
import { Alert, Button, CopyButton, KV, KeyValue, Section, Switch, ui } from "src/ui";

// One published-record section: explainer, success state or the rows to
// enter at the DNS provider, and what the last verify found when it failed.
function RecordSection({
  title,
  blurb,
  verified,
  successText,
  records,
  check,
}: {
  title: string;
  blurb: string;
  verified: boolean;
  successText: string;
  records: DnsRecord[];
  check?: { ok: boolean; errors: string[] };
}) {
  return (
    <section className={css({ marginTop: "3rem" })}>
      <h2 className={ui.h2}>{title}</h2>
      <p className={cx(ui.lead, css({ marginTop: "0.8rem" }))}>{blurb}</p>

      {check && !check.ok && check.errors.length > 0 && (
        <Alert>
          {check.errors.map((e) => (
            <div key={e}>{e}</div>
          ))}
        </Alert>
      )}

      {verified ? (
        <p className={css({ color: "primary", marginTop: "1rem" })}>✓ {successText}</p>
      ) : (
        <KeyValue>
          {records.map((r) => (
            <div
              key={`${r.type}-${r.hostname}-${r.value}`}
              className={css({ display: "contents" })}
            >
              <KV k="Type">{r.type}</KV>
              <KV k="Name">
                <span className={css({ overflowWrap: "anywhere" })}>{r.hostname}</span>
              </KV>
              {r.priority !== undefined && <KV k="Priority">{r.priority}</KV>}
              <KV k={r.type === "MX" ? "Target" : "Value"}>
                <div
                  className={css({
                    display: "flex",
                    gap: "0.6rem",
                    alignItems: "flex-start",
                    justifyContent: "space-between",
                  })}
                >
                  <span className={css({ overflowWrap: "anywhere", minWidth: 0 })}>{r.value}</span>
                  <CopyButton text={r.value} />
                </div>
              </KV>
            </div>
          ))}
        </KeyValue>
      )}
    </section>
  );
}

export function DomainDetailPage() {
  const params = useParams({ strict: false });
  const domainId = Number(params.domainId);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [lastVerify, setLastVerify] = useState<VerifyCustomDomainResponse | null>(null);

  // There is no GET-one endpoint (SimpleLogin parity); the list is small.
  const domains = useGetCustomDomains();
  const dns = useGetCustomDomainsCustomDomainIdDns(domainId);

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: getCustomDomainsQueryKey() });

  const verify = usePostCustomDomainsCustomDomainIdVerify({
    mutation: {
      onSuccess: (result) => {
        setLastVerify(result);
        invalidate();
      },
    },
  });
  const patch = usePatchCustomDomainsCustomDomainId({ mutation: { onSuccess: invalidate } });
  const remove = useDeleteCustomDomainsCustomDomainId({
    mutation: {
      onSuccess: () => {
        invalidate();
        void navigate({ to: "/domains" });
      },
    },
  });

  if (domains.isPending || dns.isPending) {
    return (
      <Section>
        <p className={css({ textAlign: "center", padding: "3rem", color: "textDim" })}>Loading…</p>
      </Section>
    );
  }
  if (domains.isError || dns.isError) {
    return (
      <Section narrow>
        <Alert>{apiErrorMessage(domains.isError ? domains.error : dns.error)}</Alert>
      </Section>
    );
  }

  const domain: CustomDomain | undefined = domains.data.custom_domains.find(
    (d) => d.id === domainId,
  );
  if (!domain) {
    return (
      <Section narrow>
        <Alert>Domain not found.</Alert>
      </Section>
    );
  }

  const records = dns.data.records;
  const allGreen =
    lastVerify !== null &&
    lastVerify.ownership.ok &&
    lastVerify.mx.ok &&
    lastVerify.spf.ok &&
    lastVerify.dkim.ok &&
    lastVerify.dmarc.ok;

  return (
    <Section narrow>
      <header className={css({ marginBottom: "2.11rem" })}>
        <h1 className={ui.h1}>{domain.is_verified ? "Verified." : "Configure your domain."}</h1>
      </header>

      {domain.is_verified ? (
        <p className={ui.lead}>You passed the verification checks and may now use your domain.</p>
      ) : (
        <>
          <p className={ui.lead}>
            Domain Name Service (DNS) publishes important information about your domain, such as
            mail routing and authentication information.
          </p>
          <p className={ui.lead}>
            To securely send and receive email to/from your domain, go to your DNS provider and
            configure the following DNS records.
          </p>
        </>
      )}

      {lastVerify !== null &&
        (allGreen ? (
          <Alert kind="success">All good. Looks like you configured everything correctly!</Alert>
        ) : (
          <Alert>
            Sometimes DNS changes take a few minutes to take effect. Double-check your DNS
            configuration below and try again in a bit.
          </Alert>
        ))}
      {verify.isError && <Alert>{apiErrorMessage(verify.error)}</Alert>}

      <KeyValue>
        <KV k="Domain">{domain.domain_name}</KV>
        <KV k="Status">{domain.is_verified ? "Verified" : "Not verified"}</KV>
        <div className={kvSwitchRow}>
          <dt className={kvSwitchKey}>Catch-all</dt>
          <dd className={kvSwitchValue}>
            <Switch
              checked={domain.catch_all}
              disabled={patch.isPending}
              onChange={(v) =>
                patch.mutate({ custom_domain_id: domain.id, data: { catch_all: v } })
              }
              label="Catch-all"
            />
            <span className={ui.finePrint}>
              Mail to any address on this domain creates the alias on the fly.
            </span>
          </dd>
        </div>
      </KeyValue>
      {patch.isError && <Alert>{apiErrorMessage(patch.error)}</Alert>}

      <RecordSection
        title="Prove ownership."
        blurb="This record proves to us that you control this domain."
        verified={domain.ownership_verified}
        successText="You verified ownership successfully."
        records={[records.ownership]}
        check={lastVerify?.ownership}
      />
      <RecordSection
        title="Receive mail."
        blurb="This record routes mail for your domain to Zinc so your aliases work."
        verified={domain.mx_verified}
        successText="You configured MX successfully."
        records={records.mx}
        check={lastVerify?.mx}
      />
      <RecordSection
        title="Send mail."
        blurb="This record lets you send mail securely from this domain, and keeps your mail from ending up in the spam folder."
        verified={domain.spf_verified}
        successText="You configured SPF successfully."
        records={[records.spf]}
        check={lastVerify?.spf}
      />
      {records.dkim && (
        <RecordSection
          title="Authenticate your mail."
          blurb="This record helps other servers stop spam via cryptographic signatures."
          verified={domain.dkim_verified}
          successText="You configured DKIM successfully."
          records={[records.dkim]}
          check={lastVerify?.dkim}
        />
      )}
      <RecordSection
        title="Protect your domain."
        blurb="This record tells other servers to distrust unsigned mail claiming to be from your domain."
        verified={domain.dmarc_verified}
        successText="You configured DMARC successfully."
        records={[records.dmarc]}
        check={lastVerify?.dmarc}
      />

      <p className={cx(ui.finePrint, css({ textAlign: "center", marginTop: "3rem" }))}>
        {domain.is_verified
          ? "You can re-verify any time to double-check your settings."
          : "Make sure the DNS configuration for this domain matches all of the records above, then click verify."}
      </p>
      <div className={cx(ui.actionsCenter, css({ marginTop: "1rem" }))}>
        <Button
          variant="submit"
          loading={verify.isPending}
          onClick={() => verify.mutate({ custom_domain_id: domain.id })}
        >
          {domain.is_verified || lastVerify !== null ? "Re-verify" : "Verify"}
        </Button>
      </div>

      <div className={cx(ui.actionsCenter, css({ marginTop: "4rem" }))}>
        <Button variant="link" onClick={() => setConfirmingDelete(true)}>
          » Delete this domain
        </Button>
      </div>

      <Dialog
        opened={confirmingDelete}
        onClose={() => {
          remove.reset();
          setConfirmingDelete(false);
        }}
        title="Delete domain"
      >
        <div className={css({ display: "flex", flexDirection: "column", gap: "1rem" })}>
          <p>
            Delete <span className={ui.mono}>{domain.domain_name}</span>? Every alias on it is
            deleted permanently — they can never be recreated.
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
              onClick={() => remove.mutate({ custom_domain_id: domain.id })}
            >
              Delete
            </Button>
          </div>
        </div>
      </Dialog>
    </Section>
  );
}

// A KeyValue row whose value is a control (the catch-all switch) — same
// visual grammar as KV but with room for the switch + fine print.
const kvSwitchRow = css({
  display: "flex",
  alignItems: "flex-start",
  backgroundColor: "surface",
  borderBottom: "1px solid token(colors.border)",
  padding: "1.4rem 0.5rem 1.4rem 0.1rem",
});
const kvSwitchKey = css({
  flex: "0 0 20%",
  minWidth: "10rem",
  marginRight: "1.5rem",
  paddingLeft: "1rem",
  textAlign: "right",
  color: "primary",
  fontFamily: "mono",
  paddingTop: "0.6rem",
  "@media (max-width: 650px)": { minWidth: "6rem" },
});
const kvSwitchValue = css({
  flex: "0 1 80%",
  margin: 0,
  display: "flex",
  alignItems: "center",
  gap: "1rem",
  flexWrap: "wrap",
});
