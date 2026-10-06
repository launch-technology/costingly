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
import type {
  AccountView,
  AccountsView,
  BankView,
  Problem,
  UnlinkPreview,
  UnlinkResult,
} from "../../bridge/contract.js";
import type { AccountsReading } from "../services/accounts.service.js";
import type { UnlinkAttempt, UnlinkPreviewed } from "../services/unlink.service.js";
import { formatMoney, formatWhen } from "./format.js";

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
  return formatMoney(value, currency);
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

// The tests for this file read the formatter from here.
export { formatWhen };

// ---------------------------------------------------------------------------
// Unlinking a bank
// ---------------------------------------------------------------------------

/** What a bank with no name is confirmed by typing. */
const NAMELESS_CONFIRM_WORD = "unlink";

export function presentUnlinkPreview(previewed: UnlinkPreviewed): UnlinkPreview {
  if (previewed.outcome !== "found") return { state: "unavailable", problem: explainBlocked(previewed) };

  const { bank } = previewed;
  return {
    state: "found",
    bankName: bank.institutionName ?? "Unnamed bank",
    confirmWord: bank.institutionName ?? NAMELESS_CONFIRM_WORD,
    summary: `${counted(bank.accounts, "account")} and ${counted(bank.transactions, "transaction")} will be deleted from this computer.`,
    atPlaid: bank.atPlaid,
  };
}

/**
 * How an unlink ended. `askedToRemoveAtPlaid` is what the user chose: it is
 * what tells "left active at Plaid on purpose" from "there was never anything
 * at Plaid", which the outcome alone cannot.
 */
export function presentUnlinkResult(attempt: UnlinkAttempt, askedToRemoveAtPlaid: boolean): UnlinkResult {
  if (attempt.outcome === "unlinked") {
    const name = attempt.institutionName ?? "The bank";
    if (attempt.revokedAtPlaid) {
      return { outcome: "unlinked", message: `Unlinked ${name}. It was also removed at Plaid.` };
    }
    return {
      outcome: "unlinked",
      message: askedToRemoveAtPlaid
        ? `Unlinked ${name}.`
        : `Unlinked ${name} from this computer. Its connection is still active at Plaid and still counts ` +
          `toward your Plaid bill. Remove it in Plaid's dashboard if you no longer want it.`,
    };
  }

  if (attempt.outcome === "plaid-failed") {
    return {
      outcome: "plaid-failed",
      problem: {
        cause: `${attempt.institutionName ?? "This bank"} could not be removed at Plaid: ${attempt.reason}`,
        nextStep:
          "Nothing was deleted. Check your internet connection and try again, or unlink it from this computer only.",
      },
    };
  }

  return { outcome: "failed", problem: explainBlocked(attempt) };
}

function explainBlocked(blocked: Exclude<UnlinkAttempt | UnlinkPreviewed, { outcome: "found" | "unlinked" | "plaid-failed" }>): Problem {
  switch (blocked.outcome) {
    case "not-found":
      return { cause: "That bank is no longer linked.", nextStep: "There is nothing left to unlink." };
    case "database-stopped":
      return { cause: "The database is not running.", nextStep: "Start it from the Status screen, then try again." };
    case "busy":
      return { cause: "A sync is running.", nextStep: "Wait for it to finish, then unlink the bank." };
    case "failed":
      return {
        cause: `The bank could not be unlinked: ${blocked.reason}`,
        // Removal at Plaid comes first, so it may already have happened when
        // the delete here failed — and it cannot be repeated or undone.
        nextStep:
          "If you chose to remove it at Plaid, that may already have happened. Try unlinking again; " +
          "if Plaid then reports a problem, choose to unlink from this computer only.",
      };
  }
}

/** "1 account", "2 accounts", "no transactions". */
function counted(count: number, noun: string): string {
  if (count === 0) return `no ${noun}s`;
  return `${new Intl.NumberFormat().format(count)} ${noun}${count === 1 ? "" : "s"}`;
}
