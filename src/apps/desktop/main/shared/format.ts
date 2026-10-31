/**
 * How the desktop app writes money, moments and days.
 *
 * One place, so a balance on the Accounts screen and an amount on the
 * Transactions screen are formatted by the same code, and a date reads the
 * same wherever it appears. Pure functions; the user's own locale decides the
 * separators and the order of day and month.
 */

/**
 * An amount in its currency: "$1,234.56". With no currency, or one Intl does
 * not know, the plain number with two decimals.
 */
export function formatMoney(value: number, currency: string | null): string {
  if (currency !== null) {
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(value);
    } catch {
      // Not a currency code Intl knows. Fall through to the plain number.
    }
  }
  return new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

/** A moment: "Oct 4, 2026, 8:03 PM". */
export function formatWhen(when: Date): string {
  return when.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * A calendar day, given as "YYYY-MM-DD": "Oct 4, 2026".
 *
 * A TRANSACTION'S DATE IS A DAY, NOT A MOMENT. Turned into a moment and shown
 * in local time it becomes midnight UTC — which, anywhere west of Greenwich,
 * is the evening before, and every transaction appears a day early. So the
 * day is read as the three numbers it is and formatted as a UTC date, which
 * cannot move it.
 */
export function formatDay(day: string): string {
  const parts = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  if (parts === null) return day;
  const moment = new Date(Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])));
  return moment.toLocaleDateString(undefined, { dateStyle: "medium", timeZone: "UTC" });
}
