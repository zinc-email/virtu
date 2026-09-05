// Logged-in variant of the homepage CTA (components/CtaForm.astro loads this
// right after each form). An external file, not an inline <script>: the
// production Caddyfile's Content-Security-Policy is `script-src 'self'`, so
// inline scripts never run there. A classic script with src is still
// parse-blocking (no logged-out flash) and still has document.currentScript.
//
// The homepage shares an origin with the SPA (Caddy mounts it at /app), so
// the API key the SPA keeps in localStorage (client/src/auth.ts) is readable
// here. Presence ≈ logged in: if the key was revoked, /app/ just bounces to
// the login page.
(() => {
  let key;
  try {
    key = localStorage.getItem("virtu.apiKey");
  } catch {
    return; // storage blocked (privacy mode) — keep the login form
  }
  if (!key) return;
  // Keep the <form> in place (page CSS hooks layout on it, e.g.
  // section#hello form { text-align: center }): hide the email field and
  // swap only the button for a link into the app. style.display, not
  // [hidden] — the .field display:block would override the attribute.
  const form = document.currentScript.previousElementSibling;
  form.querySelector("input[type=email]").closest(".field").style.display = "none";
  const link = document.createElement("a");
  link.className = "button submit";
  link.href = "/app/";
  link.textContent = "Protect My Inbox";
  form.querySelector("button.submit").replaceWith(link);
  // Fine print under the button, so the changed CTA explains itself — with
  // the way out, since this is the only place a signed-in visitor sees the
  // marketing site. Logging out revokes the key server-side (GET /api/logout,
  // routes/account.ts) the way the app's own footer does, then reloads into
  // the logged-out form.
  const note = document.createElement("div");
  note.className = "note";
  note.append("You are logged in. ");
  const out = document.createElement("button");
  out.type = "button";
  out.textContent = "Log out?";
  out.addEventListener("click", async () => {
    out.disabled = true;
    try {
      await fetch("/api/logout", { headers: { Authentication: key } });
    } catch {
      // network down or key already dead — the local logout still stands
    }
    try {
      localStorage.removeItem("virtu.apiKey");
    } catch {
      // unreachable: we only got here because reading it worked
    }
    location.reload();
  });
  note.append(out);
  link.after(note);
  form.classList.add("hasAccount"); // spacing for the signed-in hero (global.scss)
})();
