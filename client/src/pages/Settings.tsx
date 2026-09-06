// Settings ("/settings") — legacy narrow page: left-aligned h1, old-style
// native selects (the legacy site styled native controls; no combobox
// widgetry), every control saves on change. Wired to GET/PATCH /setting and
// GET /v2/setting/domains through the Kubb hooks.
//
// SMTP device passwords used to live at the bottom of this page; they moved
// to /smtp, where they sit with the setup instructions that give them a
// purpose. Only a pointer remains — one place owns that state.

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { css, cx } from "styled-system/css";
import { apiErrorMessage } from "src/api/errors";
import { Link } from "@tanstack/react-router";
import {
  getSettingQueryKey,
  type UpdateSettingRequest,
  useGetSetting,
  useGetV2SettingDomains,
  usePatchSetting,
} from "src/gen";
import { Alert, Icon, Section, SelectField, Switch, ui } from "src/ui";
import { useHead } from "src/head";

const GENERATOR_OPTIONS = [
  { value: "word", label: "Random words (breeze_cedar123)" },
  { value: "uuid", label: "UUID (8d39e4b6-…)" },
];

const SUFFIX_OPTIONS = [
  { value: "random_string", label: "Random characters (.xk3f9)" },
  { value: "word", label: "Random word (.cedar381)" },
];

// SimpleLogin's sender_format variants. The example shows only the display
// name of the rewritten From header — the address part is always the
// contact's reverse alias (so replies route back through us and DMARC
// passes), which is also why the sender's real "@" is spelled out.
const SENDER_FORMAT_OPTIONS = [
  { value: "AT", label: "Alan Watts - alan.watts at sjsu.edu" },
  { value: "A", label: "Alan Watts - alan.watts(a)sjsu.edu" },
  { value: "NAME_ONLY", label: "Alan Watts" },
  { value: "AT_ONLY", label: "alan.watts at sjsu.edu" },
  { value: "NO_NAME", label: "No name" },
];

export function SettingsPage() {
  useHead({ title: "Settings" });
  const queryClient = useQueryClient();
  const setting = useGetSetting();
  const domains = useGetV2SettingDomains();

  // "Just saved" feedback: remember which setting the last successful PATCH
  // carried and show a transient check on that control (a "Saved." note at
  // the bottom of the page is invisible once you've scrolled). A fresh
  // object per save restarts the timer even for a re-save of the same key.
  const [savedField, setSavedField] = useState<{ key: string } | null>(null);
  useEffect(() => {
    if (savedField === null) return;
    const id = setTimeout(() => setSavedField(null), 2000);
    return () => clearTimeout(id);
  }, [savedField]);
  const justSaved = (key: keyof UpdateSettingRequest) => savedField?.key === key;

  const update = usePatchSetting({
    mutation: {
      onSuccess: (data, vars) => {
        queryClient.setQueryData(getSettingQueryKey(), data);
        const key = Object.keys(vars.data ?? {})[0];
        if (key !== undefined) setSavedField({ key });
      },
    },
  });
  const save = (patch: UpdateSettingRequest) => update.mutate({ data: patch });

  const domainOptions =
    domains.data?.map((d) => ({
      value: d.domain,
      label: d.is_custom ? `${d.domain} (custom domain)` : d.domain,
    })) ?? [];

  return (
    <Section narrow>
      <header className={css({ marginBottom: "2.11rem" })}>
        <h1 className={ui.h1}>Your settings.</h1>
      </header>

      {setting.isPending ? (
        <p className={css({ padding: "2rem 0", color: "textDim" })}>Loading…</p>
      ) : setting.isError ? (
        <Alert>{apiErrorMessage(setting.error)}</Alert>
      ) : (
        <div className={css({ width: "100%" })}>
          {update.isError && <Alert>{apiErrorMessage(update.error)}</Alert>}

          <SelectField
            label="Alias generator"
            hint="How addresses for one-click random aliases are built"
            options={GENERATOR_OPTIONS}
            value={setting.data.alias_generator}
            onChange={(e) => save({ alias_generator: e.currentTarget.value })}
            disabled={update.isPending}
            saved={justSaved("alias_generator")}
          />
          <SelectField
            label="Default domain"
            hint="The domain random aliases are created on"
            options={domainOptions}
            value={setting.data.random_alias_default_domain}
            onChange={(e) => save({ random_alias_default_domain: e.currentTarget.value })}
            disabled={update.isPending || domains.isPending}
            saved={justSaved("random_alias_default_domain")}
          />
          <SelectField
            label="Custom-alias suffix"
            hint="The random suffix offered when creating a custom alias"
            options={SUFFIX_OPTIONS}
            value={setting.data.random_alias_suffix}
            onChange={(e) => save({ random_alias_suffix: e.currentTarget.value })}
            disabled={update.isPending}
            saved={justSaved("random_alias_suffix")}
          />
          <SelectField
            label="Sender address format"
            hint="How the original sender appears in the From name — the address itself is always the reverse alias you reply to"
            options={SENDER_FORMAT_OPTIONS}
            value={setting.data.sender_format}
            onChange={(e) => save({ sender_format: e.currentTarget.value })}
            disabled={update.isPending}
            saved={justSaved("sender_format")}
          />

          <div
            className={css({
              display: "flex",
              alignItems: "center",
              gap: "1rem",
              marginTop: "2rem",
            })}
          >
            <Switch
              checked={setting.data.notification}
              disabled={update.isPending}
              onChange={(v) => save({ notification: v })}
              label="Email notifications"
            />
            <div>
              <div className={css({ display: "flex", alignItems: "center", gap: "0.5rem" })}>
                Email notifications
                {/* Always in the flow (opacity-toggled) so appearing never shifts widths. */}
                <span
                  aria-hidden="true"
                  className={css({ color: "primary", transition: "opacity 0.3s" })}
                  style={{ opacity: justSaved("notification") ? 1 : 0 }}
                >
                  <Icon name="check" size="0.8rem" />
                </span>
              </div>
              <div className={ui.finePrint}>Bounce alerts and account notices</div>
            </div>
          </div>
        </div>
      )}

      <div className={css({ marginTop: "4rem" })}>
        <h2 className={cx(ui.h2, css({ marginBottom: "1rem" }))}>Mail client.</h2>
        <p className={ui.finePrint}>
          Send and reply as your aliases from your own mail app.{" "}
          <Link to="/smtp" className={ui.link}>
            Set up SMTP and manage device passwords
          </Link>
          .
        </p>
      </div>
    </Section>
  );
}
