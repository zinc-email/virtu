# Reputation telemetry — signup runbook

Companion to `ABUSE.md` Tier 3 ("reputation program"). This is the
operator's checklist for enrolling a box in the programs that tell us how
the big receivers see our IP and domain, what each one actually shows a
sender our size, and which of them are worth automating. Do this once per
sending domain/IP (each, lmnop, zinc); the DNS bits belong in the box's zone
file next to SPF/DKIM/DMARC.

Researched 2026-09-02 against the programs' own pages; the facts below are
the ones that changed recently and will change again — re-check the source
links before relying on a detail.

## What we already have that feeds these

- `postmaster@`, `abuse@`, `hostmaster@`, `security@`, `dmarc@` on the
  service domain deliver to the operators (`OPERATOR_LOCALPARTS`, opt-in
  per admin at `/app/admin/operators` or `just operator-mail <email> --on`;
  the first admin receives by default). Every program below verifies via
  or reports to one of these.
- Our own signal is live before any external program: the Grafana board
  `grafana/deliverability.json` (failed replies by provider × SMTP code,
  pauses, rows held back) and `/app/admin/destinations` (what is paused
  right now and the reply that did it). The external programs add what the
  receiver *thinks* — complaint rate, reputation tier — which no SMTP reply
  carries.

## The programs, in the order to do them

### 1. DMARC aggregate reports (rua) — free, event-driven, no volume floor

The one with real data from day one: every DMARC-participating receiver
(Google, Yahoo/AOL, Apple, Zoho, Mail.ru, …) mails a daily XML report of
what it saw from our domain — pass/fail per source IP, including anyone
spoofing us.

**Do:** set the service domain's `_dmarc` record to include
`rua=mailto:dmarc@<domain>`. The address is on the same domain, so no
external-destination authorization record is needed (that TXT at
`<ourdomain>._report._dmarc.<otherdomain>` is only for cross-domain rua).
Reports arrive at `dmarc@` → the operators, as gzip'd XML attachments
(`application/gzip`, filename `receiver!domain!begin!end.xml.gz`; a few
senders still zip). Google sends roughly once a day. Microsoft sends rua only
for domains whose MX is on Exchange Online, so expect nothing from
Outlook.com.

**Automation:** yes, and it is the best candidate — we run the MX, so an
ingest worker can consume `dmarc@` in-process (parse the XML into a
`dmarc_reports` table: source IP, count, SPF/DKIM alignment, disposition)
and chart it. That is the planned Lane K P4 "DMARC rua ingestion". Until it
exists, the reports are readable by hand (small XML, one file per
receiver-day). Note that since May 2026 DMARC is RFC 9989/9990/9991
(DMARCbis) — the report schema is unchanged in practice.

### 2. Google Postmaster Tools — free, needs volume, dashboard first

**Signup:** any Google account → https://postmaster.google.com → Add
domain → verify by DNS TXT (or CNAME) on the domain we DKIM-sign with
(`d=`). Add every sending domain separately.

**What it shows (v2, the current UI):** Compliance status (SPF/DKIM/DNS/
formatting/TLS/spam-rate checks — the June 2026 "Deliverability analysis"
verdict), Spam rate (user-reported, DKIM-authenticated mail only),
Authentication and Encryption percentages, Delivery errors (categorized
rejects and tempfails), Feedback loop (needs a `Feedback-ID` header we do not
send yet). The old IP/Domain Reputation dashboards are being retired with no
date; treat "reputation tier" as gone.

**Volume floor:** undocumented, in practice low hundreds of messages/day to
Gmail before a day shows data. A box our size will see "No data" most days;
the value is having the domain verified *before* a problem so the day it
matters has history.

**Automation:** possible but not worth it yet. The v2 API
(`domains.domainStats.query`, metrics SPAM_RATE / AUTH_SUCCESS_RATE /
DELIVERY_ERROR_RATE / TLS_ENCRYPTION_RATE / FEEDBACK_LOOP_*) needs OAuth
user consent from an account that owns the domain in Postmaster Tools;
service accounts are not documented. The v1/v1beta1 API still answers but
Google says it "will be retired". Only data for days above the privacy floor
is returned, so at our volume an automated pull would mostly fetch nothing.
Revisit when Gmail volume is steady — the dashboard is enough until then.

### 3. Microsoft SNDS + JMRP — free, per-IP, needs ~100 msgs/day

**Signup:** a Microsoft account at
https://substrate.office.com/ip-domain-management-snds/SNDS (the old
`sendersupport.olc.protection.outlook.com/snds/` redirects). Request the
box's IP. SNDS emails an authorization link to an address it picks from the
IP's rDNS domain (`postmaster@` / `abuse@` of the PTR name) or the RDAP/ASN
contacts — this is exactly why `postmaster@` must deliver. Clicking requires
being logged in. Access must be re-attested roughly every ten months.

**What it shows:** per IP per day: RCPT/DATA counts, recipients, filter
verdict (green <10% spam, yellow, red >90%), complaint rate, sample HELO /
MAIL FROM. Retained 90 days. **Floor: IPs under ~100 messages/day usually
show no row at all.**

**JMRP** (the complaint feedback loop): enroll from the same SNDS account
with the IP and a complaint address (`abuse@<domain>`; verified by email).
Reports arrive as ARF (headers only, sender redacted, body stripped). Feeds
not tied to an SNDS account are purged, so do JMRP after SNDS.

**Automation:** possible, fragile. "Automated Data Access" gives a
key-bearing URL that returns the same CSV as the export button, but the
links now expire after 30 days and the older `data.aspx?key=` forms stopped
working in June 2026. There is an undocumented OAuth2 REST API with
8-hour tokens and no refresh. Verdict: bookmark the dashboard, do not build
on the CSV URL until Microsoft documents something stable.

### 4. Yahoo / AOL Complaint Feedback Loop — free, DKIM-keyed, no floor

**Signup:** https://senders.yahooinc.com → Sender Hub account → add and
verify the domain → enroll the **DKIM `d=` domain** (subdomains
separately) with a reporting address we control, verified by a one-time
code. Use `abuse@<domain>`.

**What arrives:** ARF reports by email from `feedback@arf.mail.yahoo.com`
(DKIM-signed by `arf.mail.yahoo.com`), one per user "this is spam" click,
with original headers. Covers Yahoo, AOL and the hosted brands. No API, no
dashboard, no minimum volume — a real complaint shows up whether we send
ten messages or ten thousand.

**Automation:** later and cheap: ARF is a stable format (RFC 5965), and the
report's original headers carry our `X-Virtu-*` provenance, so an ingest
worker could map each complaint to the email_log → alias → user. That is
the "complaint → concentration detector" input ABUSE.md Tier 2 wants. Until
then the operators read them.

### 5. Not worth chasing

- **Apple/iCloud**: no feedback loop offered.
- **Comcast/Xfinity**: FBL exists (via Validity); per-IP, low value at our
  volume.
- **Validity Universal FBL**: the free tier is aggregate trends only;
  per-message ARF is paid.

## Automate or read by hand?

| Source | Data at our volume | Automate? |
|---|---|---|
| DMARC rua | Yes, daily, from day one | **Yes** — we own the MX; parse into Postgres (Lane K P4) |
| Yahoo CFL (ARF) | Yes, per complaint | Yes, later — maps complaints to aliases for the abuse detector |
| Microsoft JMRP (ARF) | Yes, per complaint | Same ingest as Yahoo (ARF is ARF) |
| Google Postmaster | Sparse until ~hundreds/day to Gmail | Not yet — OAuth-consent API, mostly empty days |
| Microsoft SNDS | Nothing under ~100/day/IP | No — the export URL keeps changing |

So: mailed reports (rua, ARF) are the ones to ingest, and they are the ones
that carry per-message signal we can act on. The dashboards (Google,
SNDS) are for a human to open when the Grafana board shows a receiver
turning red — their value is the verified history, which is why the signups
should happen now, not on the day of the incident.

## Checklist per box

- [ ] `_dmarc.<domain>` carries `rua=mailto:dmarc@<domain>`
- [ ] at least one admin opted in to operator mail (or accept the
      first-admin default) and their mailbox is verified
- [ ] Google Postmaster Tools: domain added + DNS-verified
- [ ] Microsoft SNDS: IP requested + authorized via `postmaster@`
- [ ] Microsoft JMRP: IP enrolled, complaint address `abuse@<domain>`
- [ ] Yahoo Sender Hub: domain verified, CFL enrolled on the DKIM `d=`
      domain, reports to `abuse@<domain>`
- [ ] Grafana: `grafana/deliverability.json` imported against the
      Prometheus datasource Alloy ships to

## Sources

- Google: https://support.google.com/mail/answer/9981691 ·
  https://support.google.com/mail/answer/14668346 ·
  https://support.google.com/mail/answer/16594218 ·
  https://developers.google.com/workspace/gmail/postmaster/reference/rest/v2/domains.domainStats/query
- Microsoft: https://substrate.office.com/ip-domain-management-snds/SNDS/FAQ ·
  https://learn.microsoft.com/en-us/answers/questions/5928061/snds-automated-data-access-not-working-all-forms
- Yahoo: https://senders.yahooinc.com/complaint-feedback-loop/ ·
  https://senders.yahooinc.com/faqs/
- DMARC: https://www.rfc-editor.org/rfc/rfc9990.html ·
  https://knowledge.workspace.google.com/admin/security/about-dmarc-reports
- Apple: https://support.apple.com/en-us/102322 ·
  Validity: https://www.validity.com/blog/universal-feedback-loop-changes/
