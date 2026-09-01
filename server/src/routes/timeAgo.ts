// SimpleLogin serializes notification created_at through arrow's
// .humanize() ("2 minutes ago"), so the wire carries a relative English
// phrase, not a timestamp. This mirrors arrow's default thresholds close
// enough for compatible clients; nothing parses these strings.

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// Arrow's month is the mean Gregorian month.
const MONTH = 30.44 * DAY;
const YEAR = 365.25 * DAY;

/** Relative past phrase for `date` as seen from `now` (arrow.humanize()). */
export function timeAgo(date: Date, now: Date = new Date()): string {
  const delta = Math.max(0, now.getTime() - date.getTime());
  if (delta < 45 * SECOND) return "just now";
  if (delta < 90 * SECOND) return "a minute ago";
  if (delta < 45 * MINUTE) return `${Math.round(delta / MINUTE)} minutes ago`;
  if (delta < 90 * MINUTE) return "an hour ago";
  if (delta < 22 * HOUR) return `${Math.round(delta / HOUR)} hours ago`;
  if (delta < 36 * HOUR) return "a day ago";
  if (delta < 25 * DAY) return `${Math.round(delta / DAY)} days ago`;
  if (delta < 45 * DAY) return "a month ago";
  if (delta < 10.5 * MONTH) return `${Math.round(delta / MONTH)} months ago`;
  if (delta < 18 * MONTH) return "a year ago";
  return `${Math.round(delta / YEAR)} years ago`;
}
