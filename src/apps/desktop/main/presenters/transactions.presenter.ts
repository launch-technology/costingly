/**
 * Transactions, worded for the Transactions screen.
 *
 * Pure functions, like the other presenters; every case is a table entry in
 * tests/desktop-transactions-presenter.test.mts.
 *
 * THE SIGN IS FLIPPED HERE, AND ONLY HERE. costingly stores an amount the way
 * Plaid reports it: positive is money leaving the account. That is the
 * reverse of every bank statement anyone has read. So for display — and for
 * display alone — spending is shown negative and money coming in positive.
 * The stored value, the views a model queries, and every other reader are
 * untouched; nothing else in the app needs to know this was done.
 *
 * AN EMPTY LIST ALWAYS SAYS WHY. "No banks", "nothing synced", "nothing
 * matches" and "those dates are backwards" are four different situations with
 * four different fixes, and a bare empty table reads as all of them at once.
 */

import type { ItemAccountListing } from "../../../../domain/data/repositories/items.repository.js";
import type { FoundTransaction } from "../../../../domain/data/repositories/transactions.repository.js";
import type { TransactionFilter } from "../../../../domain/services/transactions/transaction-search.service.js";
import type {
  AccountOption,
  NoTransactions,
  TransactionRowView,
  TransactionsView,
} from "../../bridge/contract.js";
import type { TransactionsReading } from "../services/transactions.service.js";
import { formatDay, formatMoney } from "./format.js";

export function presentTransactions(reading: TransactionsReading, filter: TransactionFilter): TransactionsView {
  if (reading.state === "database-stopped") return { state: "database-stopped" };

  if (reading.state === "failed") {
    return {
      state: "failed",
      problem: {
        cause: `The transactions could not be read: ${reading.reason}`,
        nextStep: "Check the Database section on the Status screen, then try again.",
      },
    };
  }

  const accounts = accountOptions(reading.accounts);
  const { found } = reading;

  if (found.outcome === "invalid-range") {
    return { state: "ready", rows: [], total: 0, accounts, empty: { reason: "invalid-range" } };
  }

  const rows = found.rows.map(presentRow);
  if (rows.length > 0) return { state: "ready", rows, total: found.total, accounts };

  return { state: "ready", rows, total: 0, accounts, empty: whyEmpty(found, filter) };
}

function presentRow(row: FoundTransaction): TransactionRowView {
  const stored = Number(row.amount);
  // Flipped for display: see the header. `0 - x` rather than `-x` so a zero
  // amount is not shown as "-$0.00".
  const shown = Number.isFinite(stored) ? 0 - stored : 0;
  const moneyIn = shown > 0;

  return {
    id: row.transaction_id,
    date: formatDay(row.date),
    description: row.merchant_name ?? row.name,
    category: categoryWords(row.category),
    account: accountLabel(row.account_name, row.mask),
    amount: (moneyIn ? "+" : "") + formatMoney(shown, row.currency),
    moneyIn,
    pending: row.pending,
  };
}

/** "FOOD_AND_DRINK" as "Food and drink". Plaid's codes are words joined by underscores. */
export function categoryWords(code: string | null): string {
  if (code === null || code.trim() === "") return "";
  const words = code.trim().toLowerCase().replace(/_+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "Everyday Checking ••••1111" — the way the Accounts screen names an account. */
function accountLabel(name: string | null, mask: string | null): string {
  const shown = name ?? "Unnamed account";
  return mask === null || mask === "" ? shown : `${shown} ••••${mask}`;
}

/** Every account, named with its bank, in the order the Accounts screen lists them. */
function accountOptions(rows: ItemAccountListing[]): AccountOption[] {
  return rows
    .filter((row): row is ItemAccountListing & { account_id: string } => row.account_id !== null)
    .map((row) => ({
      id: row.account_id,
      label: `${row.institution_name ?? "Unnamed bank"} — ${accountLabel(row.account_name, row.mask)}`,
    }));
}

function whyEmpty(
  found: Extract<TransactionsReading, { state: "ready" }>["found"] & { outcome: "found" },
  filter: TransactionFilter,
): NoTransactions {
  if (found.banks === 0) return { reason: "no-banks" };

  // `stored` is for the chosen account, or for every account when none is
  // chosen. Nothing stored for all accounts means nothing has been synced.
  const oneAccount = filter.accountId !== null && filter.accountId !== "";
  if (found.stored === 0 && !oneAccount) return { reason: "nothing-synced" };

  if (found.stored === 0) {
    return { reason: "no-match", hint: "This account has no transactions. Other accounts may." };
  }
  return {
    reason: "no-match",
    hint:
      found.newest === null
        ? ""
        : `${oneAccount ? "This account's" : "Your"} most recent transaction is from ${formatDay(found.newest)}.`,
  };
}
