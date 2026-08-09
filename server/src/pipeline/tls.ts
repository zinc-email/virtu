/**
 * TLS material for the SMTP listeners: read PEM cert/key from the paths in
 * config (test net: the mkcert virtu.email pair). Both unset => plaintext
 * listeners (local dev); one set without the other is a config error.
 */

import { readFileSync } from "node:fs";
import type { SmtpTlsConfig } from "../smtp/index.ts";

export function loadSmtpTls(
  certFile: string | undefined,
  keyFile: string | undefined,
): SmtpTlsConfig | undefined {
  if (certFile === undefined && keyFile === undefined) return undefined;
  if (certFile === undefined || keyFile === undefined) {
    throw new Error("SMTP_TLS_CERT_FILE and SMTP_TLS_KEY_FILE must be set together");
  }
  return {
    cert: readFileSync(certFile, "utf8"),
    key: readFileSync(keyFile, "utf8"),
  };
}
