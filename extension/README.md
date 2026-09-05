# Zinc browser extension

The Chrome/Firefox extension (Manifest V3). Three pieces:

| Piece | File | Contract |
|---|---|---|
| Toolbar popup: the **built client SPA**, packaged at `build/app/` | `bin/extension-build` copies `client/dist` in | the app's own routes |
| `window.virtuShell` shim for the popup (API key → `chrome.storage.local`, external links → new tab, share) | `src/popup-shell.ts` | `client/src/shell.md` (protocol v1) |
| Alias menu on email fields: the [Z] button, "New alias for this site", the right-click items | `src/content.ts` + `src/content.css` | `server/spec/openapi.json` (`/v2/aliases`, `/v5/alias/options`, `/alias/random/new`) |
| API relay + context menus (the content script can't call the API itself) | `src/background.ts`, `src/api.ts`, `src/messages.ts` | — |
| Bridge contract test: the real client seam driven through the real shim | `contract/shim.contract.test.ts` | `just test-contract` |

The product UI is 100% the web app, exactly like the mobile shells
(`plans/mobile.md`): the popup is `client/dist` verbatim, so there is one
client build for the site, the webviews, and the extension. What differs
inside the popup is decided at runtime from the shim (`isExtension()` in
`client/src/shell.ts`): the router uses **hash history** with no basepath
(the popup is a file, `app/index.html`, not a path the router owns), and the
SDK's relative `/api` is prefixed with the shell-declared `apiOrigin`.

A separate Bun package with its own `package.json` (the repo's no-workspaces
rule); the only coupling to `client/` is the build copying its `dist/`, and
the contract test importing the seam — the same coupling the mobile
contract tests have.

## Build

```sh
just extension-build                 # → extension/build/, against https://zinc.email
VIRTU_ORIGIN=http://localhost:8080 just extension-build   # against the dev stack (just up)
just extension-pack                  # → extension/dist/zinc-extension-<version>.zip
```

`bin/extension-build` builds the client first (`cd client && bun run build`);
pass `--no-client-build` to reuse the existing `client/dist`. `VIRTU_ORIGIN`
is the deployment the build talks to: it becomes the API origin inside the
scripts and the manifest's single host permission. One build targets one
deployment — zinc, lmnop, or a local stack.

## Load unpacked in Chrome

1. `just extension-build` (or the `VIRTU_ORIGIN=…` form).
2. Open `chrome://extensions`, turn on **Developer mode** (top right).
3. **Load unpacked** → pick the `extension/build/` directory.
4. Pin the Zinc icon from the puzzle-piece menu. Click it: the popup is the
   app; sign in there (the extension keeps its own login, separate from the
   website's — see below).
5. After a rebuild, press the ↻ reload button on the extension's card;
   the popup and the worker pick up the new files, and already-open tabs
   need a reload to get the new content script.

The worker's console lives behind the card's **service worker** link; the
content script logs into the page's own devtools console; the popup's
devtools open by right-clicking inside the popup → Inspect.

Against the dev stack, build with `VIRTU_ORIGIN=http://localhost:8080` and
have `just up` running — the popup's requests go to the Caddy dev proxy.

## Login, and where the key lives

The popup is its own origin (`chrome-extension://<id>`), so its localStorage
is not the website's: the user signs in once inside the popup (the same
emailed-code flow). On success the SPA hands the key to the shim
(`apiKey.store`), which stores it in `chrome.storage.local`, where the
background worker reads it for the content script's calls. Logout / the 401
bounce clear both copies. If the popup's localStorage is wiped ("clear
browsing data") while `chrome.storage.local` still holds the key, the shim
re-seeds it on the next open — the same healing the Android shell does from
the Keystore.

The emailed code: switching to a mail client closes the popup and its
form state with it. Reopen the popup and request the code again, or open the
app in a tab (`chrome-extension://<id>/app/index.html`) to log in there —
same origin, same storage, the popup sees the key. Persisting the pending
login across popup opens is a possible follow-up.

## Firefox

The manifest carries both `background.service_worker` (Chrome) and
`background.scripts` (Firefox, which has no worker backgrounds) plus the
add-on id under `browser_specific_settings.gecko`. Firefox treats MV3 host
permissions as optional: the user grants site access from the extension's
toolbar menu. Distribution is by AMO signing (`web-ext sign` on the zip from
`bin/extension-pack`); not wired up here yet.

## Notes

- Content-script requests to the API can't be made from the page's origin
  (MV3 host permissions don't cover content scripts), hence the relay through
  the background worker (`messages.ts`).
- Aliases minted from the menu are random aliases (`/alias/random/new`,
  honoring the user's alias-generator setting) created with
  `?hostname=` — so they show as "used on" this site — and a
  `Used on <hostname>` note, which is what the menu's list query matches.
  The `/v5/alias/options` recommendation (latest alias used here) is listed
  first regardless of how it was created.
- Field detection is the legacy heuristic: `type=email`, or a text input
  whose name/id/placeholder/class/title/autocomplete mentions email, login,
  or username. The right-click menu works on any editable field.
