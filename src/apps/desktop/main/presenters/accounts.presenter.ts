/**
 * The linked banks, worded for the Accounts screen.
 *
 * Pure functions over plain objects, like the other presenters: every state is
 * a table entry in tests/desktop-accounts-presenter.test.mts.
 *
 * The database hands back one row per account, with the bank's details
 * repeated on each. This groups them under their bank and turns every field
 * into the text the screen draws, so the window formats nothing and decides
 * nothing.
 *
 * A MISSING BALANCE IS A DASH, NEVER ZERO. Zero is a balance; "the bank did
 * not say" is not, and showing one as the other is a wrong number on a screen
 * about money.
 */

import type { ItemAccountListing } from "../../../../domain/data/repositories/items.repository.js";
import type { AccountView, AccountsView, BankView } from "../../bridge/contract.js";
import type { AccountsReading } from "../services/accounts.service.js";

const NO_BALANCE = "—";

export function presentAccounts(reading: AccountsReading): AccountsView {
  if (reading.state === "database-stopped") return { state: "database-stopped" };

  if (reading.state === "failed") {
    return {
      state: "failed",
      problem: {
        cause: `The accounts could not be read: ${reading.reason}`,
        nextStep: "Check the Database section on the Status screen, then try again.",
      },
    };
  }

  return {
    state: "ready",
    banks: groupByBank(reading.rows),
    note: balancesNote(reading.rows),
    canSync: reading.rows.some(isSyncable),
  };
}

/**
 * Would a sync refresh this bank? A real one, whose login still works: sample
 * data has no bank behind it, and a bank that needs attention is skipped until
 * it is reconnected.
 */
function isSyncable(row: ItemAccountListing): boolean {
  return row.source === "plaid" && row.status === "active";
}

function needsAttention(row: ItemAccountListing): boolean {
  return row.source === "plaid" && row.status === "login_required";
}

function lastSynced(row: ItemAccountListing): string {
  if (row.source !== "plaid") return "";
  if (row.last_synced_at === null) return "Not synced yet";
  return `Last synced ${formatWhen(new Date(row.last_synced_at))}`;
}

/** One bank per login, in the order the rows arrive, each with its accounts. */
function groupByBank(rows: ItemAccountListing[]): BankView[] {
  const banks = new Map<string, BankView>();

  for (const row of rows) {
    let bank = banks.get(row.item_id);
    if (bank === undefined) {
      bank = {
        id: row.item_id,
        name: row.institution_name ?? "Unnamed bank",
        sample: row.source === "seed",
        lastSynced: lastSynced(row),
        needsAttention: needsAttention(row),
        accounts: [],
      };
      banks.set(row.item_id, bank);
    }
    // A bank with no accounts still arrives as one row, with the account
    // columns empty.
    if (row.account_id !== null) bank.accounts.push(presentAccount(row, row.account_id));
  }

  return [...banks.values()];
}

function presentAccount(row: ItemAccountListing, id: string): AccountView {
  return {
    id,
    name: row.account_name ?? "Unnamed account",
    type: accountType(row),
    lastFour: row.mask ?? "",
    balance: formatBalance(row.current_balance, row.currency),
  };
}

/** The narrower word when the bank gave one: "Savings" says more than "Depository". */
function accountType(row: ItemAccountListing): string {
  const word = row.subtype ?? row.type ?? "";
  return word === "" ? "" : word.charAt(0).toUpperCase() + word.slice(1);
}

export function formatBalance(amount: string | null, currency: string | null): string {
  if (amount === null) return NO_BALANCE;
  const value = Number(amount);
  if (!Number.isFinite(value)) return NO_BALANCE;

  if (currency !== null) {
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(value);
    } catch {
      // Not a currency code Intl knows. Fall through to the plain number.
    }
  }
  return new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

/**
 * When the balances were written.
 *
 * A balance is a snapshot from linking or from the last sync, never live, so
 * the date matters: an old balance shown without one reads as today's.
 */
function balancesNote(rows: ItemAccountListing[]): string {
  const written = rows
    .map((row) => row.balance_updated_at)
    .filter((when): when is Date => when !== null)
    .map((when) => new Date(when).getTime())
    .filter((time) => Number.isFinite(time));
  if (written.length === 0) return "";

  const latest = new Date(Math.max(...written));
  return `Balances as of ${formatWhen(latest)}.`;
}

export function formatWhen(when: Date): string {
  return when.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
