// Shared bits for the admin pages (PLAN Lane K P1). The server is the
// authority on adminship — a 403 renders as the SAME not-found page any
// bogus URL gets (existence-hiding on the browser surface; the API itself
// stays 403, it's in the committed public spec).

import { apiErrorMessage } from "src/api/errors";
import { NotFoundPage } from "src/pages/NotFound";
import { Alert } from "src/ui";

function isForbidden(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === "object" &&
    "response" in err &&
    err.response !== null &&
    typeof err.response === "object" &&
    "status" in err.response &&
    err.response.status === 403
  );
}

export function AdminErrorAlert({ error }: { error: unknown }) {
  if (isForbidden(error)) return <NotFoundPage />;
  return <Alert>{apiErrorMessage(error)}</Alert>;
}

/** Compact relative age for queue rows ("3m ago", "2h ago", "5d ago"). */
export function timeAgo(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

export const STATUS_TONE = {
  pending: "primary",
  sending: "primary",
  sent: "neutral",
  failed: "accent",
} as const;
