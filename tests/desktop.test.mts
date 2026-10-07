/**
 * The desktop app's Status screen and its window, driven through Playwright.
 *
 * Runs against a machine that is set up — keys present, database created —
 * because that is the only machine on which the app shows Status at all; one
 * that is not set up gets the setup screen, which desktop-setup.test.mts
 * covers. The keys here are placeholders Plaid will reject, which is the point:
 * the Plaid section's trouble must stay in the Plaid section while the other
 * two report normally.
 *
 * What this cannot do: click the tray icon or see the balloon notice. Windows
 * draws those, not the app. Everything the tray does is still exercised here
 * through the same code paths (hide on close, show again, quit), and the
 * notice is proven by the setting it leaves behind.
 *
 * Windows-only, like the app. Skips elsewhere.
 */

import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildDesktop,
  closeWindow,
  createChecks,
  expectHeadline,
  launch,
  launchSecondCopy,
  quit,
  showWindow,
  skipUnlessWindows,
  until,
  windowVisible,
} from "./desktop-harness.mjs";

skipUnlessWindows();

const HOME = join(tmpdir(), "costingly-desktop-test");
/** Where the app keeps its own files for a moved profile — see desktop-paths.ts. */
const DESKTOP = `${HOME}-desktop`;
process.env["COSTINGLY_HOME"] = HOME;

// Explicitly absent, so the only keys in play are the placeholders below.
delete process.env["PLAID_CLIENT_ID"];
delete process.env["PLAID_SECRET"];
delete process.env["PLAID_ENV"];

const { closeDb, generateEncryptionKey, server, writeConfig } = await import("../src/index.js");
const { install } = await import("../src/domain/services/install.service.js");

const checks = createChecks();
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
// A set-up machine: keys present, database created
// ---------------------------------------------------------------------------

await writeConfig({
  plaidClientId: "placeholder-client-id",
  plaidSecret: "placeholder-secret",
  encryptionKey: generateEncryptionKey(),
});
await install();
await closeDb();
await server.stop();
eq(await server.status(), "stopped", "the throwaway database exists and is stopped before the app opens");

const app = await launch(HOME);
const page = await app.firstWindow();

// ===========================================================================
// 1. The Status screen
// ===========================================================================

const nav = page.getByRole("navigation", { name: "Screens" });
await nav.waitFor({ timeout: 30_000 });
eq(await page.getByTestId("setup-screen").count(), 0, "a set-up machine is not shown setup");
eq(
  await nav.getByRole("button").allTextContents(),
  ["Status", "Accounts", "Transactions", "Settings"],
  "the sidebar lists the screens that exist: Status, Accounts, Transactions",
);
eq(await page.getByTestId("status-screen").count(), 1, "and opens on Status");
eq(await page.locator("article[data-testid^='section-']").count(), 3, "the status screen has three sections");

await expectHeadline(checks, page, "profile", /^Set up$/, "profile: Set up");
await expectHeadline(checks, page, "database", /^Running$/, "database: Running — THE APP STARTED IT ON LAUNCH");
await expectHeadline(
  checks,
  page,
  "plaid",
  /^Keys present but Plaid could not be reached$/,
  "plaid: the placeholder keys are rejected, and only that section says so",
  45_000,
);

const database = (await page.getByTestId("section-database").textContent()) ?? "";
ok(database.includes("Listening on 127.0.0.1:"), "the database section says where it listens");
ok(database.includes("Schema version:"), "and names its schema version");
const profile = (await page.getByTestId("section-profile").textContent()) ?? "";
ok(profile.includes("Data folder:"), "the profile section says where the data lives");
const plaid = (await page.getByTestId("section-plaid").textContent()) ?? "";
ok(!/costingly\s+\w+|Claude Desktop/.test(plaid), "the Plaid section says nothing about commands or Claude Desktop");

ok(
  await until(async () => (await page.getByTestId("status-screen").getAttribute("data-checking")) === "false"),
  "all three checks finish",
);
eq(await page.getByRole("button", { name: "Refresh" }).isEnabled(), true, "and Refresh is available again");

// ===========================================================================
// 2. Refresh re-checks — and a report never repairs
// ===========================================================================

await server.stop();
await page.getByRole("button", { name: "Refresh" }).click();
await expectHeadline(checks, page, "database", /^Stopped$/, "Refresh re-checked: a database stopped behind its back is reported Stopped");
await expectHeadline(checks, page, "profile", /^Set up$/, "…while the profile section is unchanged");
eq(await server.status(), "stopped", "REPORTING DID NOT START IT");

// ===========================================================================
// 3. Closing hides; coming back re-checks
// ===========================================================================

await closeWindow(app);
ok(await until(async () => !(await windowVisible(app))), "closing the window hides it");
eq(app.process().exitCode, null, "and the app keeps running");

const settingsPath = join(DESKTOP, "settings.json");
ok(await until(() => existsSync(settingsPath)), "the first close writes the app's settings file");
const settings = JSON.parse(await readFile(settingsPath, "utf8")) as { closeNoticeShown?: boolean };
eq(settings.closeNoticeShown, true, "recording that the notice was shown");
eq(existsSync(join(HOME, "settings.json")), false, "in the app's own folder, not in the profile");

await server.start();
await showWindow(app);
ok(await until(() => windowVisible(app)), "the window comes back");
await expectHeadline(checks, page, "database", /^Running$/, "coming back re-checked: the database started meanwhile is reported Running");

// ===========================================================================
// 4. One copy
// ===========================================================================

const outcome = await launchSecondCopy(HOME);
ok(outcome !== "did not exit", `a second copy exits instead of opening a window (${outcome})`);
eq(
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
  1,
  "the first copy still has exactly one window",
);
ok(await until(() => windowVisible(app)), "and it is showing");
eq(await server.status(), "running", "and the second copy did not stop the first copy's database");

// ===========================================================================
// 5. Light and dark
// ===========================================================================

// As strings: this file is typed for node, and the DOM names only exist in
// the window where Playwright evaluates them.
const BODY_BACKGROUND = "getComputedStyle(document.body).backgroundColor";
await page.emulateMedia({ colorScheme: "light" });
const light = await page.evaluate<string>(BODY_BACKGROUND);
await page.emulateMedia({ colorScheme: "dark" });
const dark = await page.evaluate<string>(BODY_BACKGROUND);
ok(light !== dark, `the page follows the colour scheme (light ${light}, dark ${dark})`);

// ===========================================================================
// 6. Quit takes the database with it
// ===========================================================================

eq(await quit(app), 0, "Quit ends the process, exit code 0");
eq(await server.status(), "stopped", "QUIT STOPPED THE DATABASE");
eq(await server.isServing(), false, "and nothing is answering on its port");

await wipe();
checks.finish();
