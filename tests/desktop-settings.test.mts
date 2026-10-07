/**
 * The Settings screen, driven through the window.
 *
 *   1. What it shows: the client ID (never the secret), the version, the folder
 *   2. The keys form: required fields; keys Plaid refuses leave the saved ones alone
 *   3. Start at sign-in: off on a fresh profile; on registers; off unregisters
 *   4. Started with --hidden, the app comes up with no window — and the tray's
 *      Open reveals it
 *
 * THIS SUITE TOUCHES THE REAL WINDOWS STARTUP REGISTRATION of whoever runs it,
 * for a few seconds, and puts back whatever was there. The registration is
 * checked two ways: what the app reports, and the registry itself.
 *
 * Windows-only, like the app. Skips elsewhere.
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ElectronApplication, Page } from "playwright";

import {
  buildDesktop,
  createChecks,
  expectVisible,
  launch,
  quit,
  ROOT,
  showWindow,
  skipUnlessWindows,
  until,
  windowVisible,
} from "./desktop-harness.mjs";

skipUnlessWindows();

const HOME = join(tmpdir(), "costingly-desktop-settings-test");
const DESKTOP = `${HOME}-desktop`;
process.env["COSTINGLY_HOME"] = HOME;

delete process.env["PLAID_CLIENT_ID"];
delete process.env["PLAID_SECRET"];
delete process.env["PLAID_ENV"];

const { closeDb, generateEncryptionKey, readConfigFile, server, writeConfig } = await import("../src/index.js");
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
// The real registration, read and restored
// ---------------------------------------------------------------------------

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const NAME = "Costingly";
const run = promisify(execFile);

/** The registry value's data, or null when there is none. */
async function registration(): Promise<string | null> {
  try {
    const { stdout } = await run("reg", ["query", RUN_KEY, "/v", NAME], { windowsHide: true });
    const match = new RegExp(`^\\s*${NAME}\\s+REG_SZ\\s+(.*)$`, "m").exec(stdout);
    return match?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}
const original = await registration();
async function restore(): Promise<void> {
  if (original === null) await run("reg", ["delete", RUN_KEY, "/v", NAME, "/f"], { windowsHide: true }).catch(() => {});
  else await run("reg", ["add", RUN_KEY, "/v", NAME, "/d", original, "/f"], { windowsHide: true }).catch(() => {});
}
// A fresh profile must start unregistered, whatever this machine had.
if (original !== null) await run("reg", ["delete", RUN_KEY, "/v", NAME, "/f"], { windowsHide: true }).catch(() => {});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VERSION = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;

async function open(args: readonly string[] = []): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launch(HOME, {}, 60_000, args);
  const page = await app.firstWindow();
  await page.getByRole("navigation", { name: "Screens" }).waitFor({ timeout: 30_000 });
  return { app, page };
}

async function goToSettings(page: Page): Promise<void> {
  await page.getByTestId("nav-settings").click();
  await page.locator("[data-testid='settings-screen'][data-state='ready']").waitFor({ timeout: 15_000 });
}

const savedClientId = (): string | undefined => readConfigFile().plaidClientId;

await writeConfig({
  plaidClientId: "placeholder-client-id",
  plaidSecret: "placeholder-secret",
  encryptionKey: generateEncryptionKey(),
});
await install();
await closeDb();
await server.stop();

try {
  // =========================================================================
  // 1. What it shows
  // =========================================================================

  let { app, page } = await open();
  eq(
    await page.getByRole("navigation", { name: "Screens" }).getByRole("button").allInnerTexts(),
    ["Status", "Accounts", "Transactions", "Settings"],
    "the sidebar lists Settings last",
  );
  await goToSettings(page);

  eq(await page.getByTestId("settings-client-id").textContent(), "placeholder-client-id", "THE CLIENT ID IN USE IS SHOWN");
  const everything = (await page.getByTestId("settings-screen").textContent()) ?? "";
  ok(!everything.includes("placeholder-secret"), "AND THE SECRET IS NOWHERE ON THE SCREEN");
  eq(await page.getByTestId("keys-secret").inputValue(), "", "not even in the form's field");
  eq(await page.getByTestId("settings-version").textContent(), VERSION, `the version is shown (${VERSION})`);
  ok(((await page.getByTestId("settings-data-folder").textContent()) ?? "").includes("costingly-desktop-settings-test"), "and the data folder");
  ok(/different Plaid account/.test((await page.getByTestId("settings-keys-warning").textContent()) ?? ""), "the form warns about keys from a different Plaid account");

  // =========================================================================
  // 2. The keys form
  // =========================================================================

  await page.getByTestId("keys-client-id").fill("another-client-id");
  await page.getByTestId("keys-submit").click();
  await expectVisible(checks, page.getByTestId("keys-secret-required"), "submitting without a secret says it is required");
  eq(await page.getByTestId("keys-error").count(), 0, "and nothing was sent to Plaid");
  eq(savedClientId(), "placeholder-client-id", "and nothing was saved");

  // Placeholder keys: Plaid refuses them, or cannot be reached. Either way
  // nothing is saved, and the screen says which.
  await page.getByTestId("keys-secret").fill("not-the-secret");
  await page.getByTestId("keys-submit").click();
  if (await expectVisible(checks, page.getByTestId("keys-error"), "keys Plaid refuses, or cannot check: the form says so", 45_000)) {
    const kind = await page.getByTestId("keys-error").getAttribute("data-kind");
    ok(kind === "rejected" || kind === "unreachable", `as rejected or unreachable (${kind})`);
    ok(!((await page.getByTestId("keys-error").textContent()) ?? "").includes("not-the-secret"), "without echoing the secret");
  }
  eq(savedClientId(), "placeholder-client-id", "THE SAVED KEYS ARE UNCHANGED");
  eq(await page.getByTestId("settings-client-id").textContent(), "placeholder-client-id", "and so is the client ID shown");
  eq(await page.getByTestId("settings-keys-saved").count(), 0, "and nothing claims to have been saved");

  // =========================================================================
  // 3. Start at sign-in
  // =========================================================================

  eq(await page.getByTestId("start-at-sign-in").isChecked(), false, "START AT SIGN-IN IS OFF on a fresh profile");
  eq(await registration(), null, "and Windows has no registration");

  await page.getByTestId("start-at-sign-in").check();
  await expectVisible(checks, page.getByTestId("start-at-sign-in-confirmed"), "turning it on is confirmed");
  ok(/will start when you sign in/.test((await page.getByTestId("start-at-sign-in-confirmed").textContent()) ?? ""), "in those words");
  eq(await page.getByTestId("start-at-sign-in").isChecked(), true, "the switch is on");
  const registered = await registration();
  ok(registered !== null && registered.includes("--hidden"), `WINDOWS NOW HAS THE REGISTRATION, launching hidden (${registered?.slice(0, 60)}…)`);

  // Read back, not remembered: a fresh look at the screen asks Windows again.
  await page.getByTestId("nav-status").click();
  await goToSettings(page);
  eq(await page.getByTestId("start-at-sign-in").isChecked(), true, "coming back to Settings, it is still on — read from Windows");

  await page.getByTestId("start-at-sign-in").uncheck();
  await expectVisible(checks, page.getByTestId("start-at-sign-in-confirmed"), "turning it off is confirmed");
  ok(/will not start/.test((await page.getByTestId("start-at-sign-in-confirmed").textContent()) ?? ""), "in those words");
  eq(await registration(), null, "AND THE REGISTRATION IS GONE");

  eq(await quit(app), 0, "Quit, exit code 0");

  // =========================================================================
  // 4. Started hidden
  // =========================================================================

  ({ app, page } = await open(["--hidden"]));
  eq(await windowVisible(app), false, "STARTED WITH --hidden, THE APP SHOWS NO WINDOW");
  eq(await server.status(), "running", "but its database is up");
  eq(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1, "the window exists, ready behind the tray");

  await showWindow(app);
  ok(await until(() => windowVisible(app), 10_000), "the tray's Open reveals it");
  await expectVisible(checks, page.getByTestId("status-screen"), "on the Status screen, as on any launch");
  eq(await quit(app), 0, "Quit, exit code 0");
  eq(await server.status(), "stopped", "and the database is stopped");
} finally {
  await restore();
}

eq(await registration(), original, "the machine's startup registration is as it was before the suite");

await wipe();
checks.finish();
