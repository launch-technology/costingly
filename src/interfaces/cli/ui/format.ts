/**
 * Turning values into text for a terminal.
 *
 * Presentation only: everything here returns a string meant to be printed.
 * Anything that computes rather than renders belongs in dates.ts, and anything
 * that touches the process belongs in main.ts.
 */

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

/** Clip a string to `width`, ending with an ellipsis when it had to cut. */
export function truncate(value: string, width: number): string {
  return value.length <= width ? value : `${value.slice(0, width - 1)}…`;
}
