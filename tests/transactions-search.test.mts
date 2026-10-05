/**
 * Finding transactions — the shared operation every interface that lists
 * them uses — against a real database holding a small, known set.
 *
 *   1. With no filter: the newest, up to the limit, and the full count
 *   2. By account
 *   3. By date: either end, both ends, and both ends INCLUDED
 *   4. By text: description or merchant, any case, and % and _ as themselves
 *   5. Filters together
 *   6. The limit: more rows, never different ones
 *   7. What it says when there is nothing: no banks, no transactions, no match
 *   8. What it refuses
 *
 * Runs on every platform. The data is tests/transaction-fixture.mts, written
 * in directly; nothing here uses the seed generator.
 */

import { rm } from "node:fs/promises";

import { CARD, CHECKING, FACTS, SAVINGS, saveFixture } from "./transaction-fixture.mjs";

const HOME = "/tmp/costingly-txn-search";
process.env["COSTINGLY_HOME"] = HOME;
delete process.env["PLAID_CLIENT_ID"];
delete process.env["PLAID_SECRET"];

const { db, closeDb, server } = await import("../src/index.js");
const { install } = await import("../src/domain/services/install.service.js");
const { saveItem } = await import("../src/domain/data/repositories/items.repository.js");
const { upsertMany: saveAccounts } = await import("../src/domain/data/repositories/accounts.repository.js");
const { upsertMany: saveTransactions } = await import("../src/domain/data/repositories/transactions.repository.js");
const { DEFAULT_TRANSACTION_LIMIT, MAX_TRANSACTION_LIMIT, findTransactions } = await import(
  "../src/domain/services/transactions/transaction-search.service.js"
);
type TransactionFilter = import("../src/domain/services/transactions/transaction-search.service.js").TransactionFilter;

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

async function wipe(): Promise<void> {
  await closeDb().catch(() => {});
  await server.stop().catch(() => {});
  await rm(HOME, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}

const ANY: TransactionFilter = { accountId: null, from: null, to: null, text: "", limit: DEFAULT_TRANSACTION_LIMIT };
async function find(change: Partial<TransactionFilter> = {}) {
  const found = await findTransactions({ ...ANY, ...change });
  if (found.outcome !== "found") throw new Error(`expected matches, got ${found.outcome}`);
  return found;
}

await wipe();
await install();

// ===========================================================================
// 7a. Nothing at all
// ===========================================================================

{
  const empty = await find();
  eq([empty.rows.length, empty.total], [0, 0], "an empty database: no rows, none counted");
  eq([empty.banks, empty.stored, empty.newest], [0, 0, null], "and it says so: NO BANKS, no transactions, no newest date");
}

await saveItem(db, { itemId: "fx-lonely", institutionId: null, institutionName: "Lonely Bank", source: "plaid", accessToken: "access-fixture" });
{
  const unsynced = await find();
  eq([unsynced.banks, unsynced.stored], [1, 0], "A BANK WITH NOTHING SYNCED is told apart from no bank at all");
}
await db.query(`DELETE FROM items WHERE item_id = 'fx-lonely'`);

await saveFixture({
  saveItem: (params) => saveItem(db, params),
  saveAccounts: (rows) => saveAccounts(db, rows),
  saveTransactions: (rows) => saveTransactions(db, rows),
});

// ===========================================================================
// 1. No filter
// ===========================================================================

const everything = await find();
eq(everything.total, FACTS.total, `no filter: every transaction is counted (${FACTS.total})`);
eq(everything.rows.length, DEFAULT_TRANSACTION_LIMIT, `but only the limit is returned (${DEFAULT_TRANSACTION_LIMIT})`);
eq(everything.rows[0]?.date, FACTS.newestDay, "NEWEST FIRST");
ok(
  everything.rows.every((row, index, rows) => index === 0 || (rows[index - 1]?.date ?? "") >= row.date),
  "and in date order all the way down",
);
eq([everything.banks, everything.stored, everything.newest], [2, FACTS.total, FACTS.newestDay], "it also says how many banks, how many transactions in all, and the newest day");

{
  const first = everything.rows[0];
  eq(first?.pending, true, "the pending transaction on the newest day comes first");
  eq(
    [first?.name, first?.merchant_name, first?.account_name, first?.mask, first?.institution_name, first?.currency, first?.category],
    ["PENDING PIZZA ORDER", "Pizza Place", "Rewards Card", "2222", "Maple Bank", "USD", "GENERAL_MERCHANDISE"],
    "a row carries its description, merchant, account, last four, bank, currency and category",
  );
  ok(typeof first?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(first.date), "and its date as a calendar-day string");
}

// ===========================================================================
// 2. By account
// ===========================================================================

{
  const card = await find({ accountId: CARD });
  eq([card.total, card.rows.length], [FACTS.card, FACTS.card], `one account: only its transactions (${FACTS.card})`);
  ok(card.rows.every((row) => row.account_id === CARD), "every row is that account's");
  eq([card.stored, card.newest], [FACTS.card, FACTS.newestDay], "and the totals are that account's too");

  const savings = await find({ accountId: SAVINGS });
  eq(savings.total, FACTS.savings, `another account, its own count (${FACTS.savings})`);
  ok(savings.rows.every((row) => Number(row.amount) < 0), "money IN is stored negative, and comes back as stored");
  eq(savings.rows.filter((row) => row.category === null).length, 1, "a transaction with no category comes back with none");

  eq((await find({ accountId: "" })).total, FACTS.total, "an empty account id means every account");
  eq((await find({ accountId: "no-such-account" })).total, 0, "an account that does not exist matches nothing");
}

// ===========================================================================
// 3. By date
// ===========================================================================

{
  const oneDay = await find({ from: FACTS.quietDay, to: FACTS.quietDay });
  eq(oneDay.total, 1, "from and to the same day: that day's one transaction — BOTH ENDS ARE INCLUDED");
  eq(oneDay.rows[0]?.date, FACTS.quietDay, "and it is that day's");

  const firstTen = await find({ to: "2026-01-10" });
  eq(firstTen.total, 10, "to only: everything up to and including that day");
  const lastDays = await find({ from: FACTS.newestDay });
  eq(lastDays.total, 1, "from only: everything from that day on");

  const january = await find({ from: "2026-01-01", to: "2026-01-31", limit: 500 });
  eq(january.total, 31, "a month: its 31 transactions");
  eq([january.rows[0]?.date, january.rows.at(-1)?.date], ["2026-01-31", "2026-01-01"], "newest first, both end days present");

  eq((await find({ from: "2030-01-01" })).total, 0, "a range after everything matches nothing");
  eq(await findTransactions({ ...ANY, from: "2026-02-01", to: "2026-01-01" }), { outcome: "invalid-range" }, "FROM AFTER TO IS SAID AS THAT, not as an empty list");
}

// ===========================================================================
// 4. By text
// ===========================================================================

{
  eq((await find({ text: "Corner Coffee" })).total, FACTS.cornerCoffee, "text matches the MERCHANT NAME");
  eq((await find({ text: "corner coffee" })).total, FACTS.cornerCoffee, "WHATEVER THE CASE");
  eq((await find({ text: "POS DEBIT" })).total, FACTS.checking, "and the bank's own DESCRIPTION");
  eq((await find({ text: "shop #7" })).total, 11, "anywhere inside it (#7, #70 to #79)");
  eq((await find({ text: "  payroll  " })).total, FACTS.savings, "surrounding spaces are ignored");
  eq((await find({ text: "   " })).total, FACTS.total, "text that is only spaces is no filter");
  eq((await find({ text: "no such merchant anywhere" })).total, 0, "text nothing contains matches nothing");

  const percent = await find({ text: "50%" });
  eq(percent.rows.map((row) => row.name), ["50% OFF OUTLET"], "A % IS A PERCENT SIGN, not 'anything'");
  const underscore = await find({ text: "SAVE_MORE" });
  eq(underscore.rows.map((row) => row.name), ["SAVE_MORE MART"], "AN _ IS AN UNDERSCORE, not 'any character'");
  eq((await find({ text: "%" })).total, 1, "a lone % finds only the transaction that contains one");
  eq((await find({ text: "!" })).total, 0, "and the escape character itself is just a character");
}

// ===========================================================================
// 5. Together
// ===========================================================================

{
  const combined = await find({ accountId: CHECKING, from: "2026-01-01", to: "2026-01-10", text: "corner" });
  eq(combined.total, 5, "account AND dates AND text narrow together");
  eq((await find({ accountId: SAVINGS, text: "coffee" })).total, 0, "text from one account does not match in another");

  const outside = await find({ accountId: CHECKING, from: "2027-01-01" });
  eq([outside.total, outside.stored, outside.newest], [0, FACTS.checking, FACTS.checkingNewestDay], "NOTHING IN RANGE is told apart from nothing at all: the account's own count and newest day come back");
}

// ===========================================================================
// 6. The limit
// ===========================================================================

{
  const hundred = await find({ limit: 100 });
  const twoHundred = await find({ limit: 200 });
  eq(twoHundred.rows.length, 200, "a larger limit returns more");
  eq(
    twoHundred.rows.slice(0, 100).map((row) => row.transaction_id),
    hundred.rows.map((row) => row.transaction_id),
    "THE SAME ROWS FIRST, then the next — the list grows, it does not reshuffle",
  );
  eq(new Set(twoHundred.rows.map((row) => row.transaction_id)).size, 200, "with nothing repeated");
  eq((await find({ limit: 10_000 })).rows.length, FACTS.total, "a limit beyond everything returns everything");
  ok(MAX_TRANSACTION_LIMIT >= 1000, "the cap on one request is generous");
  eq((await find({ limit: 1 })).rows.length, 1, "and a limit of one returns one");
}

// ===========================================================================
// 8. What it refuses
// ===========================================================================

const refused = async (change: Partial<TransactionFilter>): Promise<string> =>
  findTransactions({ ...ANY, ...change }).then(
    () => "accepted",
    () => "refused",
  );
eq(await refused({ from: "01/02/2026" }), "refused", "a date that is not a calendar day is refused");
eq(await refused({ to: "2026-13-45" }), "refused", "so is a day that does not exist");
eq(await refused({ limit: 0 }), "refused", "and a limit of zero");
eq(await refused({ limit: 2.5 }), "refused", "and a limit that is not a whole number");
eq(await refused({ text: "'; DROP TABLE transactions; --" }), "accepted", "text that looks like SQL is only text");
eq((await find()).total, FACTS.total, "AND NOTHING HAPPENED TO THE TABLE");

await wipe();

console.log(out.join("\n"));
console.log(fail === 0 ? `\nAll ${out.length} checks passed.` : `\n${fail} FAILED.`);
process.exit(fail === 0 ? 0 : 1);
