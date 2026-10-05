/**
 * The Accounts screen's wording — every state, as a table.
 *
 * `accounts.presenter.ts` is pure functions, so each thing the screen can show
 * is a fixture here. What matters beyond "the right text":
 *
 *   1. Rows are grouped under their bank, and a bank with no accounts is
 *      still a bank.
 *   2. A balance the bank did not report is a dash, never zero.
 *   3. Sample data is marked as sample data.
 *   4. Every problem says what went wrong AND what to do, and none of it is
 *      the CLI's wording.
 */

import type { ItemAccountListing } from "../src/domain/data/repositories/items.repository.js";
import type { Problem } from "../src/apps/desktop/bridge/contract.js";
import {
  formatBalance,
  formatWhen,
  presentAccounts,
} from "../src/apps/desktop/main/presenters/accounts.presenter.js";

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

const problems: Problem[] = [];

const WRITTEN = new Date("2026-03-04T15:30:00Z");
function row(change: Partial<ItemAccountListing>): ItemAccountListing {
  return {
    item_id: "item-1",
    institution_name: "First Bank",
    status: "active",
    last_synced_at: null,
    never_synced: true,
    source: "plaid",
    account_id: "acct-1",
    account_name: "Everyday Checking",
    mask: "1234",
    type: "depository",
    subtype: "checking",
    currency: "USD",
    current_balance: "1234.5000",
    balance_updated_at: WRITTEN,
    txn_count: "0",
    first_date: null,
    last_date: null,
    ...change,
  };
}
const usd = (amount: number): string =>
  new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(amount);

// ===========================================================================
// The three answers
// ===========================================================================

eq(presentAccounts({ state: "database-stopped" }), { state: "database-stopped" }, "a stopped database stays its own answer");

{
  const view = presentAccounts({ state: "failed", reason: "connection refused" });
  ok(view.state === "failed", "a failed read is a failed view");
  if (view.state === "failed") {
    problems.push(view.problem);
    ok(view.problem.cause.includes("connection refused"), "which carries the reason");
    ok(/Status screen/.test(view.problem.nextStep), "and points to the Status screen");
  }
}

eq(
  presentAccounts({ state: "ready", rows: [] }),
  { state: "ready", banks: [], note: "", canSync: false },
  "no rows: ready, no banks, nothing to say about balances, and nothing to sync",
);

// ===========================================================================
// Grouping
// ===========================================================================

{
  const view = presentAccounts({
    state: "ready",
    rows: [
      row({}),
      row({ account_id: "acct-2", account_name: "Savings", subtype: "savings", mask: "9876", current_balance: "50" }),
      row({ item_id: "item-2", institution_name: "Second Bank", account_id: "acct-3", account_name: "Card", type: "credit", subtype: "credit card", mask: "0001", current_balance: "310.25" }),
    ],
  });
  ok(view.state === "ready", "rows: a ready view");
  if (view.state === "ready") {
    eq(view.banks.map((bank) => [bank.name, bank.accounts.length]), [["First Bank", 2], ["Second Bank", 1]], "ACCOUNTS ARE GROUPED UNDER THEIR BANK, in the order they arrive");
    eq(
      view.banks[0]?.accounts[0],
      { id: "acct-1", name: "Everyday Checking", type: "Checking", lastFour: "1234", balance: usd(1234.5) },
      "an account carries its name, type, last four and formatted balance",
    );
    eq(view.banks[1]?.accounts[0]?.type, "Credit card", "the narrower type word is used, capitalised");
    eq(view.banks.map((bank) => bank.sample), [false, false], "real banks are not marked as sample data");
    eq(view.note, `Balances as of ${formatWhen(WRITTEN)}.`, "the note says when balances were written");
    eq(view.banks.map((bank) => bank.lastSynced), ["Not synced yet", "Not synced yet"], "a bank never synced says so");
    eq(view.banks.map((bank) => bank.needsAttention), [false, false], "and neither needs attention");
    eq(view.canSync, true, "there are real banks, so a sync is offered");
  }
}

// ===========================================================================
// The awkward rows
// ===========================================================================

{
  const view = presentAccounts({
    state: "ready",
    rows: [
      // A bank with no accounts arrives as one row with the account columns empty.
      row({ item_id: "item-empty", institution_name: "Empty Bank", account_id: null, account_name: null, mask: null, type: null, subtype: null, currency: null, current_balance: null, balance_updated_at: null }),
      row({ item_id: "item-odd", institution_name: null, source: "seed", account_id: "acct-odd", account_name: null, mask: null, type: "loan", subtype: null, currency: null, current_balance: null }),
    ],
  });
  if (view.state === "ready") {
    eq(view.banks.map((bank) => bank.name), ["Empty Bank", "Unnamed bank"], "a bank with no name is still listed");
    eq(view.banks[0]?.accounts, [], "A BANK WITH NO ACCOUNTS IS STILL A BANK, with none");
    eq(view.banks[1]?.sample, true, "SEEDED DATA IS MARKED AS SAMPLE DATA");
    eq(
      view.banks[1]?.accounts[0],
      { id: "acct-odd", name: "Unnamed account", type: "Loan", lastFour: "", balance: "—" },
      "missing name, last four and balance each have something honest to show",
    );
    eq(view.banks[1]?.lastSynced, "", "sample data says nothing about syncing: it never is");
  } else ok(false, "awkward rows: a ready view");
}

// ===========================================================================
// Syncing: when, whether, and who needs attention
// ===========================================================================

{
  const SYNCED = new Date("2026-05-06T07:08:00Z");
  const view = presentAccounts({
    state: "ready",
    rows: [
      row({ item_id: "synced", last_synced_at: SYNCED, never_synced: false }),
      row({ item_id: "expired", institution_name: "Expired Bank", account_id: "acct-x", status: "login_required", last_synced_at: SYNCED, never_synced: false }),
    ],
  });
  if (view.state === "ready") {
    eq(view.banks[0]?.lastSynced, `Last synced ${formatWhen(SYNCED)}`, "a synced bank says when");
    eq(view.banks.map((bank) => bank.needsAttention), [false, true], "A BANK WHOSE LOGIN HAS EXPIRED NEEDS ATTENTION");
    eq(view.canSync, true, "one working bank is enough to offer a sync");
  } else ok(false, "syncing: a ready view");
}
{
  const onlyExpired = presentAccounts({ state: "ready", rows: [row({ status: "login_required" })] });
  eq(onlyExpired.state === "ready" && onlyExpired.canSync, false, "with every bank needing attention there is nothing a sync would do");

  const onlySample = presentAccounts({ state: "ready", rows: [row({ source: "seed" })] });
  eq(onlySample.state === "ready" && onlySample.canSync, false, "SAMPLE DATA ALONE OFFERS NO SYNC");
  eq(onlySample.state === "ready" && onlySample.banks[0]?.needsAttention, false, "and sample data never needs attention");

  const flaggedSample = presentAccounts({ state: "ready", rows: [row({ source: "seed", status: "login_required" })] });
  eq(flaggedSample.state === "ready" && flaggedSample.banks[0]?.needsAttention, false, "even if its row said so");
}

eq(formatBalance(null, "USD"), "—", "NO BALANCE IS A DASH, NOT ZERO");
eq(formatBalance("0", "USD"), usd(0), "a zero balance is shown as zero");
eq(formatBalance("-42.10", "USD"), usd(-42.1), "a negative balance keeps its sign");
eq(formatBalance("not a number", "USD"), "—", "a balance that is not a number is a dash");
eq(formatBalance("12.5", null), new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(12.5), "no currency: the plain number");
eq(formatBalance("12.5", "NOT-A-CODE"), new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(12.5), "an unknown currency code: the plain number, no crash");

// ===========================================================================
// Every problem has both halves, and none is CLI wording
// ===========================================================================

eq(problems.filter((p) => p.cause.trim() === "" || p.nextStep.trim() === ""), [], `${problems.length} problems, each with a cause and a next step`);

const CLI_WORDING = /costingly\s+(init|migrate|status|stop|sync|link|unlink|uninstall|reset|seed)\b|`|Claude Desktop/;
eq(
  problems.flatMap((p) => [p.cause, p.nextStep]).filter((line) => CLI_WORDING.test(line)),
  [],
  "and none tells the user to run a command",
);

console.log(out.join("\n"));
console.log(fail === 0 ? `\nAll ${out.length} checks passed.` : `\n${fail} FAILED.`);
process.exit(fail === 0 ? 0 : 1);
