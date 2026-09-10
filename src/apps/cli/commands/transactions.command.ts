/**
 * `costingly txns` — view recent transactions.
 *
 *   costingly txns                   arrow-key account picker, then a window
 *   costingly txns --days 30         picker, 30-day window
 *   costingly txns --all -d 90       every account, 90-day window
 *   costingly txns checking          skip the picker, match by name/mask/id
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
import { stdin } from "node:process";
import { db } from "../../../domain/data/default-database.js";
import { search as searchAccounts } from "../../../domain/data/repositories/accounts.repository.js";
import {
  listForAccounts,
  summaryForAccounts,
} from "../../../domain/data/repositories/transactions.repository.js";
import { money, truncate } from "../ui/format.js";
import {
  DEFAULT_DAYS,
  windowLabel,
  shortLabel,
  pickAccounts,
  pickWindow,
  type AccountRow,
  type Window,
} from "../ui/picker.js";
import { todayLocal, daysBetween, subtractDays } from "../utils/dates.js";


function parseDays(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("must be a positive number of days");
  }
  return parsed;
}


async function showTransactions(accounts: AccountRow[], window: Window): Promise<void> {
  const ids = accounts.map((account) => account.account_id);
  const multi = accounts.length > 1;

  // The cutoff is computed from the caller's local date, not the database's —
  // see todayLocal(). A null cutoff means "no lower bound".
  const today = todayLocal();
  const cutoff = window === "all" ? null : subtractDays(today, window);

  const rows = await listForAccounts(db, ids, cutoff);

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
    const info = await summaryForAccounts(db, ids);

    console.log(
      window === "all"
        ? "  No transactions at all."
        : `  No transactions in the last ${window} day(s).`,
    );

    if (!info || info.newest === null || Number(info.total) === 0) {
      console.log(
        multi
          ? `  These accounts have no transactions at all — run \`costingly sync\`.\n`
          : `  This account has no transactions at all.\n` +
              `  Run \`costingly sync\`, or note that some account types (investment,\n` +
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
    console.log(`  To see it:  costingly txns ${scope}--days ${suggestion}\n`);
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
  costingly txns                  pick an account, then a window
  costingly txns --days 30        picker, 30-day window
  costingly txns --all -d 90      every account, 90 days
  costingly txns checking         match by name, skip the picker
  costingly txns 0000             match by mask

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

  const matches = await searchAccounts(db, accountQuery);

  if (matches.length === 0) {
    if (accountQuery === null) {
      console.log("No accounts yet. Run `costingly link`, then `costingly sync`.");
    } else {
      console.log(
        `No account matches "${accountQuery}". Run \`costingly txns\` to pick from a list.`,
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

  // More than one candidate. Prompt if we can; a non-TTY (a pipe, CI) has
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
    console.log(`\n  costingly txns <name or mask> [--days ${DEFAULT_DAYS}]`);
    console.log(`  costingly txns --all\n`);
    process.exitCode = accountQuery === null ? 0 : 1;
    return;
  }

  const chosen = await pickAccounts(matches);
  if (chosen === null) return;

  const window = daysGiven ? options.days : await pickWindow();
  if (window === null) return;

  await showTransactions(chosen, window);
}
