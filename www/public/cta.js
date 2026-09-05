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
  try {
    if (!localStorage.getItem("virtu.apiKey")) return;
  } catch {
    return; // storage blocked (privacy mode) — keep the login form
  }
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
  form.classList.add("hasAccount"); // spacing for the signed-in hero (global.scss)
})();
