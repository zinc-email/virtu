// Login page ("/login") — the app's ONLY auth surface, and essentially the
// legacy 401 error page (tmp/virtu views/errors/401.php): one email field
// serves login AND signup, since the passwordless flow makes them the same
// thing. Phase "email" requests a code (POST /auth/login — creates a
// provisional account server-side when the address is new); phase "code"
// verifies it (POST /auth/verify) and stores the minted api_key. The router
// guard bounces unauthenticated visits here with ?redirect=, and the www
// homepage CTA arrives with ?email= (auto-submitted, so the visitor lands
// straight on the code step, exactly like the legacy flow).

import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { css, cx } from "styled-system/css";
import { apiErrorMessage } from "src/api/errors";
import { setApiKey } from "src/auth";
import { usePostAuthLogin, usePostAuthVerify } from "src/gen";
import { Alert, Button, Field, PinInput, Section, ui } from "src/ui";
import { useHead } from "src/head";

// Mirror the server's cheap guard (auth.ts) so obvious mistakes don't cost a
// round trip. The real validation still lives on the server.
function looksLikeEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Resend cooldown, purely a UX affordance: the server enforces the real
// budget (3 login emails per address per hour → 429). This just spaces the
// clicks and makes "you can't resend yet" visible instead of surprising.
const RESEND_COOLDOWN_S = 60;

// An invite-only deployment answers /auth/verify with 403 when a NEW email
// verifies without a valid invite (never before code proof, so the flow
// stays enumeration-safe — see server routes/auth.ts).
function isInviteRequired(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === "object" &&
    "response" in err &&
    err.response !== null &&
    typeof err.response === "object" &&
    "status" in err.response &&
    err.response.status === 403
  );
}

export function LoginPage() {
  useHead({ title: "Log in" });
  const navigate = useNavigate();
  const search = useSearch({ from: "/login" });
  const [phase, setPhase] = useState<"email" | "code">("email");
  // The homepage CTA (www CtaForm) submits GET /app/login?email=…; prefill it.
  const [email, setEmail] = useState(search.email ?? "");
  const [code, setCode] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const [invite, setInvite] = useState("");
  const [inviteNeeded, setInviteNeeded] = useState(false);

  useEffect(() => {
    if (cooldown === 0) return;
    const id = setTimeout(() => setCooldown(cooldown - 1), 1000);
    return () => clearTimeout(id);
  }, [cooldown]);

  const request = usePostAuthLogin({
    mutation: {
      onSuccess: () => {
        setPhase("code");
        setCooldown(RESEND_COOLDOWN_S);
      },
    },
  });

  const verify = usePostAuthVerify({
    mutation: {
      onSuccess: (data) => {
        if (data.api_key) {
          setApiKey(data.api_key);
          // A guarded page sent us here; go back to it. The href includes the
          // /app basepath, so a hard navigation avoids double-prefixing.
          if (search.redirect) window.location.assign(search.redirect);
          else void navigate({ to: "/" });
        }
      },
      onError: (err) => {
        if (isInviteRequired(err)) {
          // The 403 spent the login code (server design — the gate answers
          // only after code proof). Surface the invite field and unlock the
          // resend button so the retry isn't stuck behind the cooldown.
          setInviteNeeded(true);
          setCode("");
          setCooldown(0);
        }
      },
    },
  });

  const emailValid = looksLikeEmail(email.trim());

  const submitEmail = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!emailValid || request.isPending) return;
    setCode("");
    verify.reset();
    request.mutate({ data: { email: email.trim(), device: "virtu-web" } });
  };

  // Arriving from the homepage form with a valid email: request the code
  // immediately, like the legacy flow (the www submit WAS the first step).
  const autoSubmitted = useRef(false);
  useEffect(() => {
    if (autoSubmitted.current) return;
    autoSubmitted.current = true;
    if (search.email && looksLikeEmail(search.email.trim())) submitEmail();
  });

  const submitCode = (value: string) => {
    if (value.length !== 6 || verify.isPending) return;
    verify.mutate({
      data: {
        email: email.trim(),
        code: value,
        device: "virtu-web",
        invite: invite.trim() === "" ? undefined : invite.trim(),
      },
    });
  };

  const changeEmail = () => {
    setPhase("email");
    setCode("");
    setInvite("");
    setInviteNeeded(false);
    request.reset();
    verify.reset();
  };

  // The bounce reasons: a guarded page redirected here, or the stored key
  // died mid-session (api/client.ts appends ?reason=expired).
  const bounced = Boolean(search.redirect) || search.reason === "expired";

  return (
    <Section narrow>
      {phase === "email" ? (
        <form onSubmit={submitEmail}>
          <header className={css({ textAlign: "center", marginBottom: "2.5rem" })}>
            <h1 className={ui.h1}>{bounced ? "Please log-in first." : "Log-in or sign-up."}</h1>
            {bounced && (
              <p className={cx(ui.lead, ui.dim, css({ marginTop: "1rem" }))}>
                We want to take you to that page, but you must log-in first. Use the form below to
                log-in.
              </p>
            )}
          </header>

          {search.reason === "expired" && !request.isError && (
            <Alert>Your session expired. Please log-in again.</Alert>
          )}
          {request.isError && <Alert>{apiErrorMessage(request.error)}</Alert>}

          <Field
            label="Email"
            name="email"
            type="email"
            placeholder="yourname@gmail.com"
            value={email}
            onChange={(e) => setEmail(e.currentTarget.value)}
            hint={
              bounced
                ? "Enter your e-mail address to receive a log-in confirmation email."
                : "Enter your e-mail address to login or signup."
            }
            autoFocus
            required
          />

          <div className={css({ marginTop: "2.42rem" })}>
            <Button
              type="submit"
              variant="submit"
              loading={request.isPending}
              disabled={!emailValid}
              className={css({ width: "100%" })}
            >
              Continue
            </Button>
          </div>

          <div
            className={css({
              marginTop: "3rem",
              paddingTop: "1.6rem",
              borderTop: "1px solid token(colors.border)",
              color: "textDim",
              fontSize: "0.9rem",
            })}
          >
            <h3 className={css({ fontSize: "1rem", marginBottom: "0.6rem" })}>Want more info?</h3>
            <p>
              Zinc protects your inbox by empowering you to send and receive email without ever
              sharing your real email address.
            </p>
            <p className={css({ marginTop: "0.6rem" })}>
              <a href="/how" className={ui.link}>
                Learn how it works
              </a>
              .
            </p>
          </div>
        </form>
      ) : (
        <div className={css({ textAlign: "center" })}>
          <header className={css({ marginBottom: "2rem" })}>
            <h1 className={ui.h1}>Check your e-mail</h1>
            <p className={cx(ui.lead, ui.dim, css({ marginTop: "1rem" }))}>
              We sent a confirmation email to <strong>{email.trim()}</strong>. Please enter the code
              in that email to prove it's you. It expires in 15 minutes.
            </p>
          </header>

          {/* The first invite-403 is explained by the invite panel below;
              the server message only adds signal once an invite was tried
              (wrong/used/expired code). */}
          {verify.isError && (!isInviteRequired(verify.error) || invite.trim() !== "") && (
            <Alert>{apiErrorMessage(verify.error)}</Alert>
          )}
          {request.isSuccess &&
            !verify.isError &&
            !verify.isSuccess &&
            !inviteNeeded &&
            code === "" && <Alert kind="success">A log-in code is on its way.</Alert>}

          {inviteNeeded && (
            <div className={css({ textAlign: "left", marginBottom: "1.6rem" })}>
              <Alert>
                Sign-ups are currently invite-only, and verifying used up your log-in code. Enter
                your invite code here, press &ldquo;Resend code&rdquo; below for a fresh log-in
                code, then enter that code.
              </Alert>
              <Field
                label="Invite code"
                name="invite"
                placeholder="your invite code"
                value={invite}
                onChange={(e) => {
                  setInvite(e.currentTarget.value);
                  if (verify.isError) verify.reset();
                }}
              />
            </div>
          )}

          <div className={css({ display: "flex", justifyContent: "center", marginBottom: "2rem" })}>
            <PinInput
              length={6}
              autoFocus
              value={code}
              onChange={(v) => {
                setCode(v);
                if (verify.isError) verify.reset();
              }}
              onComplete={submitCode}
              label="Login code"
              disabled={verify.isPending}
            />
          </div>

          <Button
            variant="submit"
            onClick={() => submitCode(code)}
            loading={verify.isPending}
            disabled={code.length !== 6}
            className={css({ width: "100%" })}
          >
            Verify My Identity
          </Button>

          <div
            className={css({
              display: "flex",
              justifyContent: "space-between",
              marginTop: "1.6rem",
              fontSize: "0.9rem",
            })}
          >
            <button
              type="button"
              className={cx(ui.link, css({ color: "textDim", _hover: { color: "navLink" } }))}
              onClick={changeEmail}
            >
              Use a different email
            </button>
            <button
              type="button"
              className={cx(ui.link, css({ _disabled: { color: "textDim", cursor: "default" } }))}
              onClick={() => submitEmail()}
              disabled={request.isPending || cooldown > 0}
            >
              {request.isPending
                ? "Resending…"
                : cooldown > 0
                  ? `Resend code (${cooldown}s)`
                  : "Resend code"}
            </button>
          </div>
        </div>
      )}
    </Section>
  );
}
