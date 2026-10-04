/**
 * First-run setup, driven through the window.
 *
 * Four machines:
 *
 *   A. nothing set up          setup opens on the welcome, then the keys; bad
 *                              keys are refused and nothing is saved
 *   B. keys but no database    setup opens on the database step, creates it,
 *                              and from then on the app owns its lifetime
 *   C. database but no keys    setup opens on the welcome, then the keys
 *   D. …and real keys          accepted, saved, and no second database is made
 *
 * D needs keys Plaid will accept, so it reads the contributor's sandbox
 * profile and is left out — with a note — when there is none. A, B and C need
 * no credentials: A uses keys Plaid rejects, and B and C never ask Plaid at all.
 *
 * Not covered here, and checked by hand: the two links that open Plaid's pages
 * in the browser (running them would open a browser on every test run), and Plaid
 * being unreachable (desktop-services.test.mts hands the setup service a Plaid
 * that never answers; taking the real Plaid offline for a window test is not
 * something a suite can do).
 *
 * Windows-only, like the app. Skips elsewhere.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";

import {
  ROOT,
  buildDesktop,
  closeWindow,
  createChecks,
  expectHeadline,
  expectVisible,
  launch,
  quit,
  showWindow,
  skipUnlessWindows,
  until,
  windowVisible,
} from "./desktop-harness.mjs";

skipUnlessWindows();

const HOME = join(tmpdir(), "costingly-desktop-setup-test");
const DESKTOP = `${HOME}-desktop`;
const CONFIG = join(HOME, "config.json");
process.env["COSTINGLY_HOME"] = HOME;

delete process.env["PLAID_CLIENT_ID"];
delete process.env["PLAID_SECRET"];
delete process.env["PLAID_ENV"];

const { closeDb, generateEncryptionKey, server, writeConfig } = await import("../src/index.js");

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

/** Everything the window logs, so a leaked secret has nowhere to hide. */
function captureConsole(page: Page): string[] {
  const lines: string[] = [];
  page.on("console", (message) => lines.push(message.text()));
  page.on("pageerror", (error) => lines.push(error.message));
  return lines;
}

const setupScreen = (page: Page) => page.getByTestId("setup-screen");
const step = (page: Page) => setupScreen(page).getAttribute("data-step");
const sidebar = (page: Page) => page.getByRole("navigation", { name: "Screens" });

// ===========================================================================
// A. Nothing set up
// ===========================================================================

{
  const BOGUS_SECRET = "not-a-real-secret-4f9c1e";

  const app = await launch(HOME);
  const page = await app.firstWindow();
  const logged = captureConsole(page);

  await expectVisible(checks, setupScreen(page), "an unset machine opens on the setup screen");
  eq(await sidebar(page).count(), 0, "with no sidebar");
  eq(await page.getByTestId("status-screen").count(), 0, "and no Status screen");

  // --- the welcome comes first -----------------------------------------------
  eq(await step(page), "welcome", "starting with the welcome, not a form asking for keys");
  const welcome = (await page.getByTestId("welcome-step").textContent()) ?? "";
  ok(/Plaid account/.test(welcome), "which says a Plaid account is needed");
  eq(await page.getByTestId("welcome-plaid-link").count(), 1, "and offers a way to Plaid to get one");
  eq(await page.getByTestId("keys-step").count(), 0, "with no keys form yet");

  await page.getByTestId("welcome-continue").click();
  eq(await step(page), "keys", "continuing shows the keys step");
  await page.getByTestId("keys-back").click();
  eq(await step(page), "welcome", "Back returns to the welcome");
  await page.getByTestId("welcome-continue").click();
  eq(await page.getByTestId("keys-secret").getAttribute("type"), "password", "the secret field hides what is typed");

  // --- empty fields ----------------------------------------------------------
  await page.getByTestId("keys-submit").click();
  await expectVisible(checks, page.getByTestId("keys-client-id-required"), "an empty client ID is marked required");
  await expectVisible(checks, page.getByTestId("keys-secret-required"), "and so is an empty secret");
  eq(await page.getByTestId("keys-error").count(), 0, "and Plaid was not asked");

  // --- keys Plaid rejects ----------------------------------------------------
  await page.getByTestId("keys-client-id").fill("not-a-real-client-id");
  await page.getByTestId("keys-secret").fill(BOGUS_SECRET);
  await page.getByTestId("keys-submit").click();

  if (await expectVisible(checks, page.getByTestId("keys-error"), "rejected keys produce a message", 45_000)) {
    eq(await page.getByTestId("keys-error").getAttribute("data-kind"), "rejected", "it says rejected, not unreachable");
    const message = (await page.getByTestId("keys-error").textContent()) ?? "";
    ok(message.includes("Nothing was saved"), "it says nothing was saved");
    ok(message.includes("INVALID"), "and carries Plaid's own reason");
  }
  eq(await page.getByTestId("keys-secret").inputValue(), "", "the secret is cleared");
  eq(await page.getByTestId("keys-client-id").inputValue(), "not-a-real-client-id", "the client ID is kept");
  eq(await step(page), "keys", "and setup stays on the keys step");
  eq(existsSync(HOME), false, "NOTHING WAS SAVED — the profile still does not exist");

  ok(!(await page.locator("body").innerText()).includes(BOGUS_SECRET), "the secret is nowhere on screen");
  ok(!logged.some((line) => line.includes(BOGUS_SECRET)), "and nowhere in the window's console");

  // --- hiding to the tray keeps the step -------------------------------------
  await closeWindow(app);
  ok(await until(async () => !(await windowVisible(app))), "closing the window during setup hides it");
  await showWindow(app);
  ok(await until(() => windowVisible(app)), "and it comes back");
  eq(await step(page), "keys", "on the same step");
  eq(await page.getByTestId("keys-client-id").inputValue(), "not-a-real-client-id", "with the same client ID still typed");

  eq(await quit(app), 0, "Quit during setup ends the process, exit code 0");
  eq(await server.status(), "uninitialised", "and no database was created along the way");

  // --- relaunch resumes at the first incomplete step --------------------------
  const again = await launch(HOME);
  const againPage = await again.firstWindow();
  await expectVisible(checks, setupScreen(againPage), "relaunching after a rejection shows setup again");
  eq(await step(againPage), "welcome", "from the start, because nothing was saved");
  eq(await quit(again), 0, "Quit ends the process, exit code 0");
}

// ===========================================================================
// B. Keys but no database
// ===========================================================================

{
  await writeConfig({
    plaidClientId: "placeholder-client-id",
    plaidSecret: "placeholder-secret",
    encryptionKey: generateEncryptionKey(),
    plaidEnv: "production",
  });

  const app = await launch(HOME);
  const page = await app.firstWindow();

  await expectVisible(checks, setupScreen(page), "keys but no database: setup is shown");
  eq(await step(page), "database", "starting at the database step — the keys are not asked for again");
  eq(await page.getByTestId("keys-step").count(), 0, "with no keys form");

  const databaseStep = page.getByTestId("database-step");
  await expectVisible(checks, databaseStep, "the database step says it is working");
  ok(
    await until(async () => (await databaseStep.getAttribute("data-phase")) === "ready", 180_000),
    "and then that the database is ready",
  );
  eq(await page.getByTestId("database-error").count(), 0, "without an error");

  await page.getByTestId("database-continue").click();
  await expectVisible(checks, page.getByTestId("finish-step"), "Continue shows the finish step");
  const folder = (await page.getByTestId("finish-data-folder").textContent()) ?? "";
  ok(folder.includes("costingly-desktop-setup-test"), "which names the data folder");
  const note = (await page.getByTestId("finish-backup-note").textContent()) ?? "";
  ok(/back this folder up/i.test(note), "and says to back it up");

  await page.getByTestId("finish-continue").click();
  await expectVisible(checks, sidebar(page), "Continue shows the app, with its sidebar");
  eq(await setupScreen(page).count(), 0, "and setup is gone");
  await expectHeadline(checks, page, "profile", /^Set up$/, "Status — profile: Set up");
  await expectHeadline(checks, page, "database", /^Running$/, "Status — database: Running");
  const database = (await page.getByTestId("section-database").textContent()) ?? "";
  ok(database.includes("Schema version:"), "and the database section names its schema version");

  eq(await quit(app), 0, "Quit ends the process, exit code 0");
  eq(await server.status(), "stopped", "QUIT STOPPED THE DATABASE");
  eq(await server.isServing(), false, "and nothing is answering on its port");

  // --- the next launch needs nothing from the user ----------------------------
  const again = await launch(HOME);
  const againPage = await again.firstWindow();
  await expectVisible(checks, sidebar(againPage), "relaunching a set-up machine opens straight on the app");
  eq(await setupScreen(againPage).count(), 0, "with no setup");
  await expectHeadline(checks, againPage, "database", /^Running$/, "and the database is Running — THE APP STARTED IT");
  eq(await quit(again), 0, "Quit ends the process, exit code 0");
  eq(await server.status(), "stopped", "and stops the database again");
}

// ===========================================================================
// C. Database but no keys   /   D. …and keys Plaid accepts
// ===========================================================================

{
  // Take the keys back out, leaving the database and its encryption key.
  const stored = JSON.parse(readFileSync(CONFIG, "utf8")) as Record<string, unknown>;
  const encryptionKeyBefore = stored["encryptionKey"];
  delete stored["plaidClientId"];
  delete stored["plaidSecret"];
  writeFileSync(CONFIG, JSON.stringify(stored, null, 2));

  const SANDBOX_CONFIG = join(ROOT, ".dev-sandbox", "config.json");
  const sandbox = existsSync(SANDBOX_CONFIG)
    ? (JSON.parse(readFileSync(SANDBOX_CONFIG, "utf8")) as { plaidClientId: string; plaidSecret: string })
    : undefined;

  // Sandbox keys are only valid against Plaid's sandbox, and the app never
  // asks which environment to use — it is told, the way a contributor tells it.
  const app = await launch(HOME, sandbox === undefined ? {} : { PLAID_ENV: "sandbox" });
  const page = await app.firstWindow();
  const logged = captureConsole(page);

  await expectVisible(checks, setupScreen(page), "a database but no keys: setup is shown");
  eq(await step(page), "welcome", "starting with the welcome, because the keys are what is missing");
  await page.getByTestId("welcome-continue").click();
  eq(await step(page), "keys", "then the keys step");

  if (sandbox === undefined) {
    checks.note("accepted-keys path NOT RUN: it needs the sandbox profile (npm run setup:sandbox)");
  } else {
    await page.getByTestId("keys-client-id").fill(sandbox.plaidClientId);
    await page.getByTestId("keys-secret").fill(sandbox.plaidSecret);
    await page.getByTestId("keys-submit").click();

    await expectVisible(checks, page.getByTestId("finish-step"), "keys Plaid accepts move setup on", 45_000);
    eq(await page.getByTestId("database-step").count(), 0, "straight to the finish — NO SECOND DATABASE IS CREATED");

    const saved = JSON.parse(readFileSync(CONFIG, "utf8")) as Record<string, unknown>;
    eq(saved["plaidClientId"], sandbox.plaidClientId, "the client ID was saved");
    eq(saved["plaidSecret"], sandbox.plaidSecret, "the secret was saved");
    eq(saved["plaidEnv"], "sandbox", "with the environment the check ran against");
    eq(saved["encryptionKey"], encryptionKeyBefore, "AND THE EXISTING ENCRYPTION KEY WAS NOT REPLACED");

    await page.getByTestId("finish-continue").click();
    await expectVisible(checks, sidebar(page), "Continue shows the app");
    await expectHeadline(checks, page, "plaid", /^Keys present and working$/, "Status — plaid: Keys present and working", 45_000);
    await expectHeadline(checks, page, "database", /^Running$/, "Status — database: Running");

    ok(!(await page.locator("body").innerText()).includes(sandbox.plaidSecret), "the real secret is nowhere on screen");
    ok(!logged.some((line) => line.includes(sandbox.plaidSecret)), "and nowhere in the window's console");
  }

  eq(await quit(app), 0, "Quit ends the process, exit code 0");
  eq(await server.status(), "stopped", "and stops the database");
}

await wipe();
checks.finish();
