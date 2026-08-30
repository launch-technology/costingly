/**
 * Calendar-day arithmetic in the machine's local timezone.
 *
 * Not formatting — nothing here returns text for a screen. Two of these
 * produce bind values for a SQL date bound, and one measures how stale a
 * result is so a command can say so. What they share is that they all treat a
 * date as a local calendar day, which is the assumption the comment on
 * todayLocal() exists to defend.
 */

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
