/**
 * How transactions are worded on the Transactions screen — every case, as a
 * table.
 *
 * `transactions.presenter.ts` is pure functions, so each thing a row or an
 * empty list can be is a fixture here. What matters beyond "the right text":
 *
 *   1. The sign is flipped for display: spending negative, money in positive.
 *   2. A date is the same calendar day whatever time zone the machine is in.
 *   3. An empty list always says why, and the four reasons never collapse.
 *   4. Nothing is the CLI's wording.
 */

import type { ItemAccountListing } from "../src/domain/data/repositories/items.repository.js";
import type { FoundTransaction } from "../src/domain/data/repositories/transactions.repository.js";
import type {
  TransactionFilter,
  TransactionsFound,
} from "../src/domain/services/transactions/transaction-search.service.js";
import type { TransactionsView } from "../src/apps/desktop/bridge/contract.js";
import { formatDay, formatMoney } from "../src/apps/desktop/main/presenters/format.js";
import { categoryWords, presentTransactions } from "../src/apps/desktop/main/presenters/transactions.presenter.js";

const out: string[] = [];
let fail = 0;
function eq(a: unknown, b: unknown, what: string): void {
  if (JSON.stringify(a) === JSON.stringify(b)) out.push(`  ok    ${what}`);
  else {
    fail++;
    out.push(`  FAIL  ${what}\n          expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}
const ok = (c: boolean, what: string): void => eq(c, true, what);

const ANY: TransactionFilter = { accountId: null, from: null, to: null, text: "", limit: 100 };

function found(rows: FoundTransaction[], change: Partial<Extract<TransactionsFound, { outcome: "found" }>> = {}): TransactionsFound {
  return { outcome: "found", rows, total: rows.length, banks: 1, stored: rows.length, newest: rows[0]?.date ?? null, ...change };
}
function row(change: Partial<FoundTransaction> = {}): FoundTransaction {
  return {
    transaction_id: "t1",
    date: "2026-03-04",
    name: "POS DEBIT COFFEE SHOP #12",
    merchant_name: "Corner Coffee",
    amount: "4.5000",
    pending: false,
    category: "FOOD_AND_DRINK",
    account_id: "a1",
    account_name: "Everyday Checking",
    mask: "1111",
    currency: "USD",
    institution_name: "Maple Bank",
    ...change,
  };
}
function account(change: Partial<ItemAccountListing> = {}): ItemAccountListing {
  return {
    item_id: "i1",
    institution_name: "Maple Bank",
    status: "active",
    last_synced_at: null,
    never_synced: true,
    source: "plaid",
    account_id: "a1",
    account_name: "Everyday Checking",
    mask: "1111",
    type: "depository",
    subtype: "checking",
    currency: "USD",
    current_balance: "10",
    balance_updated_at: null,
    txn_count: "0",
    first_date: null,
    last_date: null,
    ...change,
  };
}

function present(result: TransactionsFound, filter: TransactionFilter = ANY, accounts: ItemAccountListing[] = [account()]): Extract<TransactionsView, { state: "ready" }> {
  const view = presentTransactions({ state: "ready", found: result, accounts }, filter);
  if (view.state !== "ready") throw new Error(`expected a ready view, got ${view.state}`);
  return view;
}
const one = (change: Partial<FoundTransaction> = {}) => present(found([row(change)])).rows[0]!;
const usd = (value: number): string => formatMoney(value, "USD");

// ===========================================================================
// Not ready
// ===========================================================================

eq(presentTransactions({ state: "database-stopped" }, ANY), { state: "database-stopped" }, "a stopped database stays its own answer");
const failed = presentTransactions({ state: "failed", reason: "connect ECONNREFUSED" }, ANY);
ok(failed.state === "failed" && failed.problem.cause.includes("ECONNREFUSED"), "a failed read carries the reason");
ok(failed.state === "failed" && /Status screen/.test(failed.problem.nextStep), "and points to the Status screen");

// ===========================================================================
// A row
// ===========================================================================

eq(
  one(),
  {
    id: "t1",
    date: formatDay("2026-03-04"),
    description: "Corner Coffee",
    category: "Food and drink",
    account: "Everyday Checking ••••1111",
    amount: usd(-4.5),
    moneyIn: false,
    pending: false,
  },
  "a row: date, the merchant's name, a category in words, the account with its last four, and the amount",
);

eq(one({ merchant_name: null }).description, "POS DEBIT COFFEE SHOP #12", "with no merchant name, the bank's own description is shown");
eq(one({ pending: true }).pending, true, "a pending transaction is marked");
eq(one({ mask: null }).account, "Everyday Checking", "an account with no last four is named without them");
eq(one({ account_name: null }).account, "Unnamed account ••••1111", "an account with no name still has something to call it");

// --- the sign ---
eq(one({ amount: "12.3400" }).amount, usd(-12.34), "SPENDING — stored positive — IS SHOWN NEGATIVE");
eq(one({ amount: "12.3400" }).moneyIn, false, "and is not money in");
eq(one({ amount: "-2500.0000" }).amount, `+${usd(2500)}`, "MONEY IN — stored negative — IS SHOWN POSITIVE, with a plus");
eq(one({ amount: "-2500.0000" }).moneyIn, true, "and is flagged as money in");
eq(one({ amount: "0" }).amount, usd(0), "zero is zero: no minus sign, no plus");
eq(one({ amount: "0" }).moneyIn, false, "and is not money in");
eq(one({ amount: "5", currency: null }).amount, new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(-5), "with no currency, the plain number");
eq(one({ amount: "5", currency: "NOT-A-CODE" }).amount, new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(-5), "an unknown currency code does not break the row");

// --- the category ---
eq(categoryWords("FOOD_AND_DRINK"), "Food and drink", "a category code becomes words");
eq(categoryWords("INCOME"), "Income", "a one-word code too");
eq(categoryWords("SOMETHING_PLAID_ADDS_LATER"), "Something plaid adds later", "a code nobody has seen before is still readable");
eq([categoryWords(null), categoryWords("  ")], ["", ""], "no category is shown as nothing");

// --- the date ---
eq(formatDay("2026-03-04"), new Date(Date.UTC(2026, 2, 4)).toLocaleDateString(undefined, { dateStyle: "medium", timeZone: "UTC" }), "a day is formatted as that day");
ok(/\b4\b/.test(formatDay("2026-03-04")) && !/\b3\b/.test(formatDay("2026-03-04").replace("Mar", "").replace("2026", "")), `THE DAY DOES NOT SLIP TO THE ONE BEFORE in a time zone behind UTC ("${formatDay("2026-03-04")}")`);
ok(/\b1\b/.test(formatDay("2026-01-01")) && /2026/.test(formatDay("2026-01-01")), `nor across a year boundary ("${formatDay("2026-01-01")}")`);
eq(formatDay("not a date"), "not a date", "something that is not a day is shown as it came");

// ===========================================================================
// Counts and account options
// ===========================================================================

{
  const view = present(found([row(), row({ transaction_id: "t2" })], { total: 512 }), ANY, [
    account(),
    account({ account_id: "a2", account_name: "Rewards Card", mask: "2222" }),
    account({ item_id: "i2", institution_name: null, account_id: "a3", account_name: null, mask: null }),
    account({ item_id: "i3", institution_name: "Empty Bank", account_id: null }),
  ]);
  eq([view.rows.length, view.total], [2, 512], "the total is how many match, not how many are shown");
  eq(view.empty, undefined, "with rows, no empty reason");
  eq(
    view.accounts,
    [
      { id: "a1", label: "Maple Bank — Everyday Checking ••••1111" },
      { id: "a2", label: "Maple Bank — Rewards Card ••••2222" },
      { id: "a3", label: "Unnamed bank — Unnamed account" },
    ],
    "accounts to filter by are named with their bank, and a bank with no accounts adds none",
  );
}

// ===========================================================================
// No rows, and why
// ===========================================================================

eq(present(found([], { banks: 0, stored: 0 })).empty, { reason: "no-banks" }, "NO BANK LINKED");
eq(present(found([], { banks: 2, stored: 0 })).empty, { reason: "nothing-synced" }, "BANKS, BUT NOTHING SYNCED");
eq(present({ outcome: "invalid-range" }).empty, { reason: "invalid-range" }, "DATES THE WRONG WAY ROUND");
eq(present({ outcome: "invalid-range" }).accounts.length, 1, "which still offers the accounts, so the filters stay usable");

{
  const none = present(found([], { banks: 2, stored: 255, newest: "2026-08-20" }), { ...ANY, text: "zzz" });
  eq(none.empty, { reason: "no-match", hint: `Your most recent transaction is from ${formatDay("2026-08-20")}.` }, "NOTHING MATCHES, and it says when the newest transaction is");
  eq([none.rows.length, none.total], [0, 0], "with no rows and a total of none");

  const oneAccount = present(found([], { banks: 2, stored: 20, newest: "2026-08-20" }), { ...ANY, accountId: "a2", from: "2027-01-01" });
  eq(oneAccount.empty, { reason: "no-match", hint: `This account's most recent transaction is from ${formatDay("2026-08-20")}.` }, "for one account, the hint is about that account");

  const emptyAccount = present(found([], { banks: 2, stored: 0 }), { ...ANY, accountId: "a2" });
  eq(emptyAccount.empty, { reason: "no-match", hint: "This account has no transactions. Other accounts may." }, "AN ACCOUNT WITH NOTHING IN IT is not 'nothing synced'");
}

const reasons = [
  present(found([], { banks: 0, stored: 0 })).empty?.reason,
  present(found([], { banks: 1, stored: 0 })).empty?.reason,
  present({ outcome: "invalid-range" }).empty?.reason,
  present(found([], { banks: 1, stored: 9, newest: "2026-01-01" })).empty?.reason,
];
eq(new Set(reasons).size, 4, "the four reasons for an empty list are four different answers");

// ===========================================================================
// Nothing is CLI wording
// ===========================================================================

const CLI_WORDING = /costingly\s+(init|migrate|status|stop|sync|link|unlink|uninstall|reset|seed)\b|`|Claude Desktop/;
const said = [
  ...(failed.state === "failed" ? [failed.problem.cause, failed.problem.nextStep] : []),
  "This account has no transactions. Other accounts may.",
  `Your most recent transaction is from ${formatDay("2026-08-20")}.`,
];
eq(said.filter((line) => line.trim() === "" || CLI_WORDING.test(line)), [], `${said.length} lines produced, none empty and none telling the user to run a command`);

console.log(out.join("\n"));
console.log(fail === 0 ? `\nAll ${out.length} checks passed.` : `\n${fail} FAILED.`);
process.exit(fail === 0 ? 0 : 1);
