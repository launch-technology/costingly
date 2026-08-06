/**
 * Shared formatting for the CLI scripts. Presentation only — nothing here is
 * imported by `src/`, which stays framework- and terminal-agnostic.
 */

/**
 * Exit quietly when a downstream pipe closes.
 *
 * `costingly txns | head` closes stdout while we are still writing, which Node
 * surfaces as an unhandled EPIPE and a stack trace. Every well-behaved CLI
 * swallows it.
 */
export function ignoreEpipe(): void {
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(0);
  });
}

/** Format a NUMERIC-as-string from pg as currency. */
export function money(amount: string | number | null, currency: string | null): string {
  if (amount === null) return "—";
  const value = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(value)) return String(amount);
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency ?? "USD",
    }).format(value);
  } catch {
    // Unknown / non-ISO currency code — fall back to a plain number.
    return value.toFixed(2);
  }
}

/** Human-readable age of a timestamp. */
export function ago(when: Date | null): string {
  if (when === null) return "never";
  const minutes = Math.floor((Date.now() - when.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Today's date in the *machine's local* timezone, as "YYYY-MM-DD".
 *
 * Deliberately not Postgres' CURRENT_DATE. The local cluster happens to inherit
 * the system timezone today, so the two usually agree — but that is a database
 * setting, not a guarantee, and `SET TimeZone` or a differently-configured
 * server would silently shift a "last 7 days" window by a day. Plaid
 * transaction dates are local calendar days at the bank, so the user's own
 * calendar is the right reference point and should not depend on how the
 * database is configured.
 */
export function todayLocal(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** `date` ("YYYY-MM-DD") minus `days`, as "YYYY-MM-DD". */
export function subtractDays(date: string, days: number): string {
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(ms)) return date;
  return new Date(ms - days * 86_400_000).toISOString().slice(0, 10);
}

/** Whole days between two "YYYY-MM-DD" dates, treating both as calendar days. */
export function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.round((end - start) / 86_400_000);
}

/** Clip a string to `width`, ending with an ellipsis when it had to cut. */
export function truncate(value: string, width: number): string {
  return value.length <= width ? value : `${value.slice(0, width - 1)}…`;
}
