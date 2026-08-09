/**
 * Tiny RFC 5322 message builder for story tests — headers + plain body,
 * CRLF join, X-Virtu-Test-Id stamped for Maildir addressing.
 */

export interface BuildMessageOptions {
  from: string;
  to: string;
  subject: string;
  testId: string;
  messageId?: string;
  inReplyTo?: string;
  body?: string;
  extraHeaders?: string[];
}

export function buildMessage(opts: BuildMessageOptions): string {
  const domain = opts.from.slice(opts.from.indexOf("@") + 1).replace(/>$/, "");
  const lines = [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${opts.messageId ?? `<${opts.testId}@${domain}>`}`,
    ...(opts.inReplyTo === undefined ? [] : [`In-Reply-To: ${opts.inReplyTo}`]),
    `X-Virtu-Test-Id: ${opts.testId}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    ...(opts.extraHeaders ?? []),
    "",
    opts.body ?? `Test message ${opts.testId}`,
    "",
  ];
  return lines.join("\r\n");
}
