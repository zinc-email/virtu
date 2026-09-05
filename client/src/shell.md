# The shell bridge protocol (v1)

How the web app and the shells that host it — the native mobile apps
(iOS/Android, `plans/mobile.md`) and the browser extension's popup
(`extension/`) — talk to each other. This doc and `shell.ts` beside it are one
unit: a change to either is a change to both, in the same review. The
vocabulary is deliberately small and enumerable — adding a message is a
protocol change, reviewed like a schema change (PLAN.md decision #7: never a
generic eval channel).

## How a shell announces itself

A shell injects a `window.virtuShell` object at **document start** (before any
page script runs). Plain browsers never have it; every web-side helper in
`shell.ts` feature-detects it and falls back to normal web behavior. The object
carries three static facts, one optional fact, and one function:

- `platform` — `"ios"`, `"android"`, or `"extension"`.
- `shellVersion` — the native app's (or extension's) version string, for
  diagnostics.
- `protocol` — the integer protocol version the shell implements (currently 1).
  A shell declaring version N implements **every** message of version N.
- `apiOrigin` (optional) — the absolute origin the API lives on, declared only
  by a shell that serves the app from somewhere other than the web origin.
  The webviews load the production URL and leave it unset; the extension
  packages the built SPA inside itself (`chrome-extension://…`), where the
  SDK's relative `/api` would point nowhere, so it declares the deployment it
  was built for. The extension is also the one shell where the platform
  changes routing: the popup is a file, so the app routes by hash there
  (`isExtension()` in `shell.ts`, used by `app.tsx` and `api/client.ts`).
- `request(message)` — send one JSON-encoded message; resolves with one
  JSON-encoded reply. Always resolves (errors come back as error replies, see
  below); rejection means the bridge itself is broken.

On iOS the shell backs `request` with a promise-returning script message
handler (`WKScriptMessageHandlerWithReply`). On Android the injected shim wraps
the origin-allowlisted `WebMessageListener` port and correlates replies to
requests by an internal id — the web app never sees that plumbing, only the
uniform `request` function. In the extension the shim is a plain script the
build injects into the popup's `<head>` ahead of the app bundles, and it
answers in-process from the extension APIs.

## Messages

Every message is a JSON object with a `type` field plus the fields listed.
Every reply is a JSON object with `ok: true` or `ok: false, error: "<slug>"`.

**`apiKey.store`** — sent right after login succeeds. Carries `key`, the
long-lived API key the SPA just received. The shell stores it in the iOS
Keychain (shared access-group, so the share/autofill extensions can read it),
Android Keystore-encrypted storage, or the browser extension's
`chrome.storage.local` (so the content script's alias menu can call the API
through the background worker). Also the shell's cue that a user is logged in.

**`apiKey.clear`** — sent on logout and on the 401 bounce. No fields. The
shell wipes the stored key; extensions lose API access with it.

**`share`** — present the native share sheet. Optional `title`, `text`, `url`
(at least one of `text`/`url` present). Replies `ok: true` once the sheet was
presented; the protocol does not report whether the user completed or canceled
the share (iOS reports it, Android can't — we keep the contract to the common
denominator). The extension has no sheet of its own: it uses the Web Share
API where the desktop browser offers one and replies `failed` where it
doesn't, so the app keeps its copy-to-clipboard UI there.

**`external.open`** — open `url` (http/https only) outside the app: Safari /
the default browser. Used for links that must not navigate the webview, e.g.
links inside displayed email content or docs links.

Reserved for later protocol versions, so the names are settled now:
`push.register` (request notification permission, reply with the device
token) and `purchase` (native IAP, only if we ever adopt it — see
`plans/mobile.md`, billing).

## Error replies

`ok: false` with a short slug in `error`: a shell replies `unknown-message`
for a `type` it doesn't implement (forward compatibility: an older shell must
not crash on a newer web app), `bad-payload` for missing/invalid fields, and
`failed` for a native-side failure. The web side treats every error reply as
"the capability isn't available" and uses its web fallback — it never surfaces
bridge errors to the user.

## Versioning

`protocol` bumps only when a message's shape or meaning changes, or a new
message becomes load-bearing. The web app must keep working against older
shells (users update apps late): feature-detect via `protocol` when using a
newer message, and tolerate `unknown-message`.

## Web-side fallbacks (implemented in `shell.ts`)

- `share` → Web Share API where available, otherwise the caller keeps its
  copy-to-clipboard UI.
- `external.open` → `window.open(url, "_blank", "noopener")` (http/https
  enforced on the web side too, so other schemes are inert everywhere).
- `apiKey.*` → no-ops in a plain browser (localStorage already holds the key).

The seam also guards the "always resolves" rule from the other side: a reply
that never arrives times out after 10s and is treated like any error reply —
capability unavailable, use the web fallback. Shells must still reply to
every request (including ones sent from same-origin subframes); the timeout
is a web-side safety net, not license to drop messages.

## Known in-shell gaps (shell implementers, take note)

- `window.open` of a **blob URL** (the BIND zone-file viewer on the domain
  detail page) can't be handed to a system browser — blob URLs don't cross the
  process boundary. The shells' new-window handler should load same-origin and
  blob URLs in the webview (or a pushed native web screen) and reserve
  `external.open` semantics for real external hosts.
- Links inside rendered email bodies must go through `external.open`, never
  navigate the shell's webview.
