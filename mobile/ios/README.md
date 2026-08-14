# virtu iOS shell

The iOS companion app (`plans/mobile.md`, Track B): a WKWebView on the
deployed `/app` SPA plus the native capabilities a browser tab can't provide.
The product UI is 100% the web app — this project is glue, and should stay
around a thousand lines.

Not a Bun package; a self-contained Xcode project defined by **`project.yml`**
(XcodeGen) — the `.xcodeproj` is generated, gitignored, and never edited by
hand.

## What implements what

| Piece | File | Contract |
|---|---|---|
| Bridge message layer (parse/reply, pure Swift) | `Virtu/ShellProtocol.swift` | `client/src/shell.md` (protocol v1) |
| Bridge WebKit glue (`WKScriptMessageHandlerWithReply`, share sheet, external open) | `ShellBridge.swift` | same |
| `window.virtuShell` shim, document-start WKUserScript | `Virtu/Resources/shell-bridge.js` | same |
| API key at rest (Keychain, shared access group for Tracks D/G) | `KeychainStore.swift` | plans/mobile.md, Auth |
| WebView host: offline screen, link routing, child windows, in-webview login | `ShellViewController.swift` | plans/mobile.md, platform gotchas |

Protocol notes specific to this shell:

- **No id envelope.** `webkit.messageHandlers.virtuShell.postMessage(...)`
  returns a promise that resolves with the handler's reply
  (`WKScriptMessageHandlerWithReply`), so the shim is ~10 lines and the
  Android-style id correlation doesn't exist here.
- The handler is registered in the **page** content world so the SPA can call
  it; the shim is main-frame-only (subframes behave as plain web — the
  degradation shell.md allows).
- The localStorage healing script (re-seed `virtu.apiKey` from the Keychain at
  document start — WKWebView storage has documented flakiness across
  suspensions) is re-registered on every `apiKey.store`/`apiKey.clear`.
- `window.open`/blob URLs (the SPA's zone-file viewer) open in an in-app child
  WKWebView created with the configuration WebKit hands us — same browsing
  context, so blob URLs resolve. External hosts divert to Safari; link
  navigations may only leave the app via http/https/mailto/tel (bridge
  parity — no app-scheme escapes from web content).
- `share`'s `title` is passed as an activity item; completion/cancel is
  deliberately unreported (protocol keeps to the common denominator).

## Build & run (needs a Mac)

```sh
brew install xcodegen
cd mobile/ios
xcodegen generate      # project.yml → Virtu.xcodeproj (gitignored)
open Virtu.xcodeproj
```

- **Debug** fronts `http://localhost:8080` — run `just up` on the same
  machine; the simulator reaches the host's localhost directly. (ATS is
  relaxed for local networking only.)
- **Release** fronts `https://zinc.email`. Staging: change
  `VIRTU_WEB_ORIGIN` for the Release config (or add an `Lmnop` config) in
  project.yml and regenerate.
- Tests: `⌘U`, or
  `xcodebuild test -scheme Virtu -destination 'platform=iOS Simulator,name=iPhone 16'`.
- Signing: set your team in Xcode once; the Keychain access group entitlement
  (`$(AppIdentifierPrefix)email.zinc.virtu.shared`) resolves per-team.

No Mac at all? The bridge's web-facing half is still testable:
`bun test mobile` (repo root) drives the real `client/src/shell.ts` seam
through this shim AND the Android one — `just test-contract`, also in
`just check`/CI.

### First-run verification checklist (needs a simulator/device)

1. Login stays inside the webview (never bounces to Safari) and the app is
   usable after relaunch.
2. `window.virtuShell` exists at first paint (Billing hides purchase UI
   **and shows no visit-the-web wording on iOS** — the anti-steering split;
   `plans/mobile.md`, Billing).
3. Share an alias → native sheet appears (iPad too — popover anchor).
4. Airplane mode + relaunch → native offline screen, Retry recovers; rapid
   link clicks mid-load must NOT flash it.
5. Domain detail → zone-file viewer (blob URL) opens in the child sheet.
6. Delete website data (Settings → Safari won't do it for WKWebView; use a
   dev build hook or reinstall keeping Keychain) → relaunch stays logged in
   (healing script).
7. Keychain: the stored item is in the shared access group (needed before
   Tracks D/G).

## Release

- `PRODUCT_BUNDLE_IDENTIFIER` (`email.zinc.virtu`) is **permanent** once
  uploaded to App Store Connect; the store name/branding is still an open
  question in plans/mobile.md — settle both before creating the app record.
- Submissions must be built with the current-year Xcode/SDK floor (mandatory
  every spring — plans/mobile.md, maintenance budget).
- `PrivacyInfo.xcprivacy` is committed (no tracking, no required-reason
  APIs); the nutrition label is filled in App Store Connect (Track I).
- Account deletion must be reachable in-app by submission time (web settings
  UI — Apple 5.1.1(v)).

## What's next here (other tracks)

- **Track D** — share extension (receive from the share sheet, mint-and-copy
  inside the extension; extensions cannot reliably open the containing app,
  so the flow must complete in-extension). Add an app-extension target to
  project.yml; reads the key via `KeychainStore` from the shared group.
- **Track G** — credential provider (the Proton Pass pattern): mints mid-fill
  from the QuickType flow; same shared-group Keychain read.
- **Track H** — push (APNs); the `push.register` bridge message name is
  already reserved in shell.md.
