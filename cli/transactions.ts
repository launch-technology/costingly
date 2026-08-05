/**
 * `plaid-sync txns` — view recent transactions.
 *
 *   plaid-sync txns                   arrow-key account picker, then a window
 *   plaid-sync txns --days 30         picker, 30-day window
 *   plaid-sync txns --all -d 90       every account, 90-day window
 *   plaid-sync txns checking          skip the picker, match by name/mask/id
 *
 * Argument parsing is commander; the picker is @clack/prompts. Both are CLI-only
 * dependencies — `src/` stays free of them, so nothing here ships to Vercel.
 *
 * This module has no top-level statements, so importing it (as the picker tests
 * do) cannot parse argv or open a database connection. That is what the old
 * entry-point guard used to defend; it is now structural.
 */

import { InvalidArgumentError } from "commander";
import type { Command } from "commander";
import { select, isCancel, cancel } from "@clack/prompts";
import { stdin } from "node:process";
import { query } from "../src/db.js";
import { money, truncate, todayLocal, daysBetween, subtractDays } from "./format.js";

const DEFAULT_DAYS = 7;

/** How far back to look: a number of days, or every transaction on record. */
type Window = number | "all";

function windowLabel(window: Window): string {
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

type TxnRow = {
  date: string;
  name: string | null;
  merchant_name: string | null;
  amount: string;
  pending: boolean;
  category: string | null;
  account_name: string | null;
  mask: string | null;
  currency: string | null;
};

function parseDays(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("must be a positive number of days");
  }
  return parsed;
}

/** "Plaid Checking ••0000" — no bank name; the header carries that. */
function shortLabel(account: AccountRow): string {
  return `${account.name ?? "(unnamed)"} ••${account.mask ?? "????"}`;
}

async function loadAccounts(accountQuery: string | null): Promise<AccountRow[]> {
  const { rows } = await query<AccountRow>(
    `
    SELECT a.account_id, a.name, a.mask, a.type, a.subtype, a.currency,
           a.current_balance, i.institution_name,
           COALESCE((SELECT COUNT(*) FROM transactions t WHERE t.account_id = a.account_id), 0)::text
             AS txn_count
      FROM accounts a
      JOIN items i ON i.item_id = a.item_id
     WHERE $1::text IS NULL
        OR a.account_id = $1
        OR a.mask = $1
        OR a.name ILIKE '%' || $1 || '%'
        OR i.institution_name ILIKE '%' || $1 || '%'
     ORDER BY i.institution_name NULLS LAST, a.name NULLS LAST
    `,
    [accountQuery],
  );
  return rows;
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

async function showTransactions(accounts: AccountRow[], window: Window): Promise<void> {
  const ids = accounts.map((account) => account.account_id);
  const multi = accounts.length > 1;

  // The cutoff is computed from the caller's local date, not the database's —
  // see todayLocal(). A null cutoff means "no lower bound".
  const today = todayLocal();
  const cutoff = window === "all" ? null : subtractDays(today, window);

  const { rows } = await query<TxnRow>(
    `
    SELECT t.date, t.name, t.merchant_name, t.amount, t.pending,
           t.pfc->>'primary' AS category,
           a.name            AS account_name,
           a.mask,
           a.currency
      FROM transactions t
      JOIN accounts a ON a.account_id = t.account_id
     WHERE t.account_id = ANY($1::text[])
       AND ($2::date IS NULL OR t.date >= $2::date)
     ORDER BY t.date DESC, t.pending DESC, t.transaction_id
    `,
    [ids, cutoff],
  );

  const banks = [...new Set(accounts.map((a) => a.institution_name ?? "(unknown bank)"))];
  const heading = multi
    ? `All accounts (${accounts.length}) · ${banks.join(", ")}`
    : `${accounts[0]!.institution_name ?? "(unknown bank)"} · ${shortLabel(accounts[0]!)}`;

  console.log(`\n${heading}`);
  console.log(`${windowLabel(window)}\n`);

  if (rows.length === 0) {
    // An empty window is not the same as an empty account. Say which, and
    // suggest a window that would actually contain something — otherwise a
    // correct answer is indistinguishable from a broken one.
    const outside = await query<{ newest: string | null; total: string }>(
      `
      SELECT MAX(date)::text AS newest, COUNT(*)::text AS total
        FROM transactions
       WHERE account_id = ANY($1::text[])
      `,
      [ids],
    );
    const info = outside.rows[0];

    console.log(
      window === "all"
        ? "  No transactions at all."
        : `  No transactions in the last ${window} day(s).`,
    );

    if (!info || info.newest === null || Number(info.total) === 0) {
      console.log(
        multi
          ? `  These accounts have no transactions at all — run \`plaid-sync sync\`.\n`
          : `  This account has no transactions at all.\n` +
              `  Run \`plaid-sync sync\`, or note that some account types (investment,\n` +
              `  loan) return balances but no transactions under the transactions product.\n`,
      );
      return;
    }

    const stale = daysBetween(info.newest, today);
    const suggestion = [14, 30, 90, 180, 365, 730].find((window) => window > stale) ?? 730;
    const scope = multi ? "--all " : `${accounts[0]!.mask ?? accounts[0]!.account_id} `;

    console.log(
      `  ${info.total} transaction(s) on record; the most recent is ${info.newest}` +
        ` (${stale} day(s) ago).`,
    );
    console.log(`  To see it:  plaid-sync txns ${scope}--days ${suggestion}\n`);
    return;
  }

  // Keyed by currency so mixed-currency accounts never get summed together.
  const totals = new Map<string, { in: number; out: number }>();

  for (const row of rows) {
    // Stored in Plaid's convention (positive = money out). Flipped below so the
    // output reads like a bank statement; see the footer note.
    const plaidAmount = Number(row.amount);
    const code = row.currency ?? "USD";
    const bucket = totals.get(code) ?? { in: 0, out: 0 };
    if (plaidAmount >= 0) bucket.out += plaidAmount;
    else bucket.in += -plaidAmount;
    totals.set(code, bucket);

    const description = truncate(row.merchant_name ?? row.name ?? "(no description)", multi ? 28 : 40);
    // 24 wide so a typical "<name> ••1234" keeps its mask — the part that
    // actually identifies the account.
    const accountCol = multi
      ? `  ${truncate(`${row.account_name ?? "?"} ••${row.mask ?? "????"}`, 24).padEnd(24)}`
      : "";

    console.log(
      `  ${row.date}  ${description.padEnd(multi ? 28 : 40)} ` +
        `${money(-plaidAmount, row.currency).padStart(13)}${accountCol}  ` +
        `${truncate(row.category ?? "", 20).padEnd(20)}${row.pending ? " PENDING" : ""}`,
    );
  }

  console.log(`\n  ${rows.length} transaction(s)`);
  for (const [code, bucket] of totals) {
    console.log(
      `    ${code}: in ${money(bucket.in, code)} · out ${money(bucket.out, code)} · ` +
        `net ${money(bucket.in - bucket.out, code)}`,
    );
  }
  console.log(
    `\n  Shown as a ledger: negative = money out. The database stores Plaid's\n` +
      `  convention, where those same amounts are positive.\n`,
  );
}

interface TxnOptions {
  days: number;
  all?: boolean;
}

export function registerTransactionsCommand(program: Command): void {
  program
    .command("txns")
    .description("Browse transactions — interactive picker")
    .helpGroup("Looking at your data:")
    // Variadic so an unquoted multi-word name works: `txns everyday checking`.
    .argument("[account...]", "account name, mask, id, or bank name (skips the picker)")
    .option("-d, --days <days>", "how many days back to look", parseDays, DEFAULT_DAYS)
    .option("-a, --all", "every account, without the picker")
    .addHelpText(
      "after",
      `
Examples:
  plaid-sync txns                  pick an account, then a window
  plaid-sync txns --days 30        picker, 30-day window
  plaid-sync txns --all -d 90      every account, 90 days
  plaid-sync txns checking         match by name, skip the picker
  plaid-sync txns 0000             match by mask

With no --days, you get a second prompt for the time window.`,
    )
    .action(async (account: string[], options: TxnOptions, command: Command) => {
      // commander reports where each value came from, so an explicit `--days 7`
      // is distinguishable from the default 7 — the former skips the prompt.
      // Read from the SUBCOMMAND instance, not the root program.
      const daysGiven = command.getOptionValueSource("days") !== "default";
      await runTransactions(account, options, daysGiven);
    });
}

export async function runTransactions(
  account: readonly string[],
  options: TxnOptions,
  daysGiven: boolean,
): Promise<void> {
  const accountQuery = account.length > 0 ? account.join(" ") : null;
  const interactive = stdin.isTTY === true;

  const matches = await loadAccounts(accountQuery);

  if (matches.length === 0) {
    if (accountQuery === null) {
      console.log("No accounts yet. Run `plaid-sync link`, then `plaid-sync sync`.");
    } else {
      console.log(
        `No account matches "${accountQuery}". Run \`plaid-sync txns\` to pick from a list.`,
      );
      process.exitCode = 1;
    }
    return;
  }

  // --all, or an argument that resolved to exactly one account: skip the
  // account picker, but still offer the window prompt when interactive.
  if (options.all || matches.length === 1) {
    const window = daysGiven || !interactive ? options.days : await pickWindow();
    if (window === null) return;
    await showTransactions(matches, window);
    return;
  }

  // More than one candidate. Prompt if we can; a non-TTY (cron, a pipe) has
  // nobody to answer, so list the options and exit rather than blocking.
  if (!interactive) {
    console.log(
      accountQuery === null
        ? "\nSeveral accounts available — pass one, or --all:\n"
        : `\n"${accountQuery}" matches ${matches.length} accounts:\n`,
    );
    for (const account of matches) {
      console.log(`  ${account.institution_name ?? "?"} · ${shortLabel(account)}`);
    }
    console.log(`\n  plaid-sync txns <name or mask> [--days ${DEFAULT_DAYS}]`);
    console.log(`  plaid-sync txns --all\n`);
    process.exitCode = accountQuery === null ? 0 : 1;
    return;
  }

  const chosen = await pickAccounts(matches);
  if (chosen === null) return;

  const window = daysGiven ? options.days : await pickWindow();
  if (window === null) return;

  await showTransactions(chosen, window);
}
