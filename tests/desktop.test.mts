/**
 * The desktop app, driven through its window.
 *
 * Playwright launches the built app against a throwaway profile and reads the
 * status screen the way a person would: by what the three sections say. Three
 * machines are simulated — nothing set up, bad Plaid keys, a real installed
 * database — and in each the sections must report independently.
 *
 * What this cannot do: click the tray icon or see the balloon notice. Windows
 * draws those, not the app. Everything the tray does is still exercised here
 * through the same code paths (hide on close, show again, quit), and the
 * notice is proven by the setting it leaves behind.
 *
 * Windows-only, like the app. Skips elsewhere.
 *
 * Rebuilds dist/ first, so it tests the source as it is now rather than
 * whatever `npm install` last compiled.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ElectronApplication, Page } from "playwright";

if (process.platform !== "win32") {
  console.log("SKIPPED — the desktop app is Windows-only, and this suite opens its window.");
  process.exit(0);
}

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HOME = join(tmpdir(), "costingly-desktop-test");
/** Where the app keeps its own files for a moved profile — see desktop-paths.ts. */
const DESKTOP = `${HOME}-desktop`;
process.env["COSTINGLY_HOME"] = HOME;

// Explicitly absent, so the first two scenarios mean what they say.
delete process.env["PLAID_CLIENT_ID"];
delete process.env["PLAID_SECRET"];

const { _electron: electron } = await import("playwright");
const { closeDb, server } = await import("../src/index.js");
const { install } = await import("../src/domain/services/install.service.js");

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

// A hung window must not hang the whole test run.
const watchdog = setTimeout(() => {
  console.log(out.join("\n"));
  console.log("\n  FAIL  the suite did not finish within six minutes");
  process.exit(1);
}, 6 * 60_000);

async function wipe(): Promise<void> {
  await server.stop().catch(() => {});
  for (const dir of [HOME, DESKTOP]) {
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
}
await wipe();

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

const run = promisify(execFile);
const exec = { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 };
await run(process.execPath, [join(ROOT, "node_modules", "typescript", "bin", "tsc")], exec);
await run(
  process.execPath,
  [join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(ROOT, "scripts", "build-desktop.mts")],
  exec,
);
const MAIN = join(ROOT, "dist", "apps", "desktop", "main.js");
ok(existsSync(MAIN), "the main process compiled");
ok(existsSync(join(ROOT, "dist", "apps", "desktop", "preload.cjs")), "the preload compiled to CommonJS");
ok(existsSync(join(ROOT, "dist", "apps", "desktop", "renderer", "index.html")), "the renderer bundled");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function env(extra: Record<string, string> = {}): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) base[key] = value;
  // VS Code sets this for every process it spawns, and under it electron.exe is
  // plain Node: no `app`, no windows, and Playwright reports "failed to launch"
  // with nothing else to go on. Running the suite from an editor terminal must
  // not change what it tests.
  delete base["ELECTRON_RUN_AS_NODE"];
  return { ...base, COSTINGLY_HOME: HOME, ...extra };
}

function launch(extra: Record<string, string> = {}): Promise<ElectronApplication> {
  return electron.launch({ args: [MAIN], env: env(extra), timeout: 60_000 });
}

function headline(page: Page, section: string) {
  return page.getByTestId(`section-${section}-headline`);
}

/** Wait for a section to say exactly this, and record the outcome either way. */
async function expectHeadline(
  page: Page,
  section: string,
  text: RegExp,
  what: string,
  timeout = 30_000,
): Promise<void> {
  try {
    await headline(page, section).filter({ hasText: text }).waitFor({ timeout });
    ok(true, what);
  } catch {
    const actual = await headline(page, section).textContent().catch(() => "<no headline>");
    eq(actual, text.source, what);
  }
}

function windowVisible(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.isVisible()));
}

async function until(check: () => Promise<boolean> | boolean, timeoutMs = 10_000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return check();
}

/** Ask the app to quit the way the tray menu would, and return its exit code. */
async function quit(app: ElectronApplication): Promise<number | null> {
  const exited = new Promise<number | null>((resolve) => app.process().once("exit", (code) => resolve(code)));
  // The call may not return: the process is on its way out.
  await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => {});
  return Promise.race([
    exited,
    new Promise<number | null>((resolve) => setTimeout(() => resolve(null), 20_000)),
  ]);
}

// ===========================================================================
// 1. A machine with nothing set up
// ===========================================================================

{
  const app = await launch();
  const page = await app.firstWindow();

  const nav = page.getByRole("navigation", { name: "Screens" });
  await nav.waitFor({ timeout: 30_000 });
  eq(await nav.getByRole("button").allTextContents(), ["Status"], "the sidebar lists Status and nothing else");
  eq(await page.locator("article[data-testid^='section-']").count(), 3, "the status screen has three sections");

  await expectHeadline(page, "profile", /^Not set up$/, "profile: Not set up");
  await expectHeadline(page, "database", /^Not created$/, "database: Not created");
  await expectHeadline(page, "plaid", /^No keys entered$/, "plaid: No keys entered");
  ok(
    await until(async () => (await page.getByTestId("status-screen").getAttribute("data-checking")) === "false"),
    "all three checks finish",
  );
  eq(await page.getByRole("button", { name: "Refresh" }).isEnabled(), true, "and Refresh is available again");

  eq(existsSync(HOME), false, "OPENING THE STATUS SCREEN CREATED NO PROFILE");

  // --- Refresh re-checks -----------------------------------------------------
  await mkdir(HOME, { recursive: true });
  await page.getByRole("button", { name: "Refresh" }).click();
  await expectHeadline(page, "profile", /^Set up$/, "Refresh re-checked: a profile folder created behind its back is now reported");
  await expectHeadline(page, "database", /^Not created$/, "…and the database section is unchanged");

  // --- close hides -----------------------------------------------------------
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  ok(await until(async () => !(await windowVisible(app))), "closing the window hides it");
  eq(app.process().exitCode, null, "and the app keeps running");

  const settingsPath = join(DESKTOP, "settings.json");
  ok(await until(() => existsSync(settingsPath)), "the first close writes the app's settings file");
  const settings = JSON.parse(await readFile(settingsPath, "utf8")) as { closeNoticeShown?: boolean };
  eq(settings.closeNoticeShown, true, "recording that the notice was shown");
  eq(existsSync(join(HOME, "settings.json")), false, "in the app's own folder, not in the profile");

  // --- showing re-checks -----------------------------------------------------
  await rm(HOME, { recursive: true, force: true });
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window?.show();
    window?.focus();
  });
  ok(await until(() => windowVisible(app)), "the window comes back");
  await expectHeadline(page, "profile", /^Not set up$/, "coming back re-checked: the deleted profile folder is reported absent");

  // --- a second copy ---------------------------------------------------------
  let outcome = "did not exit";
  try {
    const second = await electron.launch({ args: [MAIN], env: env(), timeout: 20_000 });
    const code = await Promise.race([
      new Promise<number | null>((resolve) => second.process().once("exit", (c) => resolve(c))),
      new Promise<number | null>((resolve) => setTimeout(() => resolve(null), 15_000)),
    ]);
    if (code === null) await second.close().catch(() => {});
    else outcome = `exited with ${code}`;
  } catch {
    outcome = "exited before Playwright could attach";
  }
  ok(outcome !== "did not exit", `a second copy exits instead of opening a window (${outcome})`);
  eq(
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
    1,
    "the first copy still has exactly one window",
  );
  ok(await until(() => windowVisible(app)), "and it is showing");

  // --- light and dark --------------------------------------------------------
  // As strings: this file is typed for node, and the DOM names only exist in
  // the window where Playwright evaluates them.
  const BODY_BACKGROUND = "getComputedStyle(document.body).backgroundColor";
  await page.emulateMedia({ colorScheme: "light" });
  const light = await page.evaluate<string>(BODY_BACKGROUND);
  await page.emulateMedia({ colorScheme: "dark" });
  const dark = await page.evaluate<string>(BODY_BACKGROUND);
  ok(light !== dark, `the page follows the colour scheme (light ${light}, dark ${dark})`);

  // --- quit ------------------------------------------------------------------
  eq(await quit(app), 0, "Quit ends the process, exit code 0");
}

// ===========================================================================
// 2. Plaid keys that Plaid rejects — one section's trouble stays in that section
// ===========================================================================

{
  const app = await launch({ PLAID_CLIENT_ID: "not-a-real-id", PLAID_SECRET: "not-a-real-secret" });
  const page = await app.firstWindow();

  await expectHeadline(page, "profile", /^Not set up$/, "with bad Plaid keys the profile still reports");
  await expectHeadline(page, "database", /^Not created$/, "…and so does the database");
  await expectHeadline(
    page,
    "plaid",
    /^Keys present but Plaid could not be reached$/,
    "…while Plaid reports the rejection, distinct from having no keys",
    45_000,
  );
  const plaid = (await page.getByTestId("section-plaid").textContent()) ?? "";
  ok(!/costingly\s+\w+|Claude Desktop/.test(plaid), "and says nothing about commands or Claude Desktop");

  eq(await quit(app), 0, "Quit ends the process, exit code 0");
}

// ===========================================================================
// 3. An installed profile with its database running
// ===========================================================================

{
  await install();
  eq(await server.status(), "running", "the throwaway database is running before the app opens");

  const app = await launch();
  const page = await app.firstWindow();

  await expectHeadline(page, "profile", /^Set up$/, "an installed profile: Set up");
  await expectHeadline(page, "database", /^Running$/, "its database: Running");
  await expectHeadline(page, "plaid", /^No keys entered$/, "and Plaid, independently: No keys entered");

  const database = (await page.getByTestId("section-database").textContent()) ?? "";
  ok(database.includes("Listening on 127.0.0.1:"), "the database section says where it listens");
  const profile = (await page.getByTestId("section-profile").textContent()) ?? "";
  ok(profile.includes("Data folder:"), "the profile section says where the data lives");

  // --- stopped is reported, not repaired ---------------------------------------
  // The same promise `costingly status` makes: a report may not start a server.
  await closeDb();
  await server.stop();
  await page.getByRole("button", { name: "Refresh" }).click();
  await expectHeadline(page, "database", /^Stopped$/, "a stopped database: Stopped — distinct from Not created");
  await expectHeadline(page, "profile", /^Set up$/, "…while the profile section is unchanged");
  eq(await server.status(), "stopped", "REPORTING DID NOT START IT");

  eq(await quit(app), 0, "Quit ends the process, exit code 0");
  eq(await server.status(), "stopped", "and quitting left the database as it found it");
}

await wipe();
clearTimeout(watchdog);

console.log(out.join("\n"));
console.log(fail === 0 ? `\nAll ${out.length} checks passed.` : `\n${fail} FAILED.`);
process.exit(fail === 0 ? 0 : 1);
