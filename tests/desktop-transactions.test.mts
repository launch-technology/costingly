/**
 * The Transactions screen, driven through the window against a real database
 * holding a small, known set of transactions.
 *
 *   1. With no bank, and with a bank but nothing synced: each says so
 *   2. It opens on the newest 100, with the total stated and no date set
 *   3. A row shows what it should; money in and pending are marked
 *   4. Account, dates and search each narrow the list, and narrow it together
 *   5. Show more adds the next hundred
 *   6. Nothing matching, and dates the wrong way round, each say so
 *   7. A stopped database is explained, and the list comes back with it
 *
 * The data is tests/transaction-fixture.mts, written into the database
 * directly — not the seed generator. What "matches" means is tested without a
 * window in transactions-search.test.mts; this is the screen on top of it.
 *
 * Windows-only, like the app. Skips elsewhere.
 */

import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Page } from "playwright";

import {
  buildDesktop,
  createChecks,
  expectHeadline,
  expectVisible,
  launch,
  quit,
  skipUnlessWindows,
} from "./desktop-harness.mjs";
import { CARD, FACTS, SAVINGS, saveFixture } from "./transaction-fixture.mjs";

skipUnlessWindows();

const HOME = join(tmpdir(), "costingly-desktop-transactions-test");
const DESKTOP = `${HOME}-desktop`;
process.env["COSTINGLY_HOME"] = HOME;

delete process.env["PLAID_CLIENT_ID"];
delete process.env["PLAID_SECRET"];
delete process.env["PLAID_ENV"];

const { closeDb, db, generateEncryptionKey, server, writeConfig } = await import("../src/index.js");
const { install } = await import("../src/domain/services/install.service.js");
const { saveItem } = await import("../src/domain/data/repositories/items.repository.js");
const { upsertMany: saveAccounts } = await import("../src/domain/data/repositories/accounts.repository.js");
const { upsertMany: saveTransactions } = await import("../src/domain/data/repositories/transactions.repository.js");
const { formatDay, formatMoney } = await import("../src/apps/desktop/main/presenters/format.js");

const checks = createChecks(10);
const { eq, ok } = checks;

async function wipe(): Promise<void> {
  await closeDb().catch(() => {});
  await server.stop().catch(() => {});
  for (const dir of [HOME, DESKTOP]) {
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
}
await wipe();
await buildDesktop(checks);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const rows = (page: Page) => page.getByTestId("transaction");
const count = (page: Page) => page.getByTestId("transactions-count");

async function open(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launch(HOME);
  const page = await app.firstWindow();
  await page.getByRole("navigation", { name: "Screens" }).waitFor({ timeout: 30_000 });
  return { app, page };
}

async function goToTransactions(page: Page): Promise<void> {
  await page.getByTestId("nav-transactions").click();
  await page.getByTestId("transactions-screen").waitFor({ timeout: 15_000 });
}

/** Wait for the screen to settle in one state with nothing on its way, and record the outcome. */
async function expectState(page: Page, state: string, what: string): Promise<boolean> {
  return expectVisible(
    checks,
    page.locator(`[data-testid='transactions-screen'][data-state='${state}'][data-refreshing='false']`),
    what,
  );
}

/** Wait for the count line to say exactly this, and record the outcome either way. */
async function expectCount(page: Page, text: string, what: string): Promise<void> {
  try {
    await count(page).filter({ hasText: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }).waitFor({ timeout: 15_000 });
    ok(true, what);
  } catch {
    eq(await count(page).textContent().catch(() => "<no count line>"), text, what);
  }
}

/** Quit the app, change the database behind it, and leave it stopped for the next launch. */
async function whileClosed(change: () => Promise<void>): Promise<void> {
  await server.start();
  await change();
  await closeDb();
  await server.stop();
}

// ---------------------------------------------------------------------------
// A set-up machine with no banks
// ---------------------------------------------------------------------------

await writeConfig({
  plaidClientId: "placeholder-client-id",
  plaidSecret: "placeholder-secret",
  encryptionKey: generateEncryptionKey(),
});
await install();
await closeDb();
await server.stop();

// ===========================================================================
// 1. Nothing to show, and why
// ===========================================================================

let { app, page } = await open();
eq(
  await page.getByRole("navigation", { name: "Screens" }).getByRole("button").allInnerTexts(),
  ["Status", "Accounts", "Transactions", "Settings"],
  "the sidebar lists Transactions below Accounts",
);

await goToTransactions(page);
await expectState(page, "no-banks", "with no bank linked: the screen says so");
ok(/Accounts screen/.test((await page.getByTestId("transactions-no-banks").textContent()) ?? ""), "and points to the Accounts screen");
eq(await page.getByTestId("transaction-filters").count(), 0, "with no filters to fiddle with: there is nothing to filter");
eq(await quit(app), 0, "Quit, exit code 0");

await whileClosed(async () => {
  await saveItem(db, { itemId: "fx-early", institutionId: null, institutionName: "Early Bank", source: "plaid", accessToken: "access-fixture" });
});
({ app, page } = await open());
await goToTransactions(page);
await expectState(page, "nothing-synced", "with a bank but no transactions: NOTHING SYNCED YET, not 'no bank'");
ok(/Sync your banks from the Accounts screen/.test((await page.getByTestId("transactions-nothing-synced").textContent()) ?? ""), "and it points to Sync on the Accounts screen");
eq(await quit(app), 0, "Quit, exit code 0");

await whileClosed(async () => {
  await db.query(`DELETE FROM items WHERE item_id = 'fx-early'`);
  await saveFixture({
    saveItem: (params) => saveItem(db, params),
    saveAccounts: (accounts) => saveAccounts(db, accounts),
    saveTransactions: (transactions) => saveTransactions(db, transactions),
  });
});

// ===========================================================================
// 2. The newest hundred
// ===========================================================================

({ app, page } = await open());
await goToTransactions(page);
await expectState(page, "rows", "with transactions: the list");

await expectCount(page, `Showing the newest 100 of ${FACTS.total} transactions`, `IT OPENS ON THE NEWEST 100, and says how many there are (${FACTS.total})`);
eq(await rows(page).count(), 100, "one hundred rows");
eq(
  [await page.getByTestId("filter-account").inputValue(), await page.getByTestId("filter-from").inputValue(), await page.getByTestId("filter-to").inputValue(), await page.getByTestId("filter-text").inputValue()],
  ["", "", "", ""],
  "WITH NO FILTER SET — no account, no dates, no text",
);
eq(await page.getByTestId("filters-clear").count(), 0, "and so nothing to clear");

// ===========================================================================
// 3. A row
// ===========================================================================

const first = rows(page).first();
eq(await first.getByTestId("transaction-date").textContent(), formatDay(FACTS.newestDay), "NEWEST FIRST: the first row is the newest day");
eq(await first.getByTestId("transaction-description").textContent(), "Pizza Place", "its description is the merchant's name");
eq(await first.getByTestId("transaction-pending").textContent(), "Pending", "IT IS MARKED PENDING");
eq(await first.getByTestId("transaction-category").textContent(), "General merchandise", "its category is in plain words");
eq(await first.getByTestId("transaction-account").textContent(), "Rewards Card ••••2222", "its account is named with its last four digits");
eq(await first.getByTestId("transaction-amount").textContent(), formatMoney(-39, "USD"), "SPENDING IS SHOWN NEGATIVE");
eq(await page.getByTestId("transaction-pending").count(), 1, "and it is the only pending row");

const dates = await page.getByTestId("transaction-date").allInnerTexts();
eq(dates[1], formatDay("2026-08-19"), "the next row is the day before");

// ===========================================================================
// 4. Narrowing
// ===========================================================================

// --- by account ---
const options = await page.getByTestId("filter-account").locator("option").allInnerTexts();
eq(
  options,
  ["All accounts", "Maple Bank — Everyday Checking ••••1111", "Maple Bank — Rewards Card ••••2222", "Oak Credit Union — Rainy Day ••••3333"],
  "the account filter offers all accounts, then each one named with its bank",
);

await page.getByTestId("filter-account").selectOption(SAVINGS);
await expectCount(page, `${FACTS.savings} transactions`, `choosing an account shows only its transactions (${FACTS.savings})`);
eq(await rows(page).count(), FACTS.savings, "all of them, with no Show more");
eq(await page.getByTestId("transactions-more").count(), 0, "and no Show more");
eq(
  [...new Set(await page.getByTestId("transaction-account").allInnerTexts())],
  ["Rainy Day ••••3333"],
  "every row is that account's",
);
eq(await rows(page).first().getByTestId("transaction-amount").textContent(), `+${formatMoney(2500, "USD")}`, "MONEY IN IS SHOWN POSITIVE, with a plus");
eq(await rows(page).first().getAttribute("data-money-in"), "true", "and is marked as money in");
eq(await rows(page).first().getByTestId("transaction-description").textContent(), "PAYROLL DEPOSIT", "with no merchant name, the bank's own text is the description");
eq((await page.getByTestId("transaction-category").allInnerTexts()).filter((text) => text === "").length, 1, "a transaction with no category shows none");
eq(await page.getByTestId("filters-clear").count(), 1, "a filter is set, so Clear filters appears");

// --- by date ---
await page.getByTestId("filter-account").selectOption("");
await page.getByTestId("filter-from").fill(FACTS.quietDay);
await page.getByTestId("filter-to").fill(FACTS.quietDay);
await expectCount(page, "1 transaction", "from and to the same day: that day's one transaction — both dates included");
eq(await rows(page).first().getByTestId("transaction-date").textContent(), formatDay(FACTS.quietDay), "and it is that day's");

await page.getByTestId("filter-from").fill("2026-01-01");
await page.getByTestId("filter-to").fill("2026-01-31");
await expectCount(page, "31 transactions", "a month: its 31 transactions");

await page.getByTestId("filter-from").fill("");
await page.getByTestId("filter-to").fill("2026-01-10");
await expectCount(page, "10 transactions", "a To date alone: everything up to and including it");

// --- by text ---
await page.getByTestId("filter-to").fill("");
await page.getByTestId("filter-text").fill("corner COFFEE");
await expectCount(page, `Showing the newest 100 of ${FACTS.cornerCoffee} transactions`, `search matches the merchant name whatever the case (${FACTS.cornerCoffee})`);

await page.getByTestId("filter-text").fill("50%");
await expectCount(page, "1 transaction", "searching for 50% finds the one transaction with a percent sign");
eq(await rows(page).first().getByTestId("transaction-description").textContent(), "50% OFF OUTLET", "which is the right one");

// --- together ---
await page.getByTestId("filter-text").fill("pizza");
await page.getByTestId("filter-account").selectOption(CARD);
await page.getByTestId("filter-from").fill("2026-08-10");
await expectCount(page, "11 transactions", "ACCOUNT, DATE AND SEARCH NARROW TOGETHER");

// --- cleared ---
await page.getByTestId("filters-clear").click();
await expectCount(page, `Showing the newest 100 of ${FACTS.total} transactions`, "Clear filters brings the whole list back");
eq(
  [await page.getByTestId("filter-account").inputValue(), await page.getByTestId("filter-from").inputValue(), await page.getByTestId("filter-text").inputValue()],
  ["", "", ""],
  "with every filter emptied",
);

// ===========================================================================
// 5. Show more
// ===========================================================================

await page.getByTestId("transactions-more").click();
await expectCount(page, `Showing the newest 200 of ${FACTS.total} transactions`, "SHOW MORE ADDS THE NEXT HUNDRED");
eq(await rows(page).count(), 200, "two hundred rows");
eq(await rows(page).first().getByTestId("transaction-description").textContent(), "Pizza Place", "still starting from the newest");

await page.getByTestId("transactions-more").click();
await expectCount(page, `${FACTS.total} transactions`, `and again reaches all of them (${FACTS.total})`);
eq(await rows(page).count(), FACTS.total, "every row is shown");
eq(await page.getByTestId("transactions-more").count(), 0, "and Show more is gone");

await page.getByTestId("filter-text").fill("payroll");
await expectCount(page, `${FACTS.savings} transactions`, "changing a filter narrows the long list");
await page.getByTestId("filter-text").fill("");
await expectCount(page, `Showing the newest 100 of ${FACTS.total} transactions`, "AND A CHANGED FILTER STARTS AGAIN FROM THE NEWEST HUNDRED");

// ===========================================================================
// 6. Nothing matching, and dates the wrong way round
// ===========================================================================

await page.getByTestId("filter-text").fill("no merchant is called this");
await expectState(page, "no-match", "a search that matches nothing: the screen says so");
ok(/No transactions match/.test((await page.getByTestId("transactions-no-match").textContent()) ?? ""), "in those words");
eq(
  await page.getByTestId("transactions-no-match-hint").textContent(),
  `Your most recent transaction is from ${formatDay(FACTS.newestDay)}. `,
  "and says when the most recent transaction is",
);
eq(await rows(page).count(), 0, "with no rows");
eq(await page.getByTestId("transaction-filters").count(), 1, "THE FILTERS STAY, so the search can be changed");
await page.getByTestId("transactions-no-match-clear").click();
await expectState(page, "rows", "Clear filters, from the message, brings the list back");

await page.getByTestId("filter-from").fill("2026-06-01");
await page.getByTestId("filter-to").fill("2026-05-01");
await expectState(page, "invalid-range", "From after To: the screen says the dates are the wrong way round");
eq(await rows(page).count(), 0, "and shows nothing");
await page.getByTestId("filter-to").fill("2026-06-30");
// June: thirty daily checking rows and one payroll deposit.
await expectCount(page, "31 transactions", "corrected, the list returns");
await page.getByTestId("filters-clear").click();
await expectState(page, "rows", "filters cleared");

// ===========================================================================
// 7. The database stopped, and started again
// ===========================================================================

await page.getByTestId("nav-status").click();
await page.getByTestId("database-action-stop").click();
await expectHeadline(checks, page, "database", /^Stopped$/, "the database is stopped from Status");

await goToTransactions(page);
await expectState(page, "database-stopped", "Transactions with the database stopped: it says so");
ok(/Status screen/.test((await page.getByTestId("transactions-database-stopped").textContent()) ?? ""), "and points to the Status screen");
eq([await rows(page).count(), await page.getByTestId("transaction-filters").count()], [0, 0], "no stale list and no filters");
eq(await server.status(), "stopped", "and looking at Transactions did not start the database");

await page.getByTestId("nav-status").click();
await page.getByTestId("database-action-start").click();
await expectHeadline(checks, page, "database", /^Running$/, "started again from Status");
await goToTransactions(page);
await expectCount(page, `Showing the newest 100 of ${FACTS.total} transactions`, "Transactions: the list is back");

eq(await quit(app), 0, "Quit, exit code 0");
eq(await server.status(), "stopped", "and the database is stopped");

await wipe();
checks.finish();
