// The virtu UI kit: a small set of typed primitives reproducing the legacy
// site's design language (see tmp/virtu for the original SCSS) on Panda
// tokens. Components name semantic roles (primary/accent/surface/…), never
// hues, and size everything in rem/em so the whole app scales with the root
// font-size. Overlays live in src/overlays.tsx (native <dialog>).

import { Link, type LinkProps } from "@tanstack/react-router";
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { useRef, useState } from "react";
import { css, cx } from "styled-system/css";

// ── Icons (inline FontAwesome-era paths, from the legacy icon component) ─────

const ICON_PATHS = {
  clipboard:
    "M768 1664h896v-640h-416q-40 0-68-28t-28-68v-416h-384v1152zm256-1440v-64q0-13-9.5-22.5t-22.5-9.5h-704q-13 0-22.5 9.5t-9.5 22.5v64q0 13 9.5 22.5t22.5 9.5h704q13 0 22.5-9.5t9.5-22.5zm256 672h299l-299-299v299zm512 128v672q0 40-28 68t-68 28h-960q-40 0-68-28t-28-68v-160h-544q-40 0-68-28t-28-68v-1344q0-40 28-68t68-28h1088q40 0 68 28t28 68v328q21 13 36 28l408 408q28 28 48 76t20 88z",
  check:
    "M1671 566q0 40-28 68l-724 724-136 136q-28 28-68 28t-68-28l-136-136-362-362q-28-28-28-68t28-68l136-136q28-28 68-28t68 28l294 295 656-657q28-28 68-28t68 28l136 136q28 28 28 68z",
  "arrow-left":
    "M1664 896v128q0 53-32.5 90.5t-84.5 37.5h-704l293 294q38 36 38 90t-38 90l-75 76q-37 37-90 37-52 0-91-37l-651-652q-37-37-37-90 0-52 37-91l651-650q38-38 91-38 52 0 90 38l75 74q38 38 38 91t-38 91l-293 293h704q52 0 84.5 37.5t32.5 90.5z",
  x: "M1490 1322q0 40-28 68l-136 136q-28 28-68 28t-68-28l-294-294-294 294q-28 28-68 28t-68-28l-136-136q-28-28-28-68t28-68l294-294-294-294q-28-28-28-68t28-68l136-136q28-28 68-28t68 28l294 294 294-294q28-28 68-28t68 28l136 136q28 28 28 68t-28 68l-294 294 294 294q28 28 28 68z",
  bars: "M1664 1344v128q0 26-19 45t-45 19h-1408q-26 0-45-19t-19-45v-128q0-26 19-45t45-19h1408q26 0 45 19t19 45zm0-512v128q0 26-19 45t-45 19h-1408q-26 0-45-19t-19-45v-128q0-26 19-45t45-19h1408q26 0 45 19t19 45zm0-512v128q0 26-19 45t-45 19h-1408q-26 0-45-19t-19-45v-128q0-26 19-45t45-19h1408q26 0 45 19t19 45z",
  bell: "M912 1696q0-16-16-16-59 0-101.5-42.5t-42.5-101.5q0-16-16-16t-16 16q0 73 51.5 124.5t124.5 51.5q16 0 16-16zm816-288q0 52-38 90t-90 38h-448q0 106-75 181t-181 75-181-75-75-181h-448q-52 0-90-38t-38-90q50-42 91-88t85-119.5 74.5-158.5 50-206 19.5-260q0-152 117-282.5t307-158.5q-8-19-8-39 0-40 28-68t68-28 68 28 28 68q0 20-8 39 190 28 307 158.5t117 282.5q0 139 19.5 260t50 206 74.5 158.5 85 119.5 91 88z",
  user: "M1600 1405q0 120-73 189.5t-194 69.5h-874q-121 0-194-69.5t-73-189.5q0-53 3.5-103.5t14-109 26.5-108.5 43-97.5 62-81 85.5-53.5 111.5-20q9 0 42 21.5t74.5 48 108 48 133.5 21.5 133.5-21.5 108-48 74.5-48 42-21.5q61 0 111.5 20t85.5 53.5 62 81 43 97.5 26.5 108.5 14 109 3.5 103.5zm-320-893q0 159-112.5 271.5t-271.5 112.5-271.5-112.5-112.5-271.5 112.5-271.5 271.5-112.5 271.5 112.5 112.5 271.5z",
  "chevron-down":
    "M1395 736q0 13-10 23l-466 466q-10 10-23 10t-23-10l-466-466q-10-10-10-23t10-23l50-50q10-10 23-10t23 10l393 393 393-393q10-10 23-10t23 10l50 50q10 10 10 23z",
} as const;

export function Icon({ name, size = "1em" }: { name: keyof typeof ICON_PATHS; size?: string }) {
  return (
    <svg
      viewBox="0 0 1792 1792"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
      className={css({ display: "block", flexShrink: 0 })}
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

// The Zinc "Z" mark (from the legacy nav), colored by the primary role.
export function Logo({ size = "3rem" }: { size?: string }) {
  return (
    <svg
      viewBox="0 0 101.6 101.6"
      width={size}
      height={size}
      aria-hidden="true"
      className={css({ display: "block", color: "primary" })}
    >
      <g transform="translate(0 -195.4)">
        <path
          transform="matrix(.26458 0 0 .26458 0 195.4)"
          d="m0 0v384h384v-384zm19.15 19.15h345.7v345.7h-345.7zm60.916 54.533v229.86h229.86v-229.86zm22.391 23.094h184.62v57.922h-16.969l-68.768 68.768h85.736v57.922h-184.62v-57.922h16.969l68.77-68.768h-85.738z"
          fill="currentColor"
        />
      </g>
    </svg>
  );
}

// ── Button ───────────────────────────────────────────────────────────────────
// Legacy variants: outline (default), submit (teal fill), cta (amber outline),
// link (bare amber mono). `tiny` is the uppercase mono list-row size.

type ButtonVariant = "outline" | "submit" | "cta" | "link";

const btnBase = css({
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "0.5em",
  textAlign: "center",
  fontFamily: "sans",
  fontSize: "1rem",
  lineHeight: "1.4rem",
  border: "0.111rem solid transparent",
  borderRadius: "0.111rem",
  cursor: "pointer",
  transition: "background-color 0.15s, border-color 0.15s, color 0.15s",
  _disabled: { opacity: 0.5, cursor: "not-allowed" },
});

const btnSize = {
  md: css({ padding: "1rem 2rem 0.75rem 2rem" }),
  tiny: css({
    fontFamily: "mono",
    fontSize: "0.6rem",
    lineHeight: "1em",
    textTransform: "uppercase",
    padding: "0.5em 1em",
  }),
};

const btnVariant: Record<ButtonVariant, string> = {
  outline: css({
    backgroundColor: "transparent",
    color: "control",
    borderColor: "border",
    _hover: { borderColor: "control", backgroundColor: "controlHoverBg" },
  }),
  submit: css({
    backgroundColor: "primary",
    borderColor: "primary",
    color: "onPrimary",
    fontWeight: "bold",
    _hover: { backgroundColor: "primaryHover", borderColor: "primaryHover" },
  }),
  cta: css({
    backgroundColor: "transparent",
    borderColor: "accent",
    color: "accent",
    _hover: { backgroundColor: "accent", color: "onAccent" },
  }),
  link: css({
    backgroundColor: "transparent",
    border: "none",
    color: "accent",
    fontFamily: "mono",
    padding: "0.3rem 0.4rem",
    _hover: { color: "accentHover" },
  }),
};

interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: keyof typeof btnSize;
  loading?: boolean;
}

export function Button({
  variant = "outline",
  size = "md",
  loading,
  disabled,
  className,
  ...props
}: BtnProps) {
  return (
    <button
      className={cx(
        btnBase,
        variant === "link" ? undefined : btnSize[size],
        btnVariant[variant],
        className,
      )}
      disabled={disabled || loading}
      aria-busy={loading}
      {...props}
    />
  );
}

// ── Form fields ──────────────────────────────────────────────────────────────

const fieldWrap = css({ display: "block", marginBottom: "1.618rem" });
const fieldLabel = css({ display: "block", marginBottom: "0.61rem", color: "label" });
const controlCss = css({
  display: "block",
  width: "100%",
  boxSizing: "border-box",
  fontFamily: "sans",
  fontSize: "1rem",
  padding: "1rem 1.1rem",
  backgroundColor: "transparent",
  color: "control",
  border: "0.111rem solid",
  borderColor: "border",
  borderRadius: "0.25rem",
  _placeholder: { color: "textDim" },
  _hover: { backgroundColor: "surfaceHover", borderColor: "borderBright" },
  _focus: {
    backgroundColor: "surfaceHover",
    color: "controlFocus",
    outline: "0.111rem solid",
    outlineColor: "focusRing",
  },
});
const fieldHint = css({
  marginTop: "0.5rem",
  lineHeight: "1.3em",
  opacity: 0.75,
  fontSize: "0.9rem",
  color: "label",
});

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
}

export function Field({ label, hint, id, className, ...props }: FieldProps) {
  const inputId = id ?? props.name ?? label.toLowerCase();
  return (
    <div className={fieldWrap}>
      <label className={fieldLabel} htmlFor={inputId}>
        {label}
      </label>
      <input id={inputId} className={cx(controlCss, className)} {...props} />
      {hint && <div className={fieldHint}>{hint}</div>}
    </div>
  );
}

interface SelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
  hint?: string;
  options: { value: string; label: string }[];
  /**
   * Transient "just saved" feedback: while true the chevron slot shows a
   * check instead. The icon lives in the absolutely-positioned overlay, so
   * toggling it never shifts layout.
   */
  saved?: boolean;
}

export function SelectField({
  label,
  hint,
  options,
  saved,
  id,
  className,
  ...props
}: SelectFieldProps) {
  const selectId = id ?? props.name ?? label.toLowerCase();
  return (
    <div className={fieldWrap}>
      <label className={fieldLabel} htmlFor={selectId}>
        {label}
      </label>
      <div className={css({ position: "relative" })}>
        <select
          id={selectId}
          className={cx(
            controlCss,
            // The native option popup takes its chrome from color-scheme and
            // its rows from option{} — without these the browser paints a
            // light popup against the dark theme. The native arrow sits flush
            // against the border, so it's replaced with our own chevron at the
            // control's 1.1rem inset.
            css({
              cursor: "pointer",
              appearance: "none",
              paddingRight: "2.8rem",
              colorScheme: "dark",
              _light: { colorScheme: "light" },
              "& option": { backgroundColor: "bg", color: "text" },
            }),
            className,
          )}
          {...props}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <span
          className={css({
            position: "absolute",
            right: "1.1rem",
            top: "50%",
            transform: "translateY(-50%)",
            pointerEvents: "none",
            color: "control",
            "&[data-saved]": { color: "primary" },
          })}
          data-saved={saved ? "" : undefined}
        >
          <Icon name={saved ? "check" : "chevron-down"} size="0.9rem" />
        </span>
      </div>
      {hint && <div className={fieldHint}>{hint}</div>}
    </div>
  );
}

interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  hint?: string;
}

export function TextArea({ label, hint, id, className, ...props }: TextAreaProps) {
  const areaId = id ?? props.name ?? label.toLowerCase();
  return (
    <div className={fieldWrap}>
      <label className={fieldLabel} htmlFor={areaId}>
        {label}
      </label>
      <textarea
        id={areaId}
        className={cx(controlCss, css({ resize: "vertical", minHeight: "4.5rem" }), className)}
        {...props}
      />
      {hint && <div className={fieldHint}>{hint}</div>}
    </div>
  );
}

// An [input][button] pair sharing a row: the field stretches, the button
// hangs off the end — and the button flows beneath the field on small
// screens instead of squeezing it. Use for every add/create inline form.
export function FieldRow({ field, button }: { field: ReactNode; button: ReactNode }) {
  return (
    <div
      className={css({
        display: "flex",
        gap: "0.75rem",
        alignItems: "flex-end",
        "@media (max-width: 650px)": { flexDirection: "column", alignItems: "stretch" },
      })}
    >
      <div className={css({ flex: 1, minWidth: 0, "& > div": { marginBottom: 0 } })}>{field}</div>
      {button}
    </div>
  );
}

// A labeled group of native checkboxes (e.g. mailbox pickers).
export function CheckboxGroup({
  label,
  hint,
  options,
  value,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  options: { value: string; label: string }[];
  value: string[];
  onChange: (v: string[]) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className={cx(fieldWrap, css({ border: "none", margin: 0, padding: 0 }))}>
      <legend className={fieldLabel}>{label}</legend>
      {options.map((o) => (
        <label
          key={o.value}
          className={css({
            display: "flex",
            alignItems: "center",
            gap: "0.6rem",
            cursor: "pointer",
            padding: "0.25rem 0",
          })}
        >
          <input
            type="checkbox"
            checked={value.includes(o.value)}
            disabled={disabled}
            onChange={(e) =>
              onChange(
                e.currentTarget.checked ? [...value, o.value] : value.filter((v) => v !== o.value),
              )
            }
            className={css({ accentColor: "primary", width: "1rem", height: "1rem" })}
          />
          <span>{o.label}</span>
        </label>
      ))}
      {hint && <div className={fieldHint}>{hint}</div>}
    </fieldset>
  );
}

// ── Pin input (activation codes) ─────────────────────────────────────────────
// Six single-digit boxes with auto-advance, backspace-to-previous, and paste
// distribution. `value` is the contiguous string of entered digits.

const pinBox = css({
  width: "2.4rem",
  height: "3rem",
  textAlign: "center",
  fontFamily: "mono",
  fontSize: "1.2rem",
  backgroundColor: "transparent",
  color: "control",
  border: "0.111rem solid",
  borderColor: "border",
  borderRadius: "0.25rem",
  _focus: {
    backgroundColor: "surfaceHover",
    color: "controlFocus",
    outline: "0.111rem solid",
    outlineColor: "focusRing",
  },
  _disabled: { opacity: 0.5 },
});

export function PinInput({
  length = 6,
  value,
  onChange,
  onComplete,
  disabled,
  autoFocus,
  label,
}: {
  length?: number;
  value: string;
  onChange: (v: string) => void;
  onComplete?: (v: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  label: string;
}) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const chars = Array.from({ length }, (_, i) => value[i] ?? "");

  const commit = (next: string[]) => {
    const joined = next.join("");
    onChange(joined);
    if (joined.length === length) onComplete?.(joined);
  };

  const handleChange = (i: number, raw: string) => {
    const digit = raw.replace(/\D/g, "").slice(-1);
    const next = chars.slice();
    next[i] = digit;
    commit(next);
    if (digit && i < length - 1) refs.current[i + 1]?.focus();
  };

  const handleKeyDown = (i: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace" && !chars[i] && i > 0) refs.current[i - 1]?.focus();
    if (e.key === "ArrowLeft" && i > 0) refs.current[i - 1]?.focus();
    if (e.key === "ArrowRight" && i < length - 1) refs.current[i + 1]?.focus();
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const digits = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, length);
    if (!digits) return;
    e.preventDefault();
    commit(digits.split(""));
    refs.current[Math.min(digits.length, length - 1)]?.focus();
  };

  return (
    <div
      role="group"
      aria-label={label}
      onPaste={handlePaste}
      className={css({ display: "inline-flex", gap: "0.4rem" })}
    >
      {chars.map((ch, i) => (
        <input
          // Position is the identity of each box.
          // biome-ignore lint: index keys are correct here
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          data-pin=""
          type="text"
          inputMode="numeric"
          autoComplete={i === 0 ? "one-time-code" : "off"}
          maxLength={1}
          value={ch}
          disabled={disabled}
          autoFocus={autoFocus && i === 0}
          aria-label={`${label} digit ${i + 1}`}
          onChange={(e) => handleChange(i, e.currentTarget.value)}
          onKeyDown={(e) => handleKeyDown(i, e)}
          className={pinBox}
        />
      ))}
    </div>
  );
}

// ── Switch ───────────────────────────────────────────────────────────────────
// The legacy virtu-checkbox: recessed dark ring, sliding knob with a spring
// overshoot, ON/OFF labels that cross-fade, and a teal glow when on. Sized in
// em so `fontSize` scales the whole control.

const switchCss = css({
  display: "inline-block",
  fontSize: "0.95rem",
  padding: "0.5em",
  backgroundColor: "bgDeep",
  border: "none",
  borderRadius: "1.5em",
  cursor: "pointer",
  transition: "background-color 0.5s token(easings.spring)",
  // Disabled covers two cases — a save in flight (every page passes the
  // mutation's isPending) and a real lock (the default-mailbox switch is held
  // ON) — so the cursor is the neutral default, not the forbidding
  // not-allowed one: a click during a save is simply ignored, and the dim says
  // "not right now" in both cases.
  _disabled: { opacity: 0.6, cursor: "default" },

  "& [data-part=track]": {
    display: "block",
    position: "relative",
    width: "4em",
    height: "2em",
    borderRadius: "1em",
    backgroundColor: "bgDeep",
    transition:
      "background-color 0.5s token(easings.spring), box-shadow 0.5s token(easings.spring)",
  },
  "& [data-part=label]": {
    position: "absolute",
    top: "0.825em",
    fontSize: "0.8em",
    lineHeight: "1em",
    textTransform: "uppercase",
    fontFamily: "sans",
    color: "paper.50",
    transition: "opacity 0.5s token(easings.spring)",
  },
  "& [data-part=label][data-on]": {
    left: "0.75em",
    textShadow: "0em 0em 0.1em #fff",
    opacity: 0,
  },
  "& [data-part=label][data-off]": { right: "0.5em", opacity: 1 },
  "& [data-part=knob]": {
    position: "absolute",
    top: "0",
    left: "0",
    width: "2em",
    height: "2em",
    borderRadius: "1em",
    backgroundColor: "rgba(249, 249, 245, 0.8)",
    boxShadow: "-0.1em 0em 0.3em 0.1em rgba(46, 74, 119, 0.1)",
    transition: "left 0.5s token(easings.spring)",
  },

  "&[aria-checked=true] [data-part=track]": {
    backgroundColor: "primary",
    boxShadow: "0px 0px 0.5em 0.1em token(colors.primaryGlow)",
  },
  "&[aria-checked=true] [data-part=label][data-on]": { opacity: 1 },
  "&[aria-checked=true] [data-part=label][data-off]": { opacity: 0 },
  "&[aria-checked=true] [data-part=knob]": { left: "2em" },
});

export function Switch({
  checked,
  onChange,
  disabled,
  label,
  size,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label: string;
  /** Scales the whole control; the legacy default is 0.95rem. */
  size?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={switchCss}
      style={size ? { fontSize: size } : undefined}
    >
      <span data-part="track">
        <span data-part="label" data-on="">
          On
        </span>
        <span data-part="knob" />
        <span data-part="label" data-off="">
          Off
        </span>
      </span>
    </button>
  );
}

// ── Tags (state chips on entity rows) ────────────────────────────────────────
// Read-only state markers: mono/uppercase like tiny buttons, but filled with
// a translucent wash of their own text color — no border — so they can't be
// mistaken for actions. Tones name roles: primary = healthy state, accent =
// needs attention, neutral = informational.

type TagTone = "primary" | "accent" | "neutral";

const tagCss = css({
  display: "inline-block",
  fontFamily: "mono",
  fontSize: "0.6rem",
  lineHeight: "1em",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  padding: "0.5em 0.9em 0.4em 0.9em",
  borderRadius: "0.111rem",
  backgroundColor: "color-mix(in srgb, currentColor 12%, transparent)",
  whiteSpace: "nowrap",
});

const tagTone: Record<TagTone, string> = {
  primary: css({ color: "primary" }),
  accent: css({ color: "accent" }),
  neutral: css({ color: "label" }),
};

export function Tag({ tone = "neutral", children }: { tone?: TagTone; children: ReactNode }) {
  return <span className={cx(tagCss, tagTone[tone])}>{children}</span>;
}

// Lays Tags out on an entity row's detail line (a span: the detail slot
// renders inside one). The margin is the title→tags gap: the detail slot's
// own marginTop never applies (it's an inline span), so the space lives here.
export function Tags({ children }: { children: ReactNode }) {
  return (
    <span
      className={css({
        display: "flex",
        flexWrap: "wrap",
        gap: "0.5rem",
        alignItems: "center",
        marginTop: "0.5rem",
      })}
    >
      {children}
    </span>
  );
}

// ── Copy button ──────────────────────────────────────────────────────────────

export function CopyButton({
  text,
  iconOnly,
  className,
}: {
  text: string;
  /** Just the clipboard glyph — for corners of code blocks. */
  iconOnly?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      size="tiny"
      aria-label={copied ? "Copied" : "Copy"}
      title="Copy"
      className={cx(
        // Never collapses or wraps, wherever a flex row squeezes it.
        css({ flexShrink: 0, whiteSpace: "nowrap" }),
        iconOnly
          ? css({ padding: "0.4rem" })
          : css({ fontSize: "0.7rem", padding: "0.33rem 0.6rem" }),
        copied ? css({ color: "primary", borderColor: "primary" }) : undefined,
        className,
      )}
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      }}
    >
      <Icon name={copied ? "check" : "clipboard"} size={iconOnly ? "0.95rem" : "0.9em"} />
      {!iconOnly && (copied ? "Copied" : "Copy")}
    </Button>
  );
}

// A code block for machine-readable values (DNS records, keys): recessed
// near-black ground, wrapped mono text, icon-only copy floating top-right —
// unmistakably "this is the exact string to paste".
export function CodeBlock({ children, compact }: { children: string; compact?: boolean }) {
  return (
    <div className={css({ position: "relative" })}>
      <pre
        className={cx(
          css({
            margin: 0,
            backgroundColor: "bgDeep",
            border: "1px solid token(colors.border)",
            borderRadius: "0.25rem",
            // Right padding keeps the first lines clear of the copy button.
            padding: "1rem 3rem 1rem 1.2rem",
          }),
          compact ? css({ padding: "0.55rem 2.6rem 0.55rem 0.9rem" }) : undefined,
        )}
      >
        <code
          className={css({
            fontFamily: "mono",
            fontSize: "0.85rem",
            lineHeight: "1.55",
            color: "text",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          })}
        >
          {children}
        </code>
      </pre>
      <CopyButton
        text={children}
        iconOnly
        className={cx(
          css({ position: "absolute", right: "0.5rem", backgroundColor: "bgDeep" }),
          compact ? css({ top: "0.25rem", padding: "0.3rem" }) : css({ top: "0.5rem" }),
        )}
      />
    </div>
  );
}

// ── Key/value table (the legacy ul.keyValue, as a semantic <dl>) ─────────────

export function KeyValue({ children }: { children: ReactNode }) {
  return <dl className={css({ margin: "2rem 0 3rem 0" })}>{children}</dl>;
}

const kvRow = css({
  display: "flex",
  alignItems: "flex-start",
  backgroundColor: "surface",
  // Color inside the shorthand: a separate borderColor utility can be emitted
  // before the shorthand, whose implied color (currentColor) would then win.
  borderBottom: "1px solid token(colors.border)",
  padding: "2rem 0.5rem 2rem 0.1rem",
  fontSize: "1rem",
  lineHeight: "1.4rem",
  // Phones: keys stack above values instead of squeezing them into 60%.
  "@media (max-width: 480px)": { flexDirection: "column", gap: "0.4rem", padding: "1.2rem 1rem" },
});
const kvKey = css({
  flex: "0 0 20%",
  minWidth: "10rem",
  marginRight: "1.5rem",
  paddingLeft: "1rem",
  textAlign: "right",
  color: "primary",
  fontFamily: "mono",
  "@media (max-width: 650px)": { minWidth: "6rem" },
  "@media (max-width: 480px)": {
    flexBasis: "auto",
    minWidth: 0,
    marginRight: 0,
    paddingLeft: 0,
    textAlign: "left",
    fontSize: "0.85rem",
  },
});
const kvValue = css({
  flex: "0 1 80%",
  margin: 0,
  color: "text",
  fontFamily: "mono",
  wordBreak: "break-word",
  "@media (max-width: 480px)": { flexBasis: "auto" },
});

export function KV({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className={kvRow}>
      <dt className={kvKey}>{k}</dt>
      <dd className={kvValue}>{children}</dd>
    </div>
  );
}

// A KeyValue row whose value is a Switch — state shown, not inferred from a
// verb button. Same visual grammar as KV with room for the control + fine
// print (e.g. domain catch-all, mailbox default/trash).
const kvSwitchRow = css({
  display: "flex",
  alignItems: "flex-start",
  backgroundColor: "surface",
  borderBottom: "1px solid token(colors.border)",
  padding: "1.4rem 0.5rem 1.4rem 0.1rem",
  "@media (max-width: 480px)": { flexDirection: "column", gap: "0.4rem", padding: "1.2rem 1rem" },
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
  "@media (max-width: 480px)": {
    flexBasis: "auto",
    minWidth: 0,
    marginRight: 0,
    paddingLeft: 0,
    paddingTop: 0,
    textAlign: "left",
    fontSize: "0.85rem",
  },
});
const kvSwitchValue = css({
  flex: "0 1 80%",
  margin: 0,
  display: "flex",
  alignItems: "center",
  gap: "1rem",
  flexWrap: "wrap",
  "@media (max-width: 480px)": { flexBasis: "auto" },
});

export function KVSwitch({
  k,
  checked,
  onChange,
  disabled,
  label,
  hint,
}: {
  /** Row key. A non-string key (e.g. <EmailBreak>) requires `label`. */
  k: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  /** Accessible name for the switch (defaults to the row key when a string). */
  label?: string;
  hint?: ReactNode;
}) {
  const name = label ?? (typeof k === "string" ? k : "");
  return (
    <div className={kvSwitchRow}>
      <dt className={kvSwitchKey}>{k}</dt>
      <dd className={kvSwitchValue}>
        <Switch checked={checked} onChange={onChange} disabled={disabled} label={name} />
        {hint && <span className={ui.finePrint}>{hint}</span>}
      </dd>
    </div>
  );
}

// An action row: no key, an amber "»" link as the value (legacy li.action).
export function KVAction({ children }: { children: ReactNode }) {
  return (
    <div
      className={cx(
        kvRow,
        css({
          backgroundColor: "transparent",
          border: "none",
          padding: "0.5rem 0.5rem 0.5rem 0.1rem",
        }),
      )}
    >
      <dt
        className={cx(kvKey, css({ flexBasis: "0%", minWidth: "2rem", margin: 0, padding: 0 }))}
      />
      <dd className={kvValue}>{children}</dd>
    </div>
  );
}

// ── Entity list (the legacy ol.entities / virtuals rows) ─────────────────────

export function EntityList({ children }: { children: ReactNode }) {
  return (
    <ol
      className={css({
        listStyle: "none",
        margin: 0,
        padding: 0,
        "@media (max-width: 650px)": { marginLeft: "-1.12rem", marginRight: "-1.12rem" },
      })}
    >
      {children}
    </ol>
  );
}

const entityRow = css({
  display: "flex",
  justifyContent: "space-between",
  alignItems: "stretch",
  backgroundColor: "surface",
  // See kvRow: keep the color inside the shorthand.
  borderBottom: "1px solid token(colors.border)",
});
const entityBody = css({
  display: "block",
  flex: "1 1 80%",
  minWidth: 0,
  textAlign: "left",
  textDecoration: "none",
  padding: "2rem 0.5rem 2rem 2rem",
  "@media (max-width: 384px)": { paddingLeft: "1rem" },
});
const entityTitle = css({
  display: "block",
  maxWidth: "100%",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: "primary",
  fontFamily: "mono",
  fontSize: "1rem",
  lineHeight: "1.4rem",
});
const entityDetail = css({
  marginTop: "0.8rem",
  color: "textDim",
  fontSize: "0.9rem",
  lineHeight: "1.3rem",
  overflowWrap: "anywhere",
});
const entityMeta = css({
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  gap: "0.9rem",
  flexShrink: 0,
  paddingRight: "2rem",
  "@media (max-width: 384px)": { paddingRight: "1rem" },
});
// Rows whose controls also live on a detail page hide them on small screens
// (tap the row instead). "xs" ≈ phones, "md" ≈ anything below the desktop nav.
const entityMetaHide = {
  xs: css({ "@media (max-width: 480px)": { display: "none" } }),
  md: css({ "@media (max-width: 900px)": { display: "none" } }),
};

export function EntityRow({
  title,
  detail,
  meta,
  hideMetaBelow,
  to,
  params,
}: {
  title: ReactNode;
  detail?: ReactNode;
  meta?: ReactNode;
  /** Hide the meta controls below this breakpoint (the row link remains). */
  hideMetaBelow?: keyof typeof entityMetaHide;
  to?: LinkProps["to"];
  params?: LinkProps["params"];
}) {
  const body = (
    <>
      <span className={entityTitle}>{title}</span>
      {detail != null && <span className={entityDetail}>{detail}</span>}
    </>
  );
  return (
    <li className={entityRow}>
      {to ? (
        <Link to={to} params={params} className={entityBody}>
          {body}
        </Link>
      ) : (
        <div className={entityBody}>{body}</div>
      )}
      {meta != null && (
        <div className={cx(entityMeta, hideMetaBelow ? entityMetaHide[hideMetaBelow] : undefined)}>
          {meta}
        </div>
      )}
    </li>
  );
}

// ── Alerts (outline in the alert color; page bg + normal text inside) ────────

const alertBase = css({
  padding: "1.4rem",
  margin: "2rem 0",
  borderRadius: "0.5rem",
  borderWidth: "0.2rem",
  borderStyle: "solid",
  backgroundColor: "transparent",
  color: "text",
  fontSize: "0.94rem",
  lineHeight: "1.4rem",
});

export function Alert({
  kind = "error",
  children,
  className,
}: {
  kind?: "error" | "success";
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cx(
        alertBase,
        kind === "error" ? css({ borderColor: "accent" }) : css({ borderColor: "primary" }),
        className,
      )}
    >
      {children}
    </div>
  );
}

// ── Page scaffolding ─────────────────────────────────────────────────────────
// Two legacy page shapes: full-width (hero header, centered) and narrow
// (29.5rem column, left-aligned headings).

export function Section({ narrow, children }: { narrow?: boolean; children: ReactNode }) {
  return (
    <section
      className={cx(
        css({
          marginTop: "4.2rem",
          "@media (max-width: 650px)": {
            marginTop: 0,
            padding: "1.12rem 1.12rem 0 1.12rem",
          },
        }),
        narrow &&
          css({
            maxWidth: "29.5rem",
            marginLeft: "auto",
            marginRight: "auto",
            "@media (max-width: 650px)": { padding: "2rem" },
          }),
      )}
    >
      {children}
    </section>
  );
}

// Centered hero header for full-width pages.
export function Hero({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <header
      className={css({
        textAlign: "center",
        padding: "0 2rem",
        marginBottom: "4rem",
        "@media (max-width: 650px)": { marginBottom: "2rem", padding: 0 },
      })}
    >
      <h1 className={cx(ui.h1, css({ marginBottom: "1rem" }))}>{title}</h1>
      {children}
    </header>
  );
}

// ── Shared class helpers ─────────────────────────────────────────────────────

export const ui = {
  h1: css({
    fontFamily: "sans",
    fontSize: "2rem",
    fontWeight: "bold",
    letterSpacing: "0.025em",
    lineHeight: "1.08em",
    color: "heading",
    overflowWrap: "anywhere",
  }),
  h2: css({
    fontFamily: "sans",
    fontSize: "1.5rem",
    fontWeight: "bold",
    lineHeight: "1.2em",
    color: "heading",
  }),
  lead: css({ fontSize: "1rem", lineHeight: "1.4rem", marginBottom: "1rem" }),
  link: css({
    color: "accent",
    textDecoration: "none",
    cursor: "pointer",
    background: "none",
    border: "none",
    padding: 0,
    font: "inherit",
    _hover: { color: "accentHover" },
  }),
  mono: css({ fontFamily: "mono" }),
  dim: css({ color: "textDim" }),
  finePrint: css({ lineHeight: "1.3em", opacity: 0.75, fontSize: "0.9rem", color: "label" }),
  actionsCenter: css({
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "1rem",
    flexWrap: "wrap",
  }),
};

// Break long addresses before the @ like the legacy pages did with <wbr>.
export function EmailBreak({ email }: { email: string }) {
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

// Centered checklist rows with teal check icons (legacy ul.checklist).
export function Checklist({ items }: { items: ReactNode[] }) {
  return (
    <ul
      className={css({
        listStyle: "none",
        margin: "0 auto 2rem auto",
        padding: 0,
        maxWidth: "29.5rem",
        textAlign: "left",
      })}
    >
      {items.map((item, i) => (
        <li
          key={i}
          className={css({
            display: "flex",
            alignItems: "flex-start",
            gap: "0.6rem",
            marginBottom: "0.6rem",
            lineHeight: "1.4rem",
          })}
        >
          <span className={css({ color: "primary", marginTop: "0.15rem" })}>
            <Icon name="check" size="1.1rem" />
          </span>
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}
