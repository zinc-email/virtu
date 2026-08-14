# virtu Android shell

The Android companion app (`plans/mobile.md`, Track C): a WebView on the
deployed `/app` SPA plus the native capabilities a browser tab can't provide.
The product UI is 100% the web app — this project is glue, and should stay
around a thousand lines.

Not a Bun package; a self-contained Gradle project (the repo's no-workspaces
rule isn't implicated).

## What implements what

| Piece | File | Contract |
|---|---|---|
| Bridge message layer (parse/reply, pure JVM) | `app/src/main/java/email/zinc/virtu/ShellProtocol.kt` | `client/src/shell.md` (protocol v1) |
| Bridge Android glue (WebMessageListener, share sheet, external open) | `ShellBridge.kt` | same |
| `window.virtuShell` shim, injected at document start | `app/src/main/assets/shell-bridge.js` | same |
| API key at rest (Keystore AES-GCM) | `ApiKeyStore.kt` | plans/mobile.md, Auth |
| WebView host: offline screen, inset padding, link routing, child windows | `MainActivity.kt` | plans/mobile.md, platform gotchas |
| Share target: mint-and-copy mini-dialog + "New alias" direct-share shortcut | `ShareActivity.kt`, `SharedHostname.kt` (pure JVM, unit-tested), `res/xml/shortcuts.xml` | plans/mobile.md, Track E |
| Autofill: the "virtu alias" chip in other apps' email fields | `VirtuAutofillService.kt`, `EmailField.kt` (pure JVM, unit-tested), `AutofillMintActivity.kt`, `AutofillSetupActivity.kt` | plans/mobile.md, Track F |
| Native API slice (alias options + random new, `Authentication` header) | `VirtuApi.kt` | `server/spec/openapi.json` |

Protocol notes specific to this shell:

- The bridge uses the origin-allowlisted `WebMessageListener` +
  `addDocumentStartJavaScript`, never `addJavascriptInterface`. Both are
  feature-detected; on a WebView too old for them nothing is injected and the
  SPA runs as plain web — the degradation shell.md promises.
- Request/reply correlation happens in the shim by internal id; the web app
  only ever sees the promise-based `virtuShell.request`.
- The localStorage healing script (re-seed `virtu.apiKey` from Keystore at
  document start if the WebView's storage was evicted) is re-registered on
  every `apiKey.store`/`apiKey.clear`.
- `window.open`/blob URLs (the SPA's zone-file viewer) open in an in-app child
  WebView attached via `WebViewTransport` — same browsing context, so blob
  URLs resolve. External hosts divert to the system browser (shell.md, known
  gaps).
- The autofill fill response never touches the network: it offers one dataset
  whose value comes from **dataset authentication** — tapping the chip
  launches the translucent `AutofillMintActivity`, which reuses the site's
  existing alias (the server's `recommendation`) or mints, then hands the
  framework the filled dataset. Site context is the browser's `webDomain`
  when present; native-app fills mint without a hostname. Logged out, the
  service stays silent.

## Build & run

Requirements: JDK 17+ and the Android SDK (Android Studio brings both; CLI
needs `ANDROID_HOME` pointing at a real SDK). No JDK/SDK exists on the box
this scaffold was authored on, so the first `gradlew` run anywhere should
start with the test task below.

```sh
./gradlew test          # ShellProtocol conformance tests (pure JVM, no device)
./gradlew assembleDebug # APK against the local dev stack
./gradlew installDebug  # onto a connected device/emulator
```

No JDK at all? The bridge's web-facing half is still testable:
`bun test mobile/android/contract/` (from the repo root) drives the real
`client/src/shell.ts` seam through the real `shell-bridge.js` shim against a
fake native side — it pins the two halves of shell.md together and needs only
bun.

Version pins in `gradle/libs.versions.toml` are from scaffold time
(2026-08-12); accept Studio's bumps on first sync.

### Which backend the shell fronts

Baked in at build time as `BuildConfig.WEB_ORIGIN` / `START_URL`:

- **debug** → `http://10.0.2.2:8080` (the local `just up` stack, reached from
  the emulator; cleartext is allowed for this host in debug builds only).
  Physical device against the dev stack: `adb reverse tcp:8080 tcp:8080` and
  build with `-PvirtuWebOrigin=http://localhost:8080`. Never point a debug
  build at a LAN/remote host over plain http with a real account: the bridge
  (including the stored API key) trusts whatever answers as that origin, and
  http gives a MITM that answer. Loopback paths (emulator, adb reverse) are
  fine.
- **release** → `https://zinc.email`. Staging build:
  `./gradlew assembleRelease -PvirtuWebOrigin=https://lmnop.email`.

### First-run verification checklist (needs a device/emulator)

The protocol tests cover the message layer; these need eyes on a real WebView:

1. Login → `adb shell run-as email.zinc.virtu cat shared_prefs/virtu-shell.xml`
   shows ciphertext (never the raw key).
2. `window.virtuShell` exists at first paint (the shim races page scripts by
   design — document-start injection must precede the SPA bundle; verified by
   the Billing page hiding its purchase UI).
3. Share an alias → native sheet appears.
4. Airplane mode + relaunch → native offline screen, Retry recovers.
5. Domain detail → zone-file viewer (blob URL) opens in the child window.
6. Clear the WebView's site data while logged in → relaunch stays logged in
   (the healing script).
7. Rotate mid-session → no SPA reload (configChanges keeps the WebView).
8. Click links rapidly mid-load → no offline-screen flash (aborted
   navigations must not count as connectivity errors).
11. Share a page from Chrome → virtu in the sheet → alias appears, Copy
    works; share the same page again → the SAME alias comes back (the
    server-side recommendation). Logged out → the "open virtu" dialog.
12. After first app launch, the "New alias" direct-share row appears in the
    share sheet's shortcut strip and mints with no site context.
9. Toggle system dark/light mid-session → WebView content follows
   prefers-color-scheme, and the native offline screen isn't stale-themed
   (uiMode is in configChanges, so the activity is NOT recreated).
10. On an API 26–29 device: focus a form field → keyboard neither covers the
    field nor double-pads (adjustResize + manual ime() insets interact
    differently pre-30).
13. Long-press the app icon → "Set up autofill" → Enable → system picker
    lists virtu → back on the screen the status reads "virtu is your
    autofill service" and the button is gone.
14. In another app's signup form (and in Chrome with its "Autofill using
    another service" switch on, Android 14+): tap the email field → the
    "virtu alias for {site}" chip appears above the keyboard (or in the
    dropdown on IMEs without inline support) → tap it → the field fills.
    Same site again → the SAME alias fills (the server recommendation).
    Password fields never show the chip.
15. Log out in the app → email fields show no virtu suggestion at all.

## Release

- `applicationId` (`email.zinc.virtu`) is **permanent** once a build is
  uploaded to Play, and the app name/branding is still an open question in
  plans/mobile.md — settle both before creating the Play app record.
- Ships as an AAB with Play App Signing; the upload keystore is per-machine
  and gitignored. `./gradlew bundleRelease`.
- Play requires targetSdk 36 (already set) and, from Sept 2026, developer
  verification — which also covers the GitHub-APK distribution lane
  (plans/mobile.md, watch items).

## What's next here (other tracks)

- **Track H** — push (FCM); the `push.register` bridge message name is
  already reserved in shell.md.
