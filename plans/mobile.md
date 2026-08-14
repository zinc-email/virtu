# Mobile: iOS & Android companion apps

*Drafted 2026-08-12, from PLAN.md decision #7 plus a store-policy and API research
pass (verified against mid-2026 sources). This is the execution plan for the
"post-MVP mobile shells" lane.*

## What we're building and why

Two small native apps — Swift on iOS, Kotlin on Android — whose main screen is a
WebView showing the production `/app` SPA. The web app remains 100% of the
product UI; each shell is roughly one to two thousand lines of native code that
exist to do the things a browser tab can't:

- **Share-sheet alias minting** — share a page from Safari/Chrome to virtu, get a
  fresh alias for that site without opening the app.
- **Autofill** — suggest or mint an alias directly in other apps' email fields
  (fully inline on Android; via the password-manager slot on iOS).
- **Push notifications** (later) — e.g. "your alias received mail from a new sender."
- **Secure credential storage** — the API key lives in Keychain/Keystore so the
  extensions above can call the API on their own.

This is the HEY/Basecamp architecture. It's how we hit the goals: 90%+ shared
code (product features ship by web deploy, no store release), full API access
for native integrations (the same `Authentication`-header API key the SPA uses),
and the native capabilities are precisely what makes the apps pass the stores'
"more than a repackaged website" bar. React Native/Expo stays rejected
(decision #7).

## What the research established (August 2026)

### Both stores will approve this — if the native features are real

- **Apple (guidelines 4.2 / 2.5.2):** loading our own site from its production
  URL in a WKWebView is fine; 2.5.2's "no downloaded code" rule doesn't apply to
  web content rendered the way a browser would. What kills webview apps is
  feeling like Safari: reviewers do an airplane-mode test, so we need a native
  offline/error screen, a splash screen, and genuine native features. Our share
  extension and autofill are strong 4.2 answers. HEY, Basecamp, and Amazon ship
  this way today.
- **Google Play:** first-party webviews of your own product are allowed (the
  ban targets third-party/affiliate wrappers), but "minimum functionality"
  enforcement tightened through 2025–26 and raw wrappers get rejected. Same
  remedy: share target, autofill, push. Play Console domain verification proves
  we own the site.
- Both bars are discretionary — there is no published checklist. The feature
  set above is practitioner consensus, so we ship the share feature **in v1**,
  not as a fast-follow. It's both the killer feature and the review answer.

### Billing: stay out of it entirely

v1 has **no purchase UI at all** — the "consumption-only" model both stores
explicitly bless. Subscription status can be shown; Google's own docs even
offer "Go to our website to upgrade" as permitted wording. Stripe stays on the
web, we pay the stores nothing, and there's no billing code in the shells. The
web app hides upgrade/checkout UI when it detects it's inside a shell.

*Decided 2026-08-13:* the "visit {host} in your web browser" wording shows on
**Android only**. Apple's anti-steering rule outside the US storefront has
historically caught even non-tappable versions of that sentence, so the iOS
shell shows subscription status with no upgrade wording at all (the seam's
`platform` field drives the split; enforced by `Billing.dom.test.tsx`).

Doors that stay open, deliberately unused for now:

- **US App Store link-out** to Stripe checkout is legal since May 2025 at
  currently 0% commission — but that's under active litigation (Supreme Court
  took the case June 2026; a cost-based Apple fee may return ~2027).
- **Google's external-links program** allows a tappable subscribe link but
  starts collecting service fees Oct 2026 (reportedly 9–20%). Plain text
  costs nothing; a tappable link costs enrollment plus fees. We choose text.
- **Native in-app purchase** (StoreKit 2 / Play Billing) would give true
  one-tap subscribe at 15%, but means products and prices in three consoles
  and two new webhook reconciliation pipelines beside Stripe. Revisit only if
  mobile signups demonstrably stall at billing. Nothing in the architecture
  forecloses it — the bridge would just gain a `purchase` message.
- Embedding Apple Pay / Google Pay *inside* the app for subscriptions is not
  an option on either store; the post-Epic openings are about linking out,
  not in-app alternative processing.

### Sharing: bridge it, don't trust the web API

- **Receiving** (the headline flow): both platforms let us register as a
  share-sheet target. Crucially, the entire flow completes inside the
  extension/mini-activity — iOS share extensions *cannot* reliably open their
  containing app, so "mint, show, copy, done" without launching the main app is
  the design, not a compromise. The server already supports it end to end:
  `GET /v5/alias/options?hostname=` says whether an alias already exists for the
  site, `POST /alias/random/new?hostname=` mints one. **Zero server work needed.**
- **Sending:** `navigator.share` does not work in Android WebView (confirmed,
  longstanding Chromium bug) and is only ambiguously supported in WKWebView. The
  shells expose a share message over the bridge; Android can also polyfill
  `navigator.share` at document-start so web code stays uniform.

### Autofill: Android gets the dream, iOS gets 90% of it

- **Android:** a third-party AutofillService can put a "Create alias for
  {site}" chip inline above the keyboard in any app's email field, mint over
  the network on tap, and fill the result. Chrome supports third-party
  autofill natively on Android 14+ (user flips one settings toggle — an
  onboarding step for us). SimpleLogin ships *no* autofill service (they use a
  custom keyboard) — this is an open competitive lane.
- **iOS:** the Hide My Email suggestion slot is iCloud+-only; no API opens it
  as of iOS 26, none announced for 27. The ceiling — and what Proton Pass
  ships — is registering as a **credential provider** (a "minimal password
  manager"): when the user picks virtu in a signup form, our sheet receives the
  site's domain, can mint an alias over the network mid-fill, and returns it as
  the filled credential; return visits fill from the QuickType bar. iOS 18's
  text-to-insert API is a near-free add-on (long-press in any field → insert an
  alias, though without site context).
- Full ranked report with citations:
  https://claude.ai/code/artifact/c55130bf-7b7c-47a5-ac2c-6b392c2b0a0b

### Auth: our API-key model is exactly right for this

The SPA holds a long-lived API key sent as an `Authentication` header — no
cookie session to synchronize. After login, the web app hands the key to the
shell over the bridge; the shell stores it in the iOS Keychain (in a shared
access group so the extensions can read it) / Android Keystore-encrypted
storage. Extensions call the API directly with it. If the WebView's
localStorage ever gets cleared, the shell re-injects the key instead of
forcing a re-login. (On iOS, WKWebView storage has documented flakiness across
suspensions — the Keychain copy is the safety net.)

### Platform gotchas worth knowing up front

- **iOS:** submissions must be built with Xcode 26 / the iOS 26 SDK (mandatory
  since April 2026). A privacy manifest is required even for a thin shell.
  `target=_blank` links load nowhere unless the shell handles them — and links
  inside displayed emails must open in Safari, never navigate the shell. Login
  must stay inside the webview (Apple explicitly calls bouncing to Safari for
  auth a rejectable experience).
- **Android:** Play requires targeting API 36 (Android 16) by Aug 2026, which
  makes edge-to-edge mandatory. WebView's `env(safe-area-inset-*)` is
  unreliable, so the shell pads for system bars natively and the web app stays
  ignorant of insets. The JS bridge uses the modern origin-allowlisted
  WebMessageListener, not the legacy `addJavascriptInterface`. New apps ship as
  AAB with Play App Signing. Google's developer-verification program starts
  Sept 2026 and also covers off-Play distribution (relevant to us as an AGPL
  project offering APKs on GitHub).
- **Sign in with Apple is NOT required** — guideline 4.8 only triggers for
  third-party/social login, and our own passwordless email-code login is the
  first listed exemption.
- **Account deletion (Apple 5.1.1(v)):** satisfied by a delete-account flow in
  the web settings UI reachable inside the app. Needs to exist by submission.

## The bridge protocol (the one contract everything shares)

A small, versioned, enumerable set of named messages — never a generic eval
channel (decision #7). Defined once in the client as the "shell seam" module;
both shells implement the same names. The web app feature-detects the seam and
behaves as plain web when it's absent. Initial vocabulary, in plain terms:

| Message | Direction | What it does |
|---|---|---|
| hello / platform info | shell → web | "You're inside the iOS/Android shell, version N" — drives UI differences (hide billing, show native share affordances) |
| store API key | web → shell | after login, hand the key over for Keychain/Keystore |
| clear API key | web → shell | on logout, wipe it (extensions lose access too) |
| share | web → shell | present the native share sheet for a given text/URL |
| open external | web → shell | open a URL in the system browser (email links, docs) |
| register push | web → shell | *(later)* request notification permission, return device token |

Adding a message is a deliberate protocol change, reviewed like a schema
change. The seam module is the mobile analog of the OpenAPI spec: the one
definition both sides compile against.

## Workstreams — the fan-out map

Six tracks can run in parallel once the bridge protocol (a one-day design task,
Track A's first deliverable) is agreed. Dependencies are noted; everything else
is independent.

**Track A — Client groundwork** *(web repo; no dependencies; start immediately)*
Write the shell seam module and the bridge protocol doc (unblocks B and C).
Then: hide billing UI under the seam; route external links and share actions
through the seam with web fallbacks; safe-area/touch-target/hover audit of the
SPA in a real WebView. Testable today with a desktop WebView harness or the
existing Playwright screenshot rig.

**Track B — iOS shell** *(depends only on the protocol from A)*
Xcode project, WKWebView on the production URL, message handlers, Keychain
storage with a shared access group, splash + native offline/error screen,
external-link handling, cookie/session healing. Deliverable: a TestFlight
build you can live in.

**Track C — Android shell** *(depends only on the protocol from A; fully
parallel with B)*
Android Studio project, WebView + origin-allowlisted bridge, Keystore-encrypted
key storage, native inset padding for edge-to-edge, splash + offline screen,
external links, AAB signing. Deliverable: an internal-testing build.

**Track D — iOS share extension** *(needs B's project scaffold + Keychain group)*
Receive URL from the share sheet → check alias options → mint → show with a
copy button, all inside the extension. The soul of the iOS app and the 4.2
answer.

**Track E — Android share target** *(needs C's scaffold; parallel with D)*
Translucent mini-activity registered for shared text/URLs; same mint-and-copy
flow; a "New alias" sharing shortcut so we rank well in the share sheet.

**Track F — Android autofill service** *(needs C's key storage; can start
against the API before C is even done)*
The inline "Create alias for {site}" chip; dataset authentication for the
mint-on-tap flow; onboarding screen that walks the user through enabling the
service (including Chrome's third-party autofill toggle).

**Track G — iOS credential provider** *(needs B's Keychain group)*
The Proton Pass pattern: credential provider extension that mints mid-fill and
registers site→alias identities for QuickType return visits; text-to-insert
support as a bonus. Ships in the same app binary as an extension.

**Track H — Push** *(server work; independent, deliberately last)*
The only track with real server scope: APNs + FCM HTTP v1 senders, a device
token table, notification-worthy events (new sender on an alias, mailbox
verification). Both shells grow the permission prompt and deep-link routing.
Defer until v1 is in the stores.

**Track I — Release engineering & listings** *(parallel with everything)*
Play Console org account using the existing D-U-N-S number (Apple account:
already have). App records, listings, screenshots, privacy nutrition labels +
privacy manifest, data-safety form, review notes with a demo account.
Optionally fastlane for repeatable builds. Note: iOS builds require a Mac.

### Suggested waves

1. **Wave 1:** A (protocol first) + B + C + I in parallel.
2. **Wave 2:** D + E + F + G in parallel (each pairs with its platform track),
   while A finishes the SPA audit.
3. **Submit v1** — shells + share + autofill, consumption-only billing.
4. **Wave 3:** H (push), plus whatever review feedback demands.

Android is the richer v1 (inline autofill), iOS the bigger audience; with the
tracks parallelized we don't have to choose an order.

## Where the code lives

`mobile/ios/` and `mobile/android/` in this repo. They're not Bun packages, so
the no-workspaces rule isn't implicated; each is a self-contained Xcode/Gradle
project. The bridge protocol doc lives beside the client seam module so a
change to one is a change to the other in the same review.

## The maintenance budget (what "record time" costs later)

- **Product features: zero mobile cost.** They ship by web deploy. Store
  releases happen only for native/bridge changes.
- **One forced release per year per platform:** Apple's SDK-version floor
  (each spring) and Google's target-SDK deadline (each August). For a thin
  shell these are usually small diffs — this year's Android one was
  edge-to-edge.
- **Review risk is front-loaded:** the first submission is the discretionary
  one; updates to an approved app are routine.
- **Watch items:** the US link-out commission case (SCOTUS, ~2027) if we ever
  want a US subscribe link; Google external-link fees (Oct 2026); Android
  developer verification for off-Play APK distribution (Sept 2026).

## Open questions

- **Mac availability** for iOS builds/CI — GitHub Actions macOS runners are the
  fallback if there's no Mac on the team.
- **App name/branding** in the stores (virtu? the deploy hosts are zinc/lmnop —
  listings need the real consumer name).
- **Off-Play distribution** (GitHub APKs, F-Droid) — natural for an AGPL
  project; requires the free-tier developer verification from Sept 2026.
- **Demo account for reviewers** — both stores need working credentials; our
  passwordless login means review notes must explain the emailed-code flow, or
  we provide a reviewer account with a stable code path.
