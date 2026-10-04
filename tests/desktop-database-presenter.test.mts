/**
 * The Database section — every state and every failure, as a table.
 *
 * `database.presenter.ts` decides three things from two inputs. The inputs are
 * the live health check and the failure the service remembers; the outputs are
 * what the section says, what it says is wrong, and which buttons it offers.
 * All of it is pure, so each combination is a row here rather than a database
 * to break.
 *
 * What the table protects:
 *
 *   1. Every failure has a cause AND a next step. One without the other leaves
 *      the reader where they started.
 *   2. A failure offers the one button that addresses it — never a button that
 *      would do nothing.
 *   3. The live check wins. A remembered "would not start" beside a database
 *      that is plainly running would be a lie.
 *   4. No explanation tells anyone to run a command, or mentions Claude Desktop.
 */

import type { DatabaseHealth } from "../src/domain/services/database/database-health.service.js";
import type { DatabaseSectionView, Problem } from "../src/apps/desktop/bridge/contract.js";
import type { DatabaseFailure } from "../src/apps/desktop/main/services/database.service.js";
import {
  explainDatabaseFailure,
  presentDatabaseSection,
} from "../src/apps/desktop/main/presenters/database.presenter.js";

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

/** Every word the presenter produced, for the sweep at the end. */
const said: string[] = [];
function present(health: DatabaseHealth, failure?: DatabaseFailure): DatabaseSectionView {
  const view = presentDatabaseSection(health, failure);
  said.push(view.headline, ...view.details, view.problem?.cause ?? "", view.problem?.nextStep ?? "");
  return view;
}
const complete = (problem: Problem | undefined): boolean =>
  problem !== undefined && problem.cause.trim() !== "" && problem.nextStep.trim() !== "";

// ---------------------------------------------------------------------------
// Health fixtures
// ---------------------------------------------------------------------------

const running: DatabaseHealth = {
  profile: { path: "~/AppData/Local/costingly/Data", chosenBy: "platform default", exists: true },
  cluster: {
    path: "~/AppData/Local/costingly/Data/pg18",
    exists: true,
    state: "running",
    listenAddress: "127.0.0.1:54320",
    startedAt: "2026-10-03 09:00",
    uptimeSeconds: 3725,
  },
  connection: { ok: true, elapsedMs: 12 },
  migrationsApplied: ["0001-initial", "0002-item-source"],
};
const stopped: DatabaseHealth = {
  ...running,
  cluster: { ...running.cluster, state: "stopped", startedAt: null, uptimeSeconds: null },
  connection: { ok: false, error: "ECONNREFUSED" },
  migrationsApplied: null,
};
const uninitialised: DatabaseHealth = {
  ...stopped,
  cluster: { ...stopped.cluster, exists: false, state: "uninitialised" },
  connection: { ok: false },
};
const wedged: DatabaseHealth = {
  ...running,
  cluster: { ...running.cluster, startedAt: null, uptimeSeconds: null },
  connection: { ok: false, elapsedMs: 15000, error: "no response after 15000ms" },
  migrationsApplied: null,
};

/** What the layers underneath actually throw when the server will not start. */
const START_REASON =
  "Could not start the local database.\n\npg_ctl: could not start server\nExamine the log output.\n\n" +
  "The postmaster log may say more:\n  C:\\Users\\someone\\AppData\\Local\\costingly\\Data\\pg18.log";

// ===========================================================================
// 1. Healthy states — and the buttons that fit them
// ===========================================================================

{
  const v = present(running);
  eq(v.headline, "Running", "running and answering: Running");
  eq(v.tone, "good", "running is good");
  eq(v.problem, undefined, "running has no problem");
  eq(v.actions, ["stop", "restart"], "RUNNING OFFERS STOP AND RESTART");
  ok(v.details.some((d) => d.includes("127.0.0.1:54320")), "running says where it listens");
  ok(v.details.some((d) => d.includes("1h 2m")), "running says for how long");
  ok(v.details.some((d) => d.includes("Schema version: 0002-item-source")), "running names the schema version");
}
{
  const v = present({ ...running, migrationsApplied: [] });
  ok(v.details.some((d) => /no tables/i.test(d)), "an empty schema is said out loud");
}
{
  const v = present(stopped);
  eq(v.headline, "Stopped", "stopped, with nothing remembered: Stopped — a state, not a fault");
  eq(v.tone, "warn", "stopped is a warning");
  eq(v.problem, undefined, "stopped has no problem");
  eq(v.actions, ["start"], "STOPPED OFFERS START");
}

// ===========================================================================
// 2. Failures — a cause, a next step, and the one button that addresses it
// ===========================================================================

{
  const v = present(stopped, { kind: "will-not-start", reason: START_REASON });
  eq(v.headline, "Could not start", "will not start: its own headline");
  eq(v.tone, "bad", "will not start is bad");
  ok(complete(v.problem), "will not start: a cause and a next step");
  ok((v.problem?.cause ?? "").includes("pg_ctl: could not start server"), "the cause carries the reason it was given");
  ok(!(v.problem?.cause ?? "").includes("\n"), "…as one line, not a terminal message");
  ok(!(v.problem?.cause ?? "").includes("pg18.log"), "…without the pointer to the log file — Show details does that");
  eq(v.actions, ["start"], "will not start offers Start");
}
{
  const v = present(stopped, { kind: "port-in-use", reason: START_REASON, port: 54320 });
  eq(v.headline, "Port in use", "port in use: its own headline — distinct from will not start");
  ok(complete(v.problem), "port in use: a cause and a next step");
  ok((v.problem?.cause ?? "").includes("54320"), "THE PORT IS NAMED BY NUMBER");
  ok(/another program/i.test(v.problem?.cause ?? ""), "the cause says another program has it");
  ok(/close that program/i.test(v.problem?.nextStep ?? ""), "the next step is to close it");
  ok(/restarting your computer/i.test(v.problem?.nextStep ?? ""), "…or, failing that, restart the computer");
  eq(v.actions, ["start"], "port in use offers Start");
}
{
  const v = present(stopped, { kind: "port-in-use", reason: START_REASON, port: undefined });
  ok(complete(v.problem), "port in use with no known port still explains itself");
  ok(!/undefined/.test(JSON.stringify(v)), "…without printing 'undefined'");
}
{
  const v = present(running, { kind: "update-failed", reason: 'column "source" of relation "items" already exists' });
  eq(v.headline, "Could not be updated", "update failed: its own headline");
  eq(v.tone, "bad", "update failed is bad, even though the server is running");
  ok(complete(v.problem), "update failed: a cause and a next step");
  ok((v.problem?.cause ?? "").includes("already exists"), "the cause carries the reason");
  ok(/not affected/i.test(v.problem?.nextStep ?? ""), "the next step says existing data is not affected");
  eq(v.actions, ["update"], "UPDATE FAILED OFFERS RETRY, AND ONLY RETRY");
  ok(v.details.some((d) => d.includes("127.0.0.1:54320")), "…and still says where the running server listens");
}
{
  const v = present(wedged);
  eq(v.headline, "Running but not answering", "up but wedged: its own headline");
  ok(complete(v.problem), "not answering: a cause and a next step");
  ok((v.problem?.cause ?? "").includes("15000ms"), "the cause carries the reason");
  eq(v.actions, ["restart"], "NOT ANSWERING OFFERS RESTART");
}
{
  const v = present(uninitialised);
  eq(v.headline, "Not created", "no database: Not created");
  ok(complete(v.problem), "not created: a cause and a next step");
  eq(v.actions, ["create"], "NOT CREATED OFFERS CREATE DATABASE");
}
{
  const v = present(uninitialised, { kind: "create-failed", reason: "initdb: could not create directory" });
  eq(v.headline, "Could not be created", "creation failed: its own headline");
  ok(complete(v.problem), "creation failed: a cause and a next step");
  ok((v.problem?.cause ?? "").includes("initdb"), "the cause carries the reason");
  eq(v.actions, ["create"], "creation failed offers Create database again");
}
{
  const v = present({
    ...stopped,
    cluster: { ...stopped.cluster, state: "unknown", error: "pg_ctl: not found" },
  });
  eq(v.headline, "Could not check", "the server cannot be asked: Could not check");
  eq(v.actions, [], "…and offers nothing, because no button would help");
}

// ===========================================================================
// 3. The live check wins
// ===========================================================================

{
  const v = present(running, { kind: "will-not-start", reason: START_REASON });
  eq(v.headline, "Running", "A REMEMBERED START FAILURE IS IGNORED ONCE THE DATABASE IS RUNNING");
  eq(v.problem, undefined, "…with no problem shown");
  eq(v.actions, ["stop", "restart"], "…and the ordinary buttons");
}
{
  const v = present(running, { kind: "port-in-use", reason: START_REASON, port: 54320 });
  eq(v.problem, undefined, "a remembered port conflict is ignored once the database is running");
}
{
  const v = present(stopped, { kind: "update-failed", reason: "anything" });
  eq(v.headline, "Stopped", "a remembered update failure does not apply to a stopped database");
  eq(v.actions, ["start"], "…which offers Start");
}

// ===========================================================================
// 4. Setup uses the same explanations
// ===========================================================================

for (const failure of [
  { kind: "will-not-start", reason: START_REASON },
  { kind: "port-in-use", reason: START_REASON, port: 54320 },
  { kind: "not-answering", reason: "no response" },
  { kind: "update-failed", reason: "boom" },
  { kind: "create-failed", reason: "boom" },
] satisfies DatabaseFailure[]) {
  const { headline, problem } = explainDatabaseFailure(failure);
  said.push(headline, problem.cause, problem.nextStep);
  ok(headline !== "" && complete(problem), `${failure.kind}: explained with a headline, a cause and a next step`);
}

// ===========================================================================
// 5. No CLI wording anywhere
// ===========================================================================

const CLI_WORDING = /costingly\s+(init|migrate|status|stop|sync|link|unlink|uninstall|reset|seed)\b|`|Claude Desktop/;
eq(
  said.filter((line) => CLI_WORDING.test(line)),
  [],
  `${said.filter((s) => s !== "").length} lines produced, and none tells the user to run a command`,
);

console.log(out.join("\n"));
console.log(fail === 0 ? `\nAll ${out.length} checks passed.` : `\n${fail} FAILED.`);
process.exit(fail === 0 ? 0 : 1);
