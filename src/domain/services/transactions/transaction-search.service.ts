/**
 * Finding transactions: by account, by date, by text — newest first, a page
 * at a time.
 *
 * The one place that says what "the transactions matching this" means, for
 * any interface that lists them. An interface supplies what the person asked
 * for and words what comes back; the rules are here:
 *
 *   NEWEST FIRST, AND A LIMIT. Never "everything": two years of several
 *   accounts is thousands of rows. Asking again with a larger limit returns
 *   the same rows followed by more, which is how a list grows without
 *   skipping or repeating anything when new transactions arrive in between.
 *
 *   BOTH DATES ARE INCLUDED, AND NOTHING HERE WORKS ONE OUT. A caller gives
 *   calendar days or gives none. There is no "last 30 days": that depends on
 *   whose today it is, and an account with little activity is better served
 *   by its latest transactions than by an empty month.
 *
 *   SEARCH TEXT IS TEXT. It matches the description and the merchant name,
 *   anywhere in either, whatever the case — and a % or _ in it means that
 *   character, not "anything".
 *
 * Alongside the matches come the facts that tell an empty result apart from
 * an empty database: how many banks are linked, how many transactions exist
 * at all, and the newest one. "Nothing matches your search" and "nothing has
 * been synced yet" look the same from a row count, and are fixed in entirely
 * different places.
 *
 * Reads only. Throws if the database cannot be reached — it is the caller's
 * job to know whether one should be.
 */

import { db } from "../../data/default-database.js";
import { countAll as countBanks } from "../../data/repositories/items.repository.js";
import {
  countMatching,
  extent,
  PATTERN_ESCAPE,
  search,
  type FoundTransaction,
  type TransactionSearch,
} from "../../data/repositories/transactions.repository.js";

/** How many a first look shows, and how many each "more" adds. */
export const DEFAULT_TRANSACTION_LIMIT = 100;
/** The most one request may ask for, however large a limit it names. */
export const MAX_TRANSACTION_LIMIT = 5_000;

export interface TransactionFilter {
  /** One account's id, or null for every account. */
  accountId: string | null;
  /** First day to include, "YYYY-MM-DD", or null for no lower bound. */
  from: string | null;
  /** Last day to include, "YYYY-MM-DD", or null for no upper bound. */
  to: string | null;
  /** Text to look for in the description or merchant name. Empty for none. */
  text: string;
  /** How many of the newest matches to return. */
  limit: number;
}

export type TransactionsFound =
  | {
      outcome: "found";
      /** The newest matches, up to the limit. */
      rows: FoundTransaction[];
      /** How many match in all, whatever the limit. */
      total: number;
      /** How many banks are linked — sample data included. */
      banks: number;
      /** How many transactions exist for the chosen account, or for all, ignoring dates and text. */
      stored: number;
      /** The date of the newest of those, or null when there are none. */
      newest: string | null;
    }
  /** The from date is after the to date. Not an error: there is simply nothing between them to look for. */
  | { outcome: "invalid-range" };

const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Find transactions. Rejects a filter that is not well-formed — a date that is
 * not a calendar day, a limit that is not a positive whole number — because
 * those are a caller's bug, not a user's choice.
 */
export async function findTransactions(filter: TransactionFilter): Promise<TransactionsFound> {
  const from = calendarDay(filter.from, "from");
  const to = calendarDay(filter.to, "to");
  if (!Number.isInteger(filter.limit) || filter.limit < 1) {
    throw new Error("The number of transactions to show must be a positive whole number.");
  }
  // Calendar days in this form sort as text exactly as they sort as dates.
  if (from !== null && to !== null && from > to) return { outcome: "invalid-range" };

  const criteria: TransactionSearch = {
    accountId: filter.accountId === null || filter.accountId === "" ? null : filter.accountId,
    from,
    to,
    pattern: containing(filter.text),
  };
  const limit = Math.min(filter.limit, MAX_TRANSACTION_LIMIT);

  const [rows, total, banks, all] = await Promise.all([
    search(db, criteria, limit),
    countMatching(db, criteria),
    countBanks(db),
    extent(db, criteria.accountId),
  ]);

  return { outcome: "found", rows, total, banks, stored: all.total, newest: all.newest };
}

function calendarDay(value: string | null, which: string): string | null {
  if (value === null || value === "") return null;
  if (!CALENDAR_DAY.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`The ${which} date is not a calendar day.`);
  }
  return value;
}

/**
 * The pattern for "contains this text", with the text's own pattern
 * characters made literal. Null for no text, which matches everything.
 */
function containing(text: string): string | null {
  const wanted = text.trim();
  if (wanted === "") return null;
  const literal = wanted.replace(/[!%_]/g, (character) => `${PATTERN_ESCAPE}${character}`);
  return `%${literal}%`;
}
