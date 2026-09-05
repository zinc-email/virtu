// Domain detail ("/domains/$domainId") — the legacy "Configure your domain."
// page: one section per DNS record (ownership TXT, MX, SPF, DKIM, DMARC) with
// the exact values to publish, a verify button running the real checks, the
// catch-all switch, and delete. The shell shows the back arrow here.

import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
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
import { formatZoneFile } from "src/lib/zoneFile";
import { Dialog } from "src/overlays";
import { Alert, Button, CodeBlock, KV, KVSwitch, KeyValue, Section, ui } from "src/ui";
import { useHead } from "src/head";

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

      {check && !check.ok && (
        <Alert>
          {check.errors.length === 0 ? (
            "We looked, and this record isn't published yet."
          ) : (
            <>
              <div>This record isn't right yet. We found:</div>
              {check.errors.map((e, i) => (
                <div
                  // Found DNS values can repeat across records; position keys them.
                  // biome-ignore lint/suspicious/noArrayIndexKey: static list, re-rendered whole
                  key={i}
                  className={css({
                    fontFamily: "mono",
                    fontSize: "0.85rem",
                    overflowWrap: "anywhere",
                    marginTop: "0.4rem",
                  })}
                >
                  {e}
                </div>
              ))}
            </>
          )}
        </Alert>
      )}

      {verified ? (
        <p className={css({ color: "primary", marginTop: "1rem" })}>✓ {successText}</p>
      ) : (
        records.map((r) => (
          <div
            key={`${r.type}-${r.hostname}-${r.value}`}
            className={css({
              display: "flex",
              flexDirection: "column",
              gap: "0.5rem",
              marginTop: "1.2rem",
            })}
          >
            <RecordRow label="Type">
              <span
                className={css({
                  display: "inline-block",
                  fontFamily: "mono",
                  fontSize: "0.85rem",
                  paddingTop: "0.65rem",
                  "@media (max-width: 480px)": { paddingTop: 0 },
                })}
              >
                {r.type}
                {r.priority !== undefined && (
                  <span className={ui.dim}> · priority {r.priority}</span>
                )}
              </span>
            </RecordRow>
            <RecordRow label="Name">
              <CodeBlock compact>{r.hostname}</CodeBlock>
            </RecordRow>
            <RecordRow label={r.type === "MX" ? "Target" : "Value"}>
              <CodeBlock compact>{r.value}</CodeBlock>
            </RecordRow>
          </div>
        ))
      )}
    </section>
  );
}

// A slim labeled line: teal mono label column, content (usually a code strip)
// taking the rest. Labels stack above on phones.
function RecordRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      className={css({
        display: "flex",
        alignItems: "flex-start",
        gap: "0.9rem",
        "@media (max-width: 480px)": { flexDirection: "column", gap: "0.25rem" },
      })}
    >
      <span
        className={css({
          flex: "0 0 4.5rem",
          textAlign: "right",
          color: "primary",
          fontFamily: "mono",
          fontSize: "0.8rem",
          paddingTop: "0.65rem",
          "@media (max-width: 480px)": {
            flexBasis: "auto",
            textAlign: "left",
            paddingTop: 0,
          },
        })}
      >
        {label}
      </span>
      <div className={css({ flex: "1 1 auto", minWidth: 0, width: "100%" })}>{children}</div>
    </div>
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
  useHead({
    title: domains.data?.custom_domains.find((d) => d.id === domainId)?.domain_name ?? "Domain",
  });
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
  // The record sections are long — the verify button renders at the top AND
  // beneath them, so retrying never means scrolling.
  const verifyButton = (
    <Button
      variant="submit"
      loading={verify.isPending}
      onClick={() => verify.mutate({ custom_domain_id: domain.id })}
    >
      {domain.is_verified || lastVerify !== null ? "Re-verify" : "Verify"}
    </Button>
  );
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

      {!domain.is_verified && (
        <div className={cx(ui.actionsCenter, css({ marginBottom: "2rem" }))}>{verifyButton}</div>
      )}

      <KeyValue>
        <KV k="Domain">{domain.domain_name}</KV>
        <KV k="Status">{domain.is_verified ? "Verified" : "Not verified"}</KV>
        <KVSwitch
          k="Catch-all"
          checked={domain.catch_all}
          disabled={patch.isPending}
          onChange={(v) => patch.mutate({ custom_domain_id: domain.id, data: { catch_all: v } })}
          hint="Mail to any address on this domain creates the alias on the fly."
        />
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

      <div className={cx(ui.actionsCenter, css({ marginTop: "2.5rem" }))}>
        <Button
          variant="link"
          onClick={() => {
            // Plaintext in a new tab. A data: URL can't be opened top-level,
            // so hand the browser a short-lived Blob URL instead.
            const url = URL.createObjectURL(
              new Blob([formatZoneFile(dns.data)], { type: "text/plain;charset=utf-8" }),
            );
            window.open(url, "_blank", "noopener");
            setTimeout(() => URL.revokeObjectURL(url), 60_000);
          }}
        >
          » View these records as a BIND zone file
        </Button>
      </div>

      <p className={cx(ui.finePrint, css({ textAlign: "center", marginTop: "3rem" }))}>
        {domain.is_verified
          ? "You can re-verify any time to double-check your settings."
          : "Make sure the DNS configuration for this domain matches all of the records above, then click verify."}
      </p>
      <div className={cx(ui.actionsCenter, css({ marginTop: "1rem" }))}>{verifyButton}</div>

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
