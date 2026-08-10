// Settings ("/settings") — legacy narrow page: left-aligned h1, old-style
// native selects (the legacy site styled native controls; no combobox
// widgetry), every control saves on change. Wired to GET/PATCH /setting and
// GET /v2/setting/domains through the Kubb hooks.

import { useQueryClient } from "@tanstack/react-query";
import { css } from "styled-system/css";
import { apiErrorMessage } from "src/api/errors";
import {
  getSettingQueryKey,
  type UpdateSettingRequest,
  useGetSetting,
  useGetV2SettingDomains,
  usePatchSetting,
} from "src/gen";
import { Alert, Section, SelectField, Switch, ui } from "src/ui";

const GENERATOR_OPTIONS = [
  { value: "word", label: "Random words (breeze_cedar123)" },
  { value: "uuid", label: "UUID (8d39e4b6-…)" },
];

const SUFFIX_OPTIONS = [
  { value: "random_string", label: "Random characters (.xk3f9)" },
  { value: "word", label: "Random word (.cedar381)" },
];

// SimpleLogin's sender_format variants, illustrated with its docs' example.
const SENDER_FORMAT_OPTIONS = [
  { value: "AT", label: "John Wick - john at wick.com" },
  { value: "A", label: "John Wick - john(a)wick.com" },
  { value: "NAME_ONLY", label: "John Wick" },
  { value: "AT_ONLY", label: "john at wick.com" },
  { value: "NO_NAME", label: "No name" },
];

export function SettingsPage() {
  const queryClient = useQueryClient();
  const setting = useGetSetting();
  const domains = useGetV2SettingDomains();

  const update = usePatchSetting({
    mutation: {
      onSuccess: (data) => {
        queryClient.setQueryData(getSettingQueryKey(), data);
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
          />
          <SelectField
            label="Default domain"
            hint="The domain random aliases are created on"
            options={domainOptions}
            value={setting.data.random_alias_default_domain}
            onChange={(e) => save({ random_alias_default_domain: e.currentTarget.value })}
            disabled={update.isPending || domains.isPending}
          />
          <SelectField
            label="Custom-alias suffix"
            hint="The random suffix offered when creating a custom alias"
            options={SUFFIX_OPTIONS}
            value={setting.data.random_alias_suffix}
            onChange={(e) => save({ random_alias_suffix: e.currentTarget.value })}
            disabled={update.isPending}
          />
          <SelectField
            label="Sender address format"
            hint="How the original sender appears on emails forwarded to you"
            options={SENDER_FORMAT_OPTIONS}
            value={setting.data.sender_format}
            onChange={(e) => save({ sender_format: e.currentTarget.value })}
            disabled={update.isPending}
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
              <div>Email notifications</div>
              <div className={ui.finePrint}>Bounce alerts and account notices</div>
            </div>
          </div>

          {update.isSuccess && !update.isPending && (
            <p className={css({ marginTop: "1.5rem", color: "primary", fontSize: "0.9rem" })}>
              Saved.
            </p>
          )}
        </div>
      )}
    </Section>
  );
}
