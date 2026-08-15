// Human relative time for activity lines ("3 hours ago"), from an epoch in
// seconds (the SimpleLogin API's timestamp unit).

const STEPS: [limit: number, divisor: number, unit: string][] = [
  [60, 1, "second"],
  [3600, 60, "minute"],
  [86400, 3600, "hour"],
  [2592000, 86400, "day"],
  [31536000, 2592000, "month"],
];

export function timeAgo(epochSeconds: number, now = Date.now()): string {
  const diff = Math.max(0, Math.floor(now / 1000) - epochSeconds);
  if (diff < 45) return "just now";
  for (const [limit, divisor, unit] of STEPS) {
    if (diff < limit) {
      const n = Math.round(diff / divisor);
      return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
    }
  }
  const years = Math.round(diff / 31536000);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

/**
 * Compact age from an ISO timestamp ("3m ago", "2h ago", "5d ago"), for
 * dense rows where the prose form above is too wide — the admin queue's
 * list and detail. Same module as {@link timeAgo} on purpose: two functions
 * of the same name in two modules is how the pair drifts apart.
 */
export function compactTimeAgo(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}
