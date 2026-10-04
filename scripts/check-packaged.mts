/**
 * Check the PACKAGED app:  npm run check:packaged
 *
 * The window suites run the app from this folder, with this folder's
 * node_modules and the Node that is on the PATH. An installed copy has
 * neither. This packages the app exactly as the installer does, moves the
 * result OUT of the repository, takes Node off the PATH, and drives it:
 *
 *   1. On a machine with nothing set up it opens on the welcome screen, and
 *      creates nothing
 *   2. It creates a database with the engine and migrations it carries
 *   3. Stop, Start and Restart work
 *   4. A second copy exits and leaves the first one running
 *   5. Quitting stops the database
 *
 * It does not run the installer — that changes the machine. It checks what
 * the installer installs.
 *
 * Not part of `npm test`: packaging takes minutes and copies half a gigabyte.
 * Run it when the packaging, the dependencies, or the Electron version change.
 *
 * Uses a throwaway profile under the temp folder and removes everything it
 * made. Windows-only, like the app.
 */

import { randomBytes } from "node:crypto";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { Arch, build, Platform } from "electron-builder";
import type { ElectronApplication, Page } from "playwright";

import {
  createChecks,
  expectHeadline,
  expectVisible,
  launchPackaged,
  launchSecondCopy,
  quit,
  skipUnlessWindows,
  until,
} from "../tests/desktop-harness.mjs";
import { EXECUTABLE, installerConfig, UNPACKED, writeIcon } from "./installer-config.mjs";

skipUnlessWindows();

const WORK = join(tmpdir(), "costingly-packaged-check");
const APP = join(WORK, "app");
const HOME = join(WORK, "profile");
const DESKTOP = `${HOME}-desktop`;
const EXE = join(APP, EXECUTABLE);

const checks = createChecks(15);
const { eq, ok } = checks;

// ---------------------------------------------------------------------------
// Package, and move the result out of the repository
// ---------------------------------------------------------------------------

await rm(WORK, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });

await writeIcon();
await build({
  // The same packaging as the installer, stopping before the installer is made.
  targets: Platform.WINDOWS.createTarget(["dir"], Arch.x64),
  config: installerConfig(),
  publish: "never",
});
ok(existsSync(join(UNPACKED, EXECUTABLE)), "the app packaged");

// Node looks for a package in every folder above the file that asks for it. A
// copy left inside the repository could find the repository's node_modules and
// pass with a dependency missing from its own.
await mkdir(WORK, { recursive: true });
await cp(UNPACKED, APP, { recursive: true });

// The profile's config, written by hand. Importing the source tree's own
// writer would do, but this check is about the packaged app reading what is on
// disk, and nothing from src/ should be running alongside it.
const CONFIG = JSON.stringify({
  plaidClientId: "placeholder-client-id",
  plaidSecret: "placeholder-secret",
  encryptionKey: randomBytes(32).toString("base64"),
});

/** The PATH with every folder that holds a Node taken out. */
function pathWithoutNode(): Record<string, string> {
  const key = Object.keys(process.env).find((name) => name.toLowerCase() === "path") ?? "Path";
  const kept = (process.env[key] ?? "")
    .split(delimiter)
    .filter((dir) => dir !== "" && !existsSync(join(dir, "node.exe")));
  return { [key]: kept.join(delimiter) };
}
const ENV = pathWithoutNode();
const open = (timeout?: number): Promise<ElectronApplication> => launchPackaged(EXE, HOME, ENV, timeout);

const action = (page: Page, name: string) => page.getByTestId(`database-action-${name}`);

/** Is a database program from the packaged copy running? */
async function databaseRunning(): Promise<boolean> {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    execFile(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `@(Get-CimInstance Win32_Process -Filter "Name='postgres.exe'" | ? { $_.Path -and $_.Path.StartsWith('${APP}', 'CurrentCultureIgnoreCase') }).Count`,
      ],
      (_error, stdout) => resolve(Number(stdout.trim()) > 0),
    );
  });
}

try {
  // =========================================================================
  // 1. Nothing set up: the welcome screen, and nothing created
  // =========================================================================

  let app = await open();
  let page = await app.firstWindow();

  await expectVisible(checks, page.getByTestId("welcome-step"), "THE PACKAGED APP OPENS, on the welcome screen");
  eq(await app.evaluate(({ app: a }) => a.isPackaged), true, "and it knows it is a packaged app");
  eq(await app.evaluate(({ app: a }) => a.getName()), "Costingly", "named Costingly");
  ok(!existsSync(HOME), "opening it created no profile");
  eq(await quit(app), 0, "it quits cleanly");

  // =========================================================================
  // 2. Keys in place: the database is created from what the package carries
  // =========================================================================

  await mkdir(HOME, { recursive: true });
  await writeFile(join(HOME, "config.json"), CONFIG);

  app = await open();
  page = await app.firstWindow();

  await expectVisible(checks, page.getByTestId("database-step"), "with keys saved it goes straight to the database step");
  const created = await expectVisible(
    checks,
    page.getByTestId("database-continue"),
    "THE DATABASE IS CREATED — the packaged engine and migrations work",
    180_000,
  );
  if (!created) {
    const said = await page.getByTestId("database-error").textContent().catch(() => null);
    checks.note(`the database step said: ${said ?? "<nothing>"}`);
  } else {
    await page.getByTestId("database-continue").click();
    await page.getByTestId("finish-continue").click();

    await expectHeadline(checks, page, "database", /^Running$/, "the status screen shows the database Running");
    const section = (await page.getByTestId("section-database").textContent()) ?? "";
    ok(/Schema version: \S+/.test(section), "with its tables created");
    ok(await databaseRunning(), "and the database program running is the packaged one");

    // =======================================================================
    // 3. Stop, Start, Restart
    // =======================================================================

    await action(page, "stop").click();
    await expectHeadline(checks, page, "database", /^Stopped$/, "Stop stops it");
    ok(await until(async () => !(await databaseRunning()), 15_000), "and its program is gone");

    await action(page, "start").click();
    await expectHeadline(checks, page, "database", /^Running$/, "Start starts it");

    await action(page, "restart").click();
    await page.locator("[data-testid='database-actions'][data-running='restart']").waitFor({ timeout: 10_000 }).catch(() => {});
    await expectHeadline(checks, page, "database", /^Running$/, "Restart brings it back", 60_000);

    // =======================================================================
    // 4. A second copy
    // =======================================================================

    const second = await launchSecondCopy(HOME, open);
    ok(second !== "did not exit", `a second copy exits (${second})`);
    await expectHeadline(checks, page, "database", /^Running$/, "and the first copy carries on");

    // =======================================================================
    // 5. Quit stops the database
    // =======================================================================

    eq(await quit(app), 0, "Quit exits cleanly");
    ok(await until(async () => !(await databaseRunning()), 15_000), "AND STOPS THE DATABASE");
  }
} finally {
  // Whatever happened above, leave nothing running and nothing behind.
  const { execFile } = await import("node:child_process");
  await new Promise<void>((resolve) => {
    execFile(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Get-CimInstance Win32_Process | ? { $_.Path -and $_.Path.StartsWith('${APP}', 'CurrentCultureIgnoreCase') } | % { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
      ],
      () => resolve(),
    );
  });
  for (const dir of [WORK, DESKTOP]) {
    await rm(dir, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 }).catch(() => {});
  }
  ok(!existsSync(WORK), "the throwaway copy and profile are removed");
}

checks.finish();
