/**
 * check_database and restart_database.
 *
 * The only interesting cases are the broken ones. A health check that works
 * when everything is fine and throws when it is not has inverted its own
 * purpose, so most of this suite deliberately breaks things first:
 *
 *   - server stopped
 *   - cluster directory missing entirely
 *   - a profile that has never been created
 *
 * Plus the one guarantee that matters more than any of it: the report never
 * prints a secret.
 */

import { rm, mkdir } from "node:fs/promises";

const HOME = "/tmp/costingly-health";
process.env["COSTINGLY_HOME"] = HOME;

// A recognisable secret, so "is it in the output?" is a substring search rather
// than a judgement call.
const SECRET = "plaid-secret-must-never-be-printed";
process.env["PLAID_SECRET"] = SECRET;
process.env["PLAID_CLIENT_ID"] = "client-id-abc123";

const { db, closeDb, server, database } = await import("../src/index.js");
const { checkDatabase, restartDatabase } = await import("../src/domain/services/database/database-health.service.js");
const { formatHealth } = await import("../src/apps/mcp/tools/check-database.utils.js");


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

async function wipe(): Promise<void> {
  await server.stop().catch(() => {});
  // maxRetries: Windows can still hold handles on the cluster directory for a
  // moment after the postmaster exits, which unlink-while-open unix does not.
  await rm(HOME, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
await wipe();

const { loadMigrations } = await import("../src/platform/postgres/migrations.js");

// ===========================================================================
// 0. INSPECTING MUST NOT CREATE
// ===========================================================================
//
// Runs first, on a profile that has just been wiped, because it is the only
// point at which "nothing exists" is still true — everything below deliberately
// builds a database.
//
// The bug this pins down: `clusterConfig()` used to evaluate the superuser
// login eagerly, and supplying that login GENERATES a password and writes it to
// config.json. So merely asking `status()` whether the server was up recreated
// part of a profile that had just been deleted — and a diagnostic that
// resurrects what it reports on cannot be used to confirm a cleanup.

const { existsSync } = await import("node:fs");
const { platform: costinglyPlatform } = await import("../src/domain/project.js");

eq(existsSync(HOME), false, "the profile really is gone before we look at it");

const stateBefore = await server.status();
eq(stateBefore, "uninitialised", "status() reports an absent cluster");
eq(existsSync(HOME), false, "…and status() created NOTHING");

eq(await server.endpoint(), undefined, "endpoint() reports no port rather than inventing one");
eq(existsSync(HOME), false, "…and endpoint() created NOTHING");

eq(await server.stop(), false, "stop() on an absent cluster is a no-op");
eq(existsSync(costinglyPlatform.configPath()), false, "…and wrote no config.json");

// ===========================================================================
// 1. Nothing exists yet — the very first thing a broken install looks like
// ===========================================================================

const absent = await checkDatabase();
ok(true, "checkDatabase() on a non-existent profile RETURNED instead of throwing");
eq(absent.profile.chosenBy, "COSTINGLY_HOME", "it reports what chose the profile");
ok(absent.profile.path.includes("costingly-health"), "it names the profile directory");

// It reports what is not there, and — the point of section 0 — leaves it not
// there. Checking is not a way of creating.
eq(absent.connection.ok, false, "it cannot connect, and says so");
eq(absent.cluster.state, "uninitialised", "the cluster is reported as absent");
eq(existsSync(HOME), false, "AND CHECKING CREATED NOTHING");

// Now build it for real. Explicit, because reading no longer creates one.
await database.ensureReady();

const fresh = await checkDatabase();
ok(fresh.connection.ok, "once the database exists, the check connects");
eq(fresh.migrationsApplied, (await loadMigrations()).map((m) => m.id),
   "every migration is reported as applied");
ok((fresh.cluster.uptimeSeconds ?? -1) >= 0, "uptime is reported once connected");
ok(fresh.cluster.startedAt !== null, "and so is the postmaster start time");

// ===========================================================================
// 2. Secrets
// ===========================================================================

const rendered = formatHealth(fresh);
ok(!rendered.includes(SECRET), "THE REPORT DOES NOT CONTAIN THE PLAID SECRET");
ok(!JSON.stringify(fresh).includes(SECRET), "...and neither does the underlying record");
// The report is about the database, not its contents. These are the questions
// `query` answers, and duplicating them here would make this the tool called
// for everything.
for (const absent of ["transaction", "Sources", "Covering", "Synced"]) {
  ok(!rendered.includes(absent), `the report says nothing about the data (${absent})`);
}

// ===========================================================================
// 3. Server stopped — the case the tool exists for
// ===========================================================================

await closeDb();
await server.stop();
eq(await server.status(), "stopped", "server really is stopped");

const afterStop = await checkDatabase();
ok(true, "checkDatabase() with the server stopped RETURNED instead of throwing");
// It reports the state it found and leaves it alone. Starting a stopped server
// is `restart_database`'s job — a tool called `check` that silently fixed what
// it was asked to inspect would deny its caller the chance to decide.
eq(afterStop.connection.ok, false, "it reports that it cannot connect");
eq(afterStop.cluster.state, "stopped", "and reports the server as stopped");
eq(await server.status(), "stopped", "CHECKING DID NOT START IT");

// ===========================================================================
// 4. Restart
// ===========================================================================

await db.query(`SELECT 1`);
const restart = await restartDatabase();
eq(restart.wasRunning, true, "restart_database saw a running server");
eq(restart.ok, true, "RESTART BROUGHT THE DATABASE BACK");
ok(restart.elapsedMs > 0, "and reported how long it took");
eq(await server.status(), "running", "the server is running afterwards");

// Data has to survive it — that is the difference between a restart and a reset.
await db.query(
  `INSERT INTO items (item_id, institution_name, access_token_enc, source, status)
   VALUES ('survivor', 'Persisted Bank', 'aXY=.dGFn.Y2lwaGVy', 'plaid', 'active')`,
);
await restartDatabase();
const survived = await db.query<{ c: string }>(
  `SELECT COUNT(*)::text c FROM items WHERE item_id = 'survivor'`,
);
eq(survived.rows[0]!.c, "1", "DATA SURVIVES A RESTART");

// Restarting twice in a row is not an error.
const twice = await restartDatabase();
eq(twice.ok, true, "restarting again is fine (idempotent, as annotated)");

// ===========================================================================
// 5. Uptime — the signal that distinguishes "slow" from "restarting in a loop"
// ===========================================================================

const afterRestart = await checkDatabase();
const uptime = afterRestart.cluster.uptimeSeconds ?? Number.MAX_SAFE_INTEGER;
ok(uptime < 60, `uptime reflects the restart just performed (${uptime}s)`);
const restartText = formatHealth(afterRestart);
ok(restartText.includes("Uptime:"), "the report shows uptime");
ok(restartText.includes("moments ago"),
   "AND FLAGS A JUST-RESTARTED SERVER — a small number alone reads as noise");

// ===========================================================================
// 6. Cluster deleted underneath a live pool — the ugliest case
// ===========================================================================

await closeDb();
await server.stop();
await rm(`${HOME}/pg18`, { recursive: true, force: true });
await mkdir(HOME, { recursive: true });

const broken = await checkDatabase();
ok(true, "checkDatabase() with the cluster DELETED returned instead of throwing");
ok(typeof formatHealth(broken) === "string", "and the report still renders");
ok(formatHealth(broken).startsWith("Database:"), "...starting with the verdict");

await closeDb();
await wipe();

console.log(out.join("\n"));
console.log(fail === 0 ? `\nAll ${out.length} checks passed.` : `\n${fail} FAILED.`);
process.exit(fail === 0 ? 0 : 1);
