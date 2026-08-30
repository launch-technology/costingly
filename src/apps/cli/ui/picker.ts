/**
 * The interactive pickers behind a bare `costingly txns`.
 *
 * Two prompts — which account, then how far back — and nothing else. They read
 * no database and parse no argv: the caller loads the accounts and hands them
 * over, which is what lets the tests drive these without a TTY or a cluster.
 *
 * `io` overrides the streams clack reads and writes, defaulting to the real
 * terminal.
 */

import { select, isCancel, cancel } from "@clack/prompts";
import { money } from "./format.js";

/** Default window when --days was not given. */
export const DEFAULT_DAYS = 7;

/** How far back to look: a number of days, or every transaction on record. */
export type Window = number | "all";

export function windowLabel(window: Window): string {
  return window === "all" ? "All time" : `Last ${window} day(s)`;
}

/** Sentinel for the "All accounts" menu entry. Not a real account id. */
const ALL_ACCOUNTS = "__all__";

export type AccountRow = {
  account_id: string;
  name: string | null;
  mask: string | null;
  type: string | null;
  subtype: string | null;
  currency: string | null;
  current_balance: string | null;
  institution_name: string | null;
  txn_count: string;
};

/** "Plaid Checking ••0000" — no bank name; the header carries that. */
export function shortLabel(account: AccountRow): string {
  return `${account.name ?? "(unnamed)"} ••${account.mask ?? "????"}`;
}

/**
 * Arrow-key account picker. Returns the chosen accounts, or null if cancelled.
 *
 * The bank name is omitted while only one institution is linked — it is pure
 * noise there — and reappears automatically once a second bank exists.
 *
 * `io` overrides the streams clack reads and writes. It defaults to the real
 * terminal; tests pass fakes so the picker can be driven without a TTY.
 */
export async function pickAccounts(
  accounts: AccountRow[],
  io: { input?: NodeJS.ReadStream; output?: NodeJS.WriteStream } = {},
): Promise<AccountRow[] | null> {
  const banks = new Set(accounts.map((account) => account.institution_name ?? "(unknown bank)"));
  const showBank = banks.size > 1;

  // Balance and count go in the *label*, not `hint`: clack only renders a hint
  // for the focused row, and when you are choosing between accounts you want to
  // compare all the balances at once, not one at a time.
  const names = accounts.map(
    (account) =>
      (showBank ? `${account.institution_name ?? "(unknown bank)"} · ` : "") + shortLabel(account),
  );
  const nameWidth = Math.max(...names.map((name) => name.length));

  const choice = await select({
    ...io,
    message: "Select an account",
    options: [
      ...accounts.map((account, index) => ({
        value: account.account_id,
        label:
          `${names[index]!.padEnd(nameWidth)}  ` +
          `${money(account.current_balance, account.currency).padStart(13)}  ` +
          `${account.txn_count.padStart(5)} txns`,
      })),
      {
        value: ALL_ACCOUNTS,
        label: `All accounts`.padEnd(nameWidth) + `  ${accounts.length} accounts combined`,
      },
    ],
  });

  if (isCancel(choice)) {
    cancel("Cancelled.");
    return null;
  }
  if (choice === ALL_ACCOUNTS) return accounts;
  return accounts.filter((account) => account.account_id === choice);
}

/**
 * Second prompt: how far back to look.
 *
 * Only shown when `--days` was not passed explicitly, so the interactive path
 * needs no flags at all while scripts keep full control.
 */
export async function pickWindow(
  io: { input?: NodeJS.ReadStream; output?: NodeJS.WriteStream } = {},
): Promise<Window | null> {
  const choice = await select<Window>({
    ...io,
    message: "How far back?",
    initialValue: DEFAULT_DAYS,
    options: [
      { value: 7, label: "Last 7 days" },
      { value: 14, label: "Last 14 days" },
      { value: 30, label: "Last 30 days" },
      { value: 90, label: "Last 90 days" },
      { value: 365, label: "Last year" },
      { value: "all", label: "All time" },
    ],
  });

  if (isCancel(choice)) {
    cancel("Cancelled.");
    return null;
  }
  return choice;
}
