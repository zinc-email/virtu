// Domains index ("/domains") — the legacy "Customize your domain." page:
// benefits checklist, an add-domain form (premium-gated server-side), and the
// domain list with verification status.

import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { css, cx } from "styled-system/css";
import { apiErrorMessage } from "src/api/errors";
import { getCustomDomainsQueryKey, useGetCustomDomains, usePostCustomDomains } from "src/gen";
import {
  Alert,
  Button,
  Checklist,
  EntityList,
  EntityRow,
  Field,
  FieldRow,
  Section,
  Tag,
  Tags,
  ui,
} from "src/ui";

export function DomainsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [domain, setDomain] = useState("");

  const domains = useGetCustomDomains();
  const create = usePostCustomDomains({
    mutation: {
      onSuccess: (created) => {
        setDomain("");
        void queryClient.invalidateQueries({ queryKey: getCustomDomainsQueryKey() });
        // Land straight on the records-to-publish page.
        void navigate({ to: "/domains/$domainId", params: { domainId: String(created.id) } });
      },
    },
  });

  const rows = domains.data?.custom_domains ?? [];

  return (
    <Section narrow>
      <header className={css({ marginBottom: "2.11rem" })}>
        <h1 className={ui.h1}>Customize your domain.</h1>
      </header>
      <p className={ui.lead}>Adding a custom domain has many benefits.</p>
      <Checklist
        items={[
          "Send or reply to email without revealing your real email address.",
          <span key="customize">
            Customize your email aliases <small>(e.g. sales@your.com)</small>.
          </span>,
          "Remove the Zinc brand from your email aliases.",
        ]}
      />

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = domain.trim().toLowerCase();
          if (!trimmed) return;
          create.mutate({ data: { domain: trimmed } });
        }}
        className={css({ marginTop: "2rem" })}
      >
        {create.isError && <Alert>{apiErrorMessage(create.error)}</Alert>}
        <FieldRow
          field={
            <Field
              label="Add a domain"
              name="domain"
              placeholder="your-domain.com"
              value={domain}
              onChange={(e) => setDomain(e.currentTarget.value)}
            />
          }
          button={
            <Button
              type="submit"
              variant="submit"
              loading={create.isPending}
              className={css({ padding: "1rem 1.5rem 0.75rem 1.5rem", whiteSpace: "nowrap" })}
            >
              + Add
            </Button>
          }
        />
        <p className={cx(ui.finePrint, css({ marginTop: "0.8rem", marginBottom: 0 }))}>
          You'll get the DNS records to publish on the next screen.
        </p>
      </form>

      <div className={css({ marginTop: "3rem" })}>
        {domains.isPending ? (
          <p className={css({ textAlign: "center", padding: "2rem", color: "textDim" })}>
            Loading…
          </p>
        ) : domains.isError ? (
          <Alert>{apiErrorMessage(domains.error)}</Alert>
        ) : rows.length > 0 ? (
          <EntityList>
            {rows.map((d) => (
              // Verification is a whole flow, not a row action — the row
              // links to the detail page, which owns the verify button.
              <EntityRow
                key={d.id}
                to="/domains/$domainId"
                params={{ domainId: String(d.id) }}
                title={d.domain_name}
                detail={
                  <Tags>
                    {d.is_verified ? (
                      <Tag tone="primary">Verified</Tag>
                    ) : (
                      <Tag tone="accent">Not verified</Tag>
                    )}
                  </Tags>
                }
              />
            ))}
          </EntityList>
        ) : null}
      </div>
    </Section>
  );
}
