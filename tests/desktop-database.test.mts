/**
 * The database's controls and failure messages, driven through the window
 * against a real database.
 *
 *   1. Out-of-date tables are brought up to date at launch
 *   2. Stop, Start and Restart do what they say, and say what they are doing
 *   3. A port conflict is explained — staged for real, by occupying the port
 *   4. The same conflict at launch does not stop the app from opening
 *   5. After a crash, the database left running is simply used
 *
 * The failures that cannot be staged without breaking a database in ways tied
 * to the contents of its migrations — a failed table update, a server that is
 * up but will not answer — are covered where they can be produced on demand:
 * desktop-services.test.mts (how they are recognised) and
 * desktop-database-presenter.test.mts (what is said about them).
 *
 * Windows-only, like the app. Skips elsewhere.
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ElectronApplication, Page } from "playwright";

import {
  buildDesktop,
  createChecks,
  expectHeadline,
  expectVisible,
  headline,
  launch,
  quit,
  skipUnlessWindows,
  until,
} from "./desktop-harness.mjs";

skipUnlessWindows();

const HOME = join(tmpdir(), "costingly-desktop-database-test");
const DESKTOP = `${HOME}-desktop`;
process.env["COSTINGLY_HOME"] = HOME;

delete process.env["PLAID_CLIENT_ID"];
delete process.env["PLAID_SECRET"];
delete process.env["PLAID_ENV"];

const { adminDataSource, closeDb, generateEncryptionKey, server, writeConfig } = await import("../src/index.js");
const { loadMigrations } = await import("../src/platform/postgres/migrations.js");

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

const action = (page: Page, name: string) => page.getByTestId(`database-action-${name}`);
const offered = async (page: Page): Promise<string[]> =>
  (await page.locator("[data-testid^='database-action-']").evaluateAll((buttons) =>
    buttons.map((button) => (button.getAttribute("data-testid") ?? "").replace("database-action-", "")),
  )) as string[];
const problem = (page: Page) => page.getByTestId("database-problem");

/** The postmaster's process id: the proof that a restart really restarted. */
const postmasterPid = (): string =>
  (readFileSync(join(server.dataDir(), "postmaster.pid"), "utf8").split(/\r?\n/)[0] ?? "").trim();

/**
 * Another program on the database's port.
 *
 * It accepts connections and then says NOTHING, which is how a real program
 * that is not a database behaves and is the awkward case: anything that tries
 * to talk to it as if it were PostgreSQL waits for an answer that never comes.
 * The app must explain the conflict without waiting on it.
 */
interface Blocker {
  server: Server;
  held: Set<Socket>;
}
async function occupy(port: number): Promise<Blocker> {
  const held = new Set<Socket>();
  const server = createServer((socket) => {
    held.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => held.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return { server, held };
}
/** The other program exits: its connections are dropped and the port is free. */
function release(blocker: Blocker): Promise<void> {
  for (const socket of blocker.held) socket.destroy();
  return new Promise((resolve) => blocker.server.close(() => resolve()));
}

/** Prompt enough that nothing can have been waiting on the silent program. */
const WITHOUT_WAITING_MS = 12_000;

async function open(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launch(HOME);
  const page = await app.firstWindow();
  await page.getByRole("navigation", { name: "Screens" }).waitFor({ timeout: 30_000 });
  return { app, page };
}

// ---------------------------------------------------------------------------
// A set-up machine whose database is one table update behind
// ---------------------------------------------------------------------------

const migrations = await loadMigrations();
const first = migrations[0];
const latest = migrations[migrations.length - 1];
ok(migrations.length >= 2 && first !== undefined && latest !== undefined, "there are at least two table updates to tell apart");

await writeConfig({
  plaidClientId: "placeholder-client-id",
  plaidSecret: "placeholder-secret",
  encryptionKey: generateEncryptionKey(),
});
await server.install({ migrations: async () => migrations.slice(0, 1) });
const before = await adminDataSource().query<{ id: string }>("SELECT id FROM schema_migrations ORDER BY id");
eq(before.rows.map((row) => row.id), [first?.id], "the throwaway database starts with only the first table update applied");
await closeDb();
await server.stop();

const port = (await server.endpoint())?.port ?? 0;
ok(port > 0, `the database's port is known (${port})`);

// ===========================================================================
// 1. Out-of-date tables are brought up to date at launch
// ===========================================================================

let { app, page } = await open();

await expectHeadline(checks, page, "database", /^Running$/, "launch: the database is Running");
const section = (await page.getByTestId("section-database").textContent()) ?? "";
ok(section.includes(`Schema version: ${latest?.id}`), `THE TABLES WERE BROUGHT UP TO DATE AT LAUNCH (now ${latest?.id})`);
eq(await problem(page).count(), 0, "with no problem shown");

const profileHeadline = await headline(page, "profile").textContent();
await expectHeadline(checks, page, "plaid", /^Keys present but Plaid could not be reached$/, "the Plaid section settles", 45_000);
const plaidHeadline = await headline(page, "plaid").textContent();
const othersUnchanged = async (when: string): Promise<void> => {
  eq(
    [await headline(page, "profile").textContent(), await headline(page, "plaid").textContent()],
    [profileHeadline, plaidHeadline],
    `the profile and Plaid sections are untouched ${when}`,
  );
};

// ===========================================================================
// 2. Stop, Start, Restart
// ===========================================================================

eq(await offered(page), ["stop", "restart"], "running offers Stop and Restart");

await action(page, "stop").click();
await expectHeadline(checks, page, "database", /^Stopped$/, "Stop: the section shows Stopped");
eq(await server.status(), "stopped", "and the database really is stopped");
eq(await offered(page), ["start"], "stopped offers Start");
await othersUnchanged("by Stop");

await action(page, "start").click();
await expectHeadline(checks, page, "database", /^Running$/, "Start: the section shows Running");
eq(await server.status(), "running", "and the database really is running");
eq(await offered(page), ["stop", "restart"], "and Stop and Restart are back");

const pidBefore = postmasterPid();
await action(page, "restart").click();
// A restart takes long enough to be seen in progress.
const inProgress = await expectVisible(
  checks,
  page.locator("[data-testid='database-actions'][data-running='restart']"),
  "Restart: the section shows the action is in progress",
  10_000,
);
if (inProgress) {
  eq(await headline(page, "database").textContent(), "Restarting…", "saying Restarting…");
  eq(
    [await action(page, "stop").isDisabled(), await action(page, "restart").isDisabled()],
    [true, true],
    "with its buttons disabled",
  );
}
await expectHeadline(checks, page, "database", /^Running$/, "then shows Running again", 60_000);
ok(postmasterPid() !== pidBefore && postmasterPid() !== "", "and it is a NEW server process — the database really restarted");
await othersUnchanged("by Restart");

// ===========================================================================
// 3. A port conflict, staged for real
// ===========================================================================

await action(page, "stop").click();
await expectHeadline(checks, page, "database", /^Stopped$/, "the database is stopped, ready for the conflict");

let blocker = await occupy(port);
await action(page, "start").click();

await expectHeadline(
  checks,
  page,
  "database",
  /^Port in use$/,
  "Start with the port taken: Port in use — not just 'Stopped', and WITHOUT WAITING on the program that has it",
  WITHOUT_WAITING_MS,
);
eq(await server.status(), "stopped", "the database did not start");
if (await expectVisible(checks, problem(page), "the problem is explained in the section")) {
  const cause = (await page.getByTestId("problem-cause").textContent()) ?? "";
  const next = (await page.getByTestId("problem-next-step").textContent()) ?? "";
  ok(cause.includes(String(port)), `the cause names the port (${port})`);
  ok(/another program/i.test(cause), "and says another program is using it");
  ok(/close that program/i.test(next), "the next step says to close that program");
  ok(!/costingly\s+\w+|Claude Desktop|`/.test(cause + next), "and nothing tells the user to run a command");
}
eq(await offered(page), ["start"], "the one button offered is Start");

// --- details: closed until asked for ---
eq(await page.getByTestId("problem-log-lines").count(), 0, "Show details is CLOSED by default");
await page.getByTestId("problem-details-toggle").click();
if (await expectVisible(checks, page.getByTestId("problem-log-lines"), "opening it shows the database log")) {
  const lines = (await page.getByTestId("problem-log-lines").textContent()) ?? "";
  ok(/could not bind/i.test(lines), "including what the database itself reported about the port");
  const path = (await page.getByTestId("problem-log-path").textContent()) ?? "";
  ok(path.includes("pg18.log"), "and where the log file is");

  const stored = JSON.parse(readFileSync(join(HOME, "config.json"), "utf8")) as {
    database?: { superuser?: { password?: string }; app?: { password?: string } };
  };
  const passwords = [stored.database?.superuser?.password, stored.database?.app?.password].filter(
    (value): value is string => typeof value === "string" && value !== "",
  );
  ok(passwords.length === 2 && passwords.every((password) => !lines.includes(password)), "and neither database password is in what is shown");
}
await othersUnchanged("by a failed Start");

// --- fixed: the failure goes away ---
await release(blocker);
await action(page, "start").click();
await expectHeadline(checks, page, "database", /^Running$/, "with the port free again, Start works: Running", 60_000);
eq(await problem(page).count(), 0, "AND THE FAILURE MESSAGE IS GONE");
eq(await offered(page), ["stop", "restart"], "with the ordinary buttons back");

eq(await quit(app), 0, "Quit ends the process, exit code 0");
eq(await server.status(), "stopped", "and stops the database");

// ===========================================================================
// 4. The same conflict at launch
// ===========================================================================

blocker = await occupy(port);
({ app, page } = await open());
ok(true, "with the database's port taken, THE APP STILL OPENS");
await expectHeadline(
  checks,
  page,
  "database",
  /^Port in use$/,
  "and its Status screen explains why the database is down, without waiting",
  WITHOUT_WAITING_MS,
);
ok(((await page.getByTestId("problem-cause").textContent()) ?? "").includes(String(port)), "naming the port");

await release(blocker);
await action(page, "start").click();
await expectHeadline(checks, page, "database", /^Running$/, "freeing the port and pressing Start recovers it", 60_000);

// ===========================================================================
// 5. After a crash
// ===========================================================================

// End the app the way Task Manager's "End task" does: the whole process tree,
// with no chance to shut down. Killing only the process Playwright holds is
// not a crash at all — that one is a launcher, and the app proper is its child
// and would carry on running, window and all.
const crashed = new Promise<void>((resolve) => app.process().once("exit", () => resolve()));
await promisify(execFile)("taskkill", ["/PID", String(app.process().pid), "/T", "/F"]);
await crashed;
ok(await until(async () => (await server.status()) === "running", 5_000), "the app is killed without quitting, and the database is left running");

// The killed app's helper processes take a moment to disappear, and the
// single-copy lock goes with them; a relaunch in that instant can be turned
// away as a second copy. Nobody relaunches that fast by hand. The suite does,
// so it tries again briefly.
let relaunched: { app: ElectronApplication; page: Page } | undefined;
for (let attempt = 0; attempt < 10 && relaunched === undefined; attempt++) {
  try {
    relaunched = await open();
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}
if (relaunched === undefined) throw new Error("the app could not be relaunched after being killed");
({ app, page } = relaunched);
await expectHeadline(checks, page, "database", /^Running$/, "THE NEXT LAUNCH OPENS NORMALLY, with the database Running");
eq(await problem(page).count(), 0, "and nothing to explain");
eq(await offered(page), ["stop", "restart"], "and the ordinary buttons");

eq(await quit(app), 0, "Quit ends the process, exit code 0");
eq(await server.status(), "stopped", "and this time the database is stopped with it");

await wipe();
checks.finish();
