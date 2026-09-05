// Admin operators ("/admin/operators") — who receives operator mail: the
// RFC 2142 role addresses on the service domain (postmaster@, abuse@ …).
// One KVSwitch row per operator (stateful setting = switch row, not a verb
// button). The server owns the fallback rule (nobody opted in → the first
// operator receives) and reports it as `effective`, so this page only
// displays it.

import { useQueryClient } from "@tanstack/react-query";
import { css } from "styled-system/css";
import { apiErrorMessage } from "src/api/errors";
import { getAdminOperatorsQueryKey, useGetAdminOperators, usePatchAdminOperatorsId } from "src/gen";
import { Alert, EmailBreak, KeyValue, KVSwitch, Section, Tag, Tags, ui } from "src/ui";
import { AdminErrorAlert } from "src/pages/adminCommon";

export function AdminOperatorsPage() {
  const queryClient = useQueryClient();
  const list = useGetAdminOperators();
  const update = usePatchAdminOperatorsId({
    mutation: {
      onSuccess: (data) => {
        queryClient.setQueryData(getAdminOperatorsQueryKey(), data);
      },
    },
  });

  if (list.isPending) {
    return (
      <Section narrow>
        <p className={css({ textAlign: "center", padding: "2rem", color: "textDim" })}>Loading…</p>
      </Section>
    );
  }
  if (list.isError) {
    return (
      <Section narrow>
        <AdminErrorAlert error={list.error} />
      </Section>
    );
  }

  const { localparts, operators } = list.data;
  const anyOptedIn = operators.some((o) => o.receives_operator_mail);

  return (
    <Section narrow>
      <header className={css({ marginBottom: "2.11rem" })}>
        <h1 className={ui.h1}>Operator mail.</h1>
        <p className={css({ color: "textDim", marginTop: "0.5rem" })}>
          Mail to{" "}
          {localparts.map((lp, i) => (
            <span key={lp}>
              {i > 0 && ", "}
              <span className={ui.mono}>{lp}@</span>
            </span>
          ))}{" "}
          on the service domain is delivered to the operators switched on below.
          {!anyOptedIn && " Nobody has opted in, so the first operator receives it by default."}
        </p>
      </header>

      {update.isError && <Alert>{apiErrorMessage(update.error)}</Alert>}

      {operators.length === 0 ? (
        <p className={css({ textAlign: "center", padding: "2rem", color: "textDim" })}>
          No operators yet.
        </p>
      ) : (
        <KeyValue>
          {operators.map((op) => (
            <KVSwitch
              key={op.id}
              k={<EmailBreak email={op.email} />}
              label={`Operator mail to ${op.email}`}
              checked={op.receives_operator_mail}
              disabled={update.isPending}
              onChange={(v) => update.mutate({ id: op.id, data: { receives_operator_mail: v } })}
              hint={
                <>
                  <Tags>
                    {op.effective && <Tag tone="primary">receiving</Tag>}
                    {!op.mailbox_deliverable && <Tag tone="accent">mailbox not deliverable</Tag>}
                  </Tags>
                  {op.mailbox === null ? (
                    <span className={css({ display: "block", marginTop: "0.3rem" })}>
                      no default mailbox
                    </span>
                  ) : (
                    op.mailbox !== op.email && (
                      <span className={css({ display: "block", marginTop: "0.3rem" })}>
                        to <EmailBreak email={op.mailbox} />
                      </span>
                    )
                  )}
                </>
              }
            />
          ))}
        </KeyValue>
      )}
    </Section>
  );
}
