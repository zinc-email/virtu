// Overlay primitives on the native <dialog> element: the platform provides
// the top layer, focus trap, ESC handling, and ::backdrop — no library.
// Dialog is the centered modal; Drawer is the same element pinned to the
// right edge. Both close on ESC and on a click on the backdrop.

import { type ReactNode, useEffect, useRef } from "react";
import { css, cx } from "styled-system/css";
import { Icon, ui } from "src/ui";

const dialogBase = css({
  backgroundColor: "bg",
  color: "text",
  fontFamily: "sans",
  border: "0.111rem solid",
  borderColor: "border",
  padding: "1.5rem 2rem 2rem 2rem",
  boxSizing: "border-box",
  _backdrop: { backgroundColor: "rgba(0, 0, 0, 0.6)" },
});

const modalCss = css({
  margin: "auto",
  width: "min(92vw, 28rem)",
  borderRadius: "0.25rem",
});

const drawerCss = css({
  margin: "0 0 0 auto",
  width: "min(92vw, 26rem)",
  height: "100dvh",
  maxHeight: "100dvh",
  borderTop: "none",
  borderBottom: "none",
  borderRight: "none",
  overflowY: "auto",
});

const headerCss = css({
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  gap: "1rem",
  marginBottom: "1.5rem",
});

function Overlay({
  opened,
  onClose,
  title,
  variant,
  children,
}: {
  opened: boolean;
  onClose: () => void;
  title: ReactNode;
  variant: "modal" | "drawer";
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (opened && !dialog.open) dialog.showModal();
    else if (!opened && dialog.open) dialog.close();
  }, [opened]);

  if (!opened) return null;

  return (
    <dialog
      ref={ref}
      className={cx(dialogBase, variant === "modal" ? modalCss : drawerCss)}
      // ESC fires cancel; treat it as our close so React state stays in sync.
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      // A click that lands on the dialog element itself (not its content) is
      // a backdrop click.
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <header className={headerCss}>
        <div>{title}</div>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className={css({
            background: "none",
            border: "none",
            padding: "0.3rem",
            cursor: "pointer",
            color: "textDim",
            _hover: { color: "text" },
          })}
        >
          <Icon name="x" size="0.9rem" />
        </button>
      </header>
      {children}
    </dialog>
  );
}

export function Dialog(props: {
  opened: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
}) {
  return <Overlay variant="modal" {...props} title={<h2 className={ui.h2}>{props.title}</h2>} />;
}

export function Drawer(props: {
  opened: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
}) {
  return <Overlay variant="drawer" {...props} />;
}
