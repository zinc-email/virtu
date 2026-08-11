// BIND-format rendering of a custom domain's expected DNS records — the
// "view as zone file" advanced affordance on the domain detail page. Pure
// text assembly; the page opens it as plaintext in a new tab via a Blob URL.

import type { CustomDomainDnsResponse, DnsRecord } from "src/gen";

// A TXT character-string holds at most 255 bytes; longer values (the DKIM
// p= key) split into adjacent quoted strings, which resolvers concatenate.
function quoteTxt(value: string): string {
  const chunks: string[] = [];
  for (let i = 0; i < value.length; i += 255) chunks.push(`"${value.slice(i, i + 255)}"`);
  return chunks.length === 1 ? chunks[0]! : `( ${chunks.join(" ")} )`;
}

// Owner name relative to $ORIGIN: the apex is "@", subdomains drop the
// origin, anything else (never expected) stays fully qualified.
function ownerName(hostname: string, origin: string): string {
  if (hostname === origin) return "@";
  return hostname.endsWith(`.${origin}`) ? hostname.slice(0, -(origin.length + 1)) : `${hostname}.`;
}

function line(record: DnsRecord, origin: string): string {
  const data =
    record.type === "MX" ? `${record.priority ?? 10} ${record.value}` : quoteTxt(record.value);
  return `${ownerName(record.hostname, origin).padEnd(24)} IN ${record.type.padEnd(3)} ${data}`;
}

export function formatZoneFile(dns: CustomDomainDnsResponse): string {
  const origin = dns.domain_name;
  const { ownership, mx, spf, dkim, dmarc } = dns.records;
  const sections: [comment: string, records: DnsRecord[]][] = [
    ["ownership", [ownership]],
    ["receive mail (MX)", mx],
    ["send mail (SPF)", [spf]],
  ];
  if (dkim) sections.push(["authenticate mail (DKIM)", [dkim]]);
  sections.push(["protect your domain (DMARC)", [dmarc]]);
  return [
    `; DNS records for ${origin}`,
    "; Paste into a BIND zone file, or use as a reference for your DNS",
    "; provider's record editor. The TTL is a suggestion — any value works.",
    `$ORIGIN ${origin}.`,
    "$TTL 3600",
    ...sections.flatMap(([comment, records]) => [
      "",
      `; ${comment}`,
      ...records.map((r) => line(r, origin)),
    ]),
    "",
  ].join("\n");
}
