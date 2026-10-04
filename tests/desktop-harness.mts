/**
 * What the desktop window suites share: build, launch, look, quit.
 *
 * Not a suite — the runner only picks up `*.test.mts`.
 *
 * NOTHING HERE IMPORTS FROM src/. Each suite points the app at its own
 * throwaway profile by setting COSTINGLY_HOME before it imports anything from
 * the source tree, and a helper that imported the domain first would resolve
 * the real profile instead.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { _electron as electron, type ElectronApplication, type Locator, type Page } from "playwright";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const MAIN = join(ROOT, "dist", "apps", "desktop", "main", "main.js");

/** The app is Windows-only, and these suites open its window. */
export function skipUnlessWindows(): void {
  if (process.platform === "win32") return;
  console.log("SKIPPED — the desktop app is Windows-only, and this suite opens its window.");
  process.exit(0);
}

export interface Checks {
  eq(a: unknown, b: unknown, what: string): void;
  ok(condition: boolean, what: string): void;
  /** A line in the output that is neither a pass nor a failure. */
  note(text: string): void;
  /** Print everything and exit 0 or 1. */
  finish(): never;
}

/**
 * The assertion style every suite in this directory uses, plus a watchdog: a
 * hung window must not hang the whole test run.
 */
export function createChecks(watchdogMinutes = 8): Checks {
  const out: string[] = [];
  let fail = 0;
  let checks = 0;

  const watchdog = setTimeout(() => {
    console.log(out.join("\n"));
    console.log(`\n  FAIL  the suite did not finish within ${watchdogMinutes} minutes`);
    process.exit(1);
  }, watchdogMinutes * 60_000);

  const eq = (a: unknown, b: unknown, what: string): void => {
    checks++;
    if (JSON.stringify(a) === JSON.stringify(b)) out.push(`  ok    ${what}`);
    else {
      fail++;
      out.push(`  FAIL  ${what}\n          expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
    }
  };

  return {
    eq,
    ok: (condition, what) => eq(condition, true, what),
    note: (text) => void out.push(`  --    ${text}`),
    finish: () => {
      clearTimeout(watchdog);
      console.log(out.join("\n"));
      console.log(fail === 0 ? `\nAll ${checks} checks passed.` : `\n${fail} FAILED.`);
      process.exit(fail === 0 ? 0 : 1);
    },
  };
}

/**
 * Compile and bundle, so the suite tests the source as it is now rather than
 * whatever `npm install` last built.
 */
export async function buildDesktop(checks: Checks): Promise<void> {
  const run = promisify(execFile);
  const exec = { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 };
  await run(process.execPath, [join(ROOT, "node_modules", "typescript", "bin", "tsc")], exec);
  await run(
    process.execPath,
    [join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(ROOT, "scripts", "build-desktop.mts")],
    exec,
  );
  checks.ok(existsSync(MAIN), "the main process compiled");
  checks.ok(existsSync(join(ROOT, "dist", "apps", "desktop", "bridge", "preload.cjs")), "the preload compiled to CommonJS");
  checks.ok(
    existsSync(join(ROOT, "dist", "apps", "desktop", "renderer", "index.html")),
    "the renderer bundled",
  );
}

function envFor(home: string, extra: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) base[key] = value;
  // VS Code sets this for every process it spawns, and under it electron.exe is
  // plain Node: no `app`, no windows, and Playwright reports "failed to launch"
  // with nothing else to go on. Running the suite from an editor terminal must
  // not change what it tests.
  delete base["ELECTRON_RUN_AS_NODE"];
  return { ...base, COSTINGLY_HOME: home, ...extra };
}

/** Launch the built app against one profile. */
export function launch(
  home: string,
  extra: Record<string, string> = {},
  timeout = 60_000,
): Promise<ElectronApplication> {
  return electron.launch({ args: [MAIN], env: envFor(home, extra), timeout });
}

export function headline(page: Page, section: string): Locator {
  return page.getByTestId(`section-${section}-headline`);
}

/** Wait for a Status section to say exactly this, and record the outcome either way. */
export async function expectHeadline(
  checks: Checks,
  page: Page,
  section: string,
  text: RegExp,
  what: string,
  timeout = 30_000,
): Promise<void> {
  try {
    await headline(page, section).filter({ hasText: text }).waitFor({ timeout });
    checks.ok(true, what);
  } catch {
    const actual = await headline(page, section).textContent().catch(() => "<no headline>");
    checks.eq(actual, text.source, what);
  }
}

/** Wait for a locator to appear, and record the outcome either way. */
export async function expectVisible(
  checks: Checks,
  locator: Locator,
  what: string,
  timeout = 30_000,
): Promise<boolean> {
  try {
    await locator.waitFor({ timeout });
    checks.ok(true, what);
    return true;
  } catch {
    checks.ok(false, what);
    return false;
  }
}

export function windowVisible(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.isVisible()));
}

/** Close the window the way its X button does — which hides it. */
export async function closeWindow(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
}

/** Bring the window back the way the tray's Open does. */
export async function showWindow(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window?.show();
    window?.focus();
  });
}

export async function until(check: () => Promise<boolean> | boolean, timeoutMs = 10_000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return check();
}

/** Ask the app to quit the way the tray menu would, and return its exit code. */
export async function quit(app: ElectronApplication): Promise<number | null> {
  const exited = new Promise<number | null>((resolve) => app.process().once("exit", (code) => resolve(code)));
  // The call may not return: the process is on its way out.
  await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => {});
  return Promise.race([
    exited,
    // Generous: quitting now waits for the database to stop.
    new Promise<number | null>((resolve) => setTimeout(() => resolve(null), 60_000)),
  ]);
}

/**
 * Launch a second copy and report what became of it.
 *
 * The second copy exits almost at once, usually before Playwright has finished
 * attaching — which Playwright reports as a failed launch. That IS the
 * behaviour under test, so both ways of exiting count.
 */
export async function launchSecondCopy(home: string): Promise<string> {
  try {
    const second = await launch(home, {}, 20_000);
    const code = await Promise.race([
      new Promise<number | null>((resolve) => second.process().once("exit", (c) => resolve(c))),
      new Promise<number | null>((resolve) => setTimeout(() => resolve(null), 15_000)),
    ]);
    if (code === null) {
      await second.close().catch(() => {});
      return "did not exit";
    }
    return `exited with ${code}`;
  } catch {
    return "exited before Playwright could attach";
  }
}
