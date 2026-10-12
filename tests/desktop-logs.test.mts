/**
 * The Logs screen, driven through the window.
 *
 *   1. What it shows: the app log with the app starting, a time on each line,
 *      and the file's location; the database log and its location
 *   2. Refresh: stopping and starting the database from Status leaves two new
 *      lines, which Refresh shows
 *   3. Copy: the shown lines land on the clipboard, read back through
 *      Electron's clipboard in the main process
 *   4. The Report tab: the version, the profile, the database, Plaid, the
 *      banks, both logs — and nothing secret — shown, and copied as shown
 *   5. The database log grown past its cap is trimmed at launch
 *
 * THIS SUITE OVERWRITES THE CLIPBOARD of whoever runs it: Copy is what it
 * tests.
 *
 * Windows-only, like the app. Skips elsewhere.
 */

import { readFileSync, statSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
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
  ROOT,
  skipUnlessWindows,
  until,
} from "./desktop-harness.mjs";

skipUnlessWindows();

const HOME = join(tmpdir(), "costingly-desktop-logs-test");
const DESKTOP = `${HOME}-desktop`;
process.env["COSTINGLY_HOME"] = HOME;

delete process.env["PLAID_CLIENT_ID"];
delete process.env["PLAID_SECRET"];
delete process.env["PLAID_ENV"];

const { closeDb, configStore, generateEncryptionKey, server, writeConfig } = await import("../src/index.js");
const { install } = await import("../src/domain/services/install.service.js");

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

const VERSION = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;
const APP_LOG = join(DESKTOP, "costingly.log");
const SECRET = "placeholder-secret-value-xyz";
const LINE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} (INFO |WARN |ERROR) /;

async function open(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launch(HOME);
  const page = await app.firstWindow();
  await page.getByRole("navigation", { name: "Screens" }).waitFor({ timeout: 30_000 });
  return { app, page };
}

async function goToLogs(page: Page, which: "app" | "database" = "app"): Promise<void> {
  await page.getByTestId("nav-logs").click();
  await page.getByTestId(`logs-tab-${which}`).click();
  await page.locator(`[data-testid='logs-screen'][data-log='${which}'][data-state='loaded']`).waitFor({ timeout: 15_000 });
}

const shownLines = async (page: Page): Promise<string[]> =>
  ((await page.getByTestId("logs-lines").textContent()) ?? "").split("\n").filter((line) => line !== "");

const clipboard = (app: ElectronApplication): Promise<string> => app.evaluate(({ clipboard: c }) => c.readText());

await writeConfig({
  plaidClientId: "placeholder-client-id",
  plaidSecret: SECRET,
  encryptionKey: generateEncryptionKey(),
});
await install();
await closeDb();
await server.stop();
const logins = configStore.readDatabaseLogins();
ok(logins !== undefined, "the throwaway database has generated passwords to keep out of everything");

try {
  // =========================================================================
  // 1. What it shows
  // =========================================================================

  let { app, page } = await open();
  eq(
    await page.getByRole("navigation", { name: "Screens" }).getByRole("button").allInnerTexts(),
    ["Status", "Accounts", "Transactions", "Settings", "Logs"],
    "the sidebar lists Logs last, below Settings",
  );
  await expectHeadline(checks, page, "database", /^Running$/, "the database is Running");

  await goToLogs(page, "app");
  let lines = await shownLines(page);
  ok(lines.length >= 2, `THE APP LOG IS SHOWN (${lines.length} lines)`);
  ok(lines.some((line) => line.includes(`Costingly ${VERSION} starting`)), "with a line for the app starting, naming the version");
  ok(lines.some((line) => line.includes("the database started")), "and one for the database starting");
  ok(lines.every((line) => LINE.test(line)), "a time and a level on every line");
  const appPath = (await page.getByTestId("logs-path").textContent()) ?? "";
  ok(appPath.includes("costingly-desktop-logs-test-desktop") && appPath.endsWith("costingly.log"), `and where the file is: under the app's own folder (${appPath})`);

  await goToLogs(page, "database");
  lines = await shownLines(page);
  ok(lines.length >= 1, `THE DATABASE LOG IS SHOWN (${lines.length} lines)`);
  ok(lines.some((line) => /database system is ready|starting PostgreSQL/.test(line)), "with the database's own lines");
  const dbPath = (await page.getByTestId("logs-path").textContent()) ?? "";
  ok(/costingly-desktop-logs-test\\pg\d+\.log$/.test(dbPath), `and where its file is, in the profile (${dbPath})`);

  // =========================================================================
  // 2. Refresh
  // =========================================================================

  await page.getByTestId("nav-status").click();
  await page.getByTestId("database-action-stop").click();
  await expectHeadline(checks, page, "database", /^Stopped$/, "Stop: the database is Stopped");
  await page.getByTestId("database-action-start").click();
  await expectHeadline(checks, page, "database", /^Running$/, "Start: and Running again");

  await goToLogs(page, "app");
  const before = await shownLines(page);
  // The screen was just opened, so it is already fresh; press Refresh anyway
  // — that is what a person does — and check the lines are there either way.
  await page.getByTestId("logs-refresh").click();
  await page.locator("[data-testid='logs-screen'][data-state='loaded']").waitFor({ timeout: 15_000 });
  const after = await shownLines(page);
  ok(after.length >= before.length, "Refresh re-reads the log");
  eq(after.filter((line) => line.includes("the database stopped")).length, 1, "THE STOP LEFT A LINE");
  eq(after.filter((line) => line.includes("the database started")).length, 2, "and so did the start — one at launch, one now");
  ok(after.every((line) => !line.includes(SECRET)), "the Plaid secret appears nowhere");

  // =========================================================================
  // 3. Copy
  // =========================================================================

  await app.evaluate(({ clipboard: c }) => c.writeText("something else entirely"));
  await page.getByTestId("logs-copy").click();
  await expectVisible(checks, page.getByTestId("logs-copied"), "Copy confirms itself");
  const copied = await clipboard(app);
  eq(copied.split("\n").filter((line) => line !== ""), await shownLines(page), "AND THE CLIPBOARD HOLDS EXACTLY THE SHOWN LINES");
  ok(copied.endsWith("\n"), "ending with a line break, ready to paste");

  // =========================================================================
  // 4. The Report tab
  // =========================================================================

  eq(await page.getByTestId("logs-copy-report").count(), 0, "there is no button that copies a report unseen");
  await page.getByTestId("logs-tab-report").click();
  await page.locator("[data-testid='logs-screen'][data-log='report'][data-state='loaded']").waitFor({ timeout: 45_000 });
  const shownReport = (await page.getByTestId("logs-report").textContent()) ?? "";
  ok(shownReport.startsWith(`Costingly ${VERSION}`), "THE REPORT TAB SHOWS THE REPORT, to be read before it is sent");
  eq(await page.getByTestId("logs-lines").count(), 0, "and not a log's lines under the Report tab");

  await app.evaluate(({ clipboard: c }) => c.writeText("something else entirely"));
  await page.getByTestId("logs-copy").click();
  await expectVisible(checks, page.getByTestId("logs-copied"), "Copy, on the Report tab, confirms itself", 45_000);
  const report = (await clipboard(app)).replace(/\r\n/g, "\n");
  eq(report, (await page.getByTestId("logs-report").textContent()) ?? "", "AND THE CLIPBOARD HOLDS EXACTLY THE REPORT SHOWN");
  ok(report.startsWith(`Costingly ${VERSION}`), "THE REPORT names the version first");
  ok(report.includes("== Profile ==") && report.includes("costingly-desktop-logs-test"), "the profile and where it is");
  ok(/== Database ==\nState: running/.test(report), "the database, running");
  ok(/Connection: answered in \d+ ms/.test(report), "and answering");
  ok(/Keys: present/.test(report), "Plaid keys present");
  ok(/Plaid: (answered|did not answer)/.test(report), "and whether Plaid answered — placeholder keys, so either");
  ok(report.includes("No banks are linked."), "no banks on this profile, said");
  ok(report.includes("== App log") && report.includes(`Costingly ${VERSION} starting`), "the app log's lines");
  ok(report.includes("== Database log") && /database system is ready|starting PostgreSQL/.test(report), "and the database log's lines");
  ok(!report.includes(SECRET), "AND NOT THE PLAID SECRET");
  ok(logins === undefined || (!report.includes(logins.superuser.password) && !report.includes(logins.app.password)), "NOR A DATABASE PASSWORD");
  ok(report.includes("plaidSecret: set"), "the secret is reported as present, nothing more");

  eq(await quit(app), 0, "Quit, exit code 0");
  ok(await until(() => /Costingly stopped/.test(readFileSync(APP_LOG, "utf8")), 10_000), "and the last line of the app log says the app stopped");

  // =========================================================================
  // 5. A database log past its cap is trimmed at launch
  // =========================================================================

  const dbLog = server.logPath();
  const filler = Array.from({ length: 60_000 }, (_, i) => `2026-01-01 00:00:00.000 EDT [1] LOG:  old line ${i} ${"x".repeat(60)}`).join("\n") + "\n";
  await writeFile(dbLog, filler);
  const grown = statSync(dbLog).size;
  ok(grown > 5 * 1024 * 1024, `the database log was grown past its cap (${(grown / 1024 / 1024).toFixed(1)} MB)`);

  ({ app, page } = await open());
  await expectHeadline(checks, page, "database", /^Running$/, "the app launches and the database is Running");
  const trimmed = statSync(dbLog).size;
  ok(trimmed <= 5 * 1024 * 1024, `AND THE DATABASE LOG IS UNDER ITS CAP (${(trimmed / 1024 / 1024).toFixed(1)} MB)`);
  const content = readFileSync(dbLog, "utf8");
  ok(content.includes("old line 59999"), "the newest old line survived");
  ok(!content.includes("old line 0 "), "and the oldest did not");
  ok(readFileSync(APP_LOG, "utf8").includes("the database log was over its cap and was trimmed"), "the app log says the trim happened");

  await goToLogs(page, "database");
  lines = await shownLines(page);
  ok(lines.length === 500, `the Logs screen still opens, showing the last 500 lines (${lines.length})`);

  eq(await quit(app), 0, "Quit, exit code 0");
} finally {
  await wipe();
}

checks.finish();
