// Find-or-create the SERVICE domain's DKIM signing key — config.mailDomain
// with selector config.dkimSelector (the selector must be passed explicitly:
// ensureDkimKeyRow's default selector "dkim" is for customer domains) — and
// print the DNS TXT record to publish. Idempotent: reruns print the same key.
//
// Usage: bin/dkim-ensure (from the repo root, against the serve stack), or:
//   cd server && bun run src/scripts/dkimEnsure.ts

import { config } from "../config";
import { db } from "../db";
import { ensureDkimKeyRow } from "../pipeline/dkim";

const row = await ensureDkimKeyRow(db, config.mailDomain, config.dkimSelector);

const name = `${row.selector}._domainkey.${row.domain}`;
const value = `v=DKIM1; k=rsa; p=${row.publicKeyBase64}`;

console.log(`DKIM key for ${row.domain}, selector "${row.selector}" (dkim_keys id ${row.id}).`);
console.log("Publish this TXT record:");
console.log();
console.log(`  name:  ${name}`);
console.log(`  value: ${value}`);
console.log();
console.log("Web zone editors (Cloudflare etc.): paste the value as one string.");
console.log("BIND-style zone files must split it at 255 chars (see each.email.zone):");
console.log();
const chunks = value.match(/.{1,255}/g) ?? [];
console.log(
  `${row.selector}._domainkey IN TXT ( ${chunks.map((c) => `"${c}"`).join("\n                         ")} )`,
);

// Bun's SQL client keeps the process alive; the queries above are complete.
process.exit(0);
