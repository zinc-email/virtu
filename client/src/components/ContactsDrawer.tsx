// Per-alias contacts drawer: list contacts (reverse aliases), create one,
// copy the reverse alias, block/unblock, delete.

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { css, cx } from "styled-system/css";
import { apiErrorMessage } from "src/api/errors";
import {
  type Alias,
  getAliasesAliasIdContactsQueryKey,
  useDeleteContactsContactId,
  useGetAliasesAliasIdContacts,
  usePostAliasesAliasIdContacts,
  usePostContactsContactIdToggle,
} from "src/gen";
import { Drawer } from "src/overlays";
import { Alert, Button, CopyButton, Field, ui } from "src/ui";

interface Props {
  alias: Alias | null;
  onClose: () => void;
}

const contactRow = css({
  backgroundColor: "surface",
  borderBottom: "1px solid token(colors.border)",
  padding: "1rem 1.2rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.5rem",
});

export function ContactsDrawer({ alias, onClose }: Props) {
  const queryClient = useQueryClient();
  const [newContact, setNewContact] = useState("");
  const opened = alias !== null;
  const aliasId = alias?.id ?? -1;

  const contacts = useGetAliasesAliasIdContacts(
    aliasId,
    { page_id: "0" },
    { query: { enabled: opened } },
  );

  const invalidate = () =>
    void queryClient.invalidateQueries({
      queryKey: getAliasesAliasIdContactsQueryKey(aliasId, { page_id: "0" }),
    });

  const create = usePostAliasesAliasIdContacts({
    mutation: {
      onSuccess: () => {
        setNewContact("");
        invalidate();
      },
    },
  });
  const toggle = usePostContactsContactIdToggle({
    mutation: { onSuccess: invalidate },
  });
  const remove = useDeleteContactsContactId({
    mutation: { onSuccess: invalidate },
  });

  return (
    <Drawer
      opened={opened}
      onClose={() => {
        create.reset();
        setNewContact("");
        onClose();
      }}
      title={
        <div>
          <h2 className={ui.h2}>Contacts</h2>
          <div className={cx(ui.mono, ui.dim, css({ fontSize: "0.85rem", marginTop: "0.3rem" }))}>
            {alias?.email}
          </div>
        </div>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!newContact.trim() || !alias) return;
          create.mutate({ alias_id: alias.id, data: { contact: newContact.trim() } });
        }}
      >
        <div className={css({ display: "flex", gap: "0.75rem", alignItems: "flex-end" })}>
          <div className={css({ flex: 1, minWidth: 0, "& > div": { marginBottom: 0 } })}>
            <Field
              label="New contact"
              name="new-contact"
              placeholder="someone@example.com"
              value={newContact}
              onChange={(e) => setNewContact(e.currentTarget.value)}
            />
          </div>
          <Button
            type="submit"
            variant="submit"
            loading={create.isPending}
            className={css({ padding: "1rem 1.5rem 0.75rem 1.5rem" })}
          >
            Add
          </Button>
        </div>
        {create.isError && <Alert>{apiErrorMessage(create.error)}</Alert>}
        <p className={cx(ui.finePrint, css({ margin: "0.8rem 0 0 0" }))}>
          Sending to a contact's reverse alias delivers from your alias — the contact never sees
          your real address.
        </p>
      </form>

      <div className={css({ marginTop: "2rem" })}>
        {contacts.isPending && opened ? (
          <p className={css({ textAlign: "center", padding: "1.5rem", color: "textDim" })}>
            Loading…
          </p>
        ) : contacts.isError ? (
          <Alert>{apiErrorMessage(contacts.error)}</Alert>
        ) : (
          <ul className={css({ listStyle: "none", margin: 0, padding: 0 })}>
            {contacts.data?.contacts.length === 0 && (
              <li className={css({ textAlign: "center", padding: "1.5rem", color: "textDim" })}>
                No contacts yet. Add one to get its reverse alias.
              </li>
            )}
            {contacts.data?.contacts.map((contact) => (
              <li key={contact.id} className={contactRow}>
                <div
                  className={css({
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: "0.75rem",
                  })}
                >
                  <span
                    className={css({
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      color: "heading",
                    })}
                  >
                    {contact.contact}
                  </span>
                  {contact.block_forward && (
                    <span
                      className={css({
                        flexShrink: 0,
                        fontFamily: "mono",
                        fontSize: "0.6rem",
                        textTransform: "uppercase",
                        color: "accent",
                        border: "1px solid token(colors.accent)",
                        borderRadius: "0.111rem",
                        padding: "0.2em 0.6em",
                      })}
                    >
                      Blocked
                    </span>
                  )}
                </div>
                <div
                  className={cx(
                    ui.mono,
                    css({
                      fontSize: "0.75rem",
                      color: "textDim",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }),
                  )}
                >
                  {contact.reverse_alias_address}
                </div>
                <div className={css({ display: "flex", gap: "0.5rem", alignItems: "center" })}>
                  <CopyButton text={contact.reverse_alias_address} />
                  <Button
                    size="tiny"
                    loading={toggle.isPending && toggle.variables?.contact_id === contact.id}
                    onClick={() => toggle.mutate({ contact_id: contact.id })}
                  >
                    {contact.block_forward ? "Unblock" : "Block"}
                  </Button>
                  <Button
                    size="tiny"
                    loading={remove.isPending && remove.variables?.contact_id === contact.id}
                    onClick={() => remove.mutate({ contact_id: contact.id })}
                  >
                    Delete
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Drawer>
  );
}
