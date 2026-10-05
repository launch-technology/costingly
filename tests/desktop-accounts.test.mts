/**
 * The Accounts screen, driven through the window against a real database.
 *
 *   1. With no banks: the explanation and the Link a bank button
 *   2. Banks and accounts are listed, grouped, with what each account shows
 *   3. They are still there after quitting and reopening
 *   4. A stopped database is explained, and the accounts come back with it
 *
 * WHAT THIS DOES NOT DO IS CLICK "LINK A BANK". That button opens the real
 * default browser on whoever is running the suite, and from there linking
 * means a real bank on Plaid's production servers. So the button is checked
 * for being offered, and the banks here are the seed generator's invented
 * ones, put in the database directly. That the link page behind the button
 * is really served, and really stops, is desktop-services.test.mts; the
 * exchange against Plaid's sandbox is e2e.test.mts; a real bank is a manual
 * check.
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

skipUnlessWindows();

const HOME = join(tmpdir(), "costingly-desktop-accounts-test");
const DESKTOP = `${HOME}-desktop`;
process.env["COSTINGLY_HOME"] = HOME;

delete process.env["PLAID_CLIENT_ID"];
delete process.env["PLAID_SECRET"];
delete process.env["PLAID_ENV"];

const { closeDb, generateEncryptionKey, server, writeConfig } = await import("../src/index.js");
const { install } = await import("../src/domain/services/install.service.js");
const { generateSeedDataset } = await import("../src/domain/services/seed/seed.generator.js");
const { applySeed } = await import("../src/domain/services/seed/seed.service.js");

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

const screen = (page: Page) => page.getByTestId("accounts-screen");
const banks = (page: Page) => page.getByTestId("bank");
const linkButton = (page: Page) => page.getByTestId("link-bank");

async function open(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launch(HOME);
  const page = await app.firstWindow();
  await page.getByRole("navigation", { name: "Screens" }).waitFor({ timeout: 30_000 });
  return { app, page };
}

async function goToAccounts(page: Page): Promise<void> {
  await page.getByTestId("nav-accounts").click();
  await screen(page).waitFor({ timeout: 15_000 });
}

/** Wait for the screen to settle in one state, and record the outcome either way. */
async function expectState(page: Page, state: string, what: string): Promise<boolean> {
  return expectVisible(checks, page.locator(`[data-testid='accounts-screen'][data-state='${state}']`), what);
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
// 1. No banks
// ===========================================================================

let { app, page } = await open();

eq(
  await page.getByRole("navigation", { name: "Screens" }).getByRole("button").allInnerTexts(),
  ["Status", "Accounts"],
  "the sidebar lists Status, then Accounts",
);
await expectVisible(checks, page.getByTestId("status-screen"), "a set-up machine still opens on Status");

await goToAccounts(page);
await expectState(page, "empty", "Accounts with no banks: the empty state");
const explanation = (await page.getByTestId("accounts-empty").textContent()) ?? "";
ok(/No bank is linked yet/.test(explanation), "it says no bank is linked yet");
ok(/never to Costingly/.test(explanation), "and that the bank login does not go to Costingly");
eq(await linkButton(page).count(), 1, "with exactly one Link a bank button");
eq(await linkButton(page).textContent(), "Link a bank", "labelled Link a bank");
eq(await banks(page).count(), 0, "and no banks listed");
ok(/opens in\s+your web browser/.test(explanation), "and that linking opens in the web browser");
eq(await page.getByTestId("link-opened-note").count(), 0, "nothing claims a browser is open before the button is used");

eq(await quit(app), 0, "Quit, exit code 0");

// ===========================================================================
// 2. Banks and accounts
// ===========================================================================

const dataset = generateSeedDataset({ seed: 7, years: 1, endDate: "2026-08-09" });
await applySeed(dataset);
await closeDb();
await server.stop();
ok(dataset.items.length >= 2 && dataset.accounts.length >= 3, `sample data to show: ${dataset.items.length} banks, ${dataset.accounts.length} accounts`);

({ app, page } = await open());
await goToAccounts(page);
await expectState(page, "ready", "Accounts with banks: the list");

eq(await banks(page).count(), dataset.items.length, `every bank is listed (${dataset.items.length})`);
eq(
  (await page.getByTestId("bank-name").allInnerTexts()).sort(),
  dataset.items.map((item) => item.institutionName).sort(),
  "each under its own name",
);
eq(await page.getByTestId("account").count(), dataset.accounts.length, `with every account (${dataset.accounts.length})`);
eq(await page.getByTestId("bank-sample").count(), dataset.items.length, "and each marked as Sample data");

// One bank, checked against what was put in.
const item = dataset.items[0];
const expected = dataset.accounts.filter((account) => account.itemId === item?.itemId);
const card = banks(page).filter({ has: page.getByTestId("bank-name").getByText(item?.institutionName ?? "", { exact: true }) });
eq(
  (await card.getByTestId("account-name").allInnerTexts()).sort(),
  expected.map((account) => account.name).sort(),
  `${item?.institutionName}: its accounts, by name`,
);
const details = await card.getByTestId("account-detail").allInnerTexts();
ok(details.every((line) => /^\S.* · ••••\d{4}$/.test(line)), `each shows its type and last four digits (${details[0]})`);
const balances = await card.getByTestId("account-balance").allInnerTexts();
ok(balances.every((text) => /\d/.test(text)), `and a balance (${balances[0]})`);

const note = (await page.getByTestId("accounts-note").textContent()) ?? "";
ok(/^Balances as of .+\. Transactions are not pulled yet\.$/.test(note), `the screen says when balances were written: "${note}"`);
eq(await linkButton(page).count(), 1, "Link a bank is still offered, to add another");
eq(await page.getByTestId("accounts-empty").count(), 0, "and the no-banks explanation is gone");

// ===========================================================================
// 4. The database stopped, and started again
// ===========================================================================

await page.getByTestId("nav-status").click();
await expectHeadline(checks, page, "database", /^Running$/, "Status: the database is Running");
await page.getByTestId("database-action-stop").click();
await expectHeadline(checks, page, "database", /^Stopped$/, "stopped from Status");

await goToAccounts(page);
await expectState(page, "database-stopped", "Accounts with the database stopped: it says so");
const stopped = (await page.getByTestId("accounts-database-stopped").textContent()) ?? "";
ok(/not running/i.test(stopped) && /Status screen/.test(stopped), "and points to the Status screen");
eq(await linkButton(page).count(), 0, "NO LINK A BANK WHILE THERE IS NOWHERE TO SAVE ONE");
eq(await banks(page).count(), 0, "no stale list is shown");
eq(await server.status(), "stopped", "and looking at Accounts did not start the database");

await page.getByTestId("nav-status").click();
await page.getByTestId("database-action-start").click();
await expectHeadline(checks, page, "database", /^Running$/, "started again from Status");
await goToAccounts(page);
await expectState(page, "ready", "Accounts: the list is back");
eq(await banks(page).count(), dataset.items.length, "with every bank");

eq(await quit(app), 0, "Quit, exit code 0");

// ===========================================================================
// 3. Still there after quitting and reopening
// ===========================================================================

({ app, page } = await open());
await goToAccounts(page);
await expectState(page, "ready", "reopened: Accounts lists the banks");
eq(await banks(page).count(), dataset.items.length, "ALL OF THEM, AFTER A QUIT AND A RELAUNCH");
eq(await quit(app), 0, "Quit, exit code 0");
eq(await server.status(), "stopped", "and the database is stopped");

await wipe();
checks.finish();
