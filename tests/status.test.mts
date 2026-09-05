/**
 * `costingly status` — one report over three artifacts.
 *
 * Two properties, and the second is the one that replaced a command:
 *
 *   1. It never throws. Every section records its own outcome, so a missing
 *      profile or an unreachable Plaid still produces a full report.
 *   2. IT NEVER WRITES. This is how a person confirms an uninstall, so a report
 *      that provisioned a cluster, allocated a port or generated credentials
 *      while describing them would answer "is it gone?" by putting it back.
 *      `costingly doctor` did exactly that, which is why it no longer exists.
 *
 * No Plaid credentials are set here, so the Plaid probe short-circuits before
 * any network call — the suite needs no sandbox and makes no requests.
 */

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";

const HOME = "/tmp/costingly-status";
process.env["COSTINGLY_HOME"] = HOME;

// Explicitly absent, so the Plaid section reports "not configured" rather than
// picking up whatever the developer's shell happens to have set.
delete process.env["PLAID_CLIENT_ID"];
delete process.env["PLAID_SECRET"];

const { db, closeDb, server, database } = await import("../src/index.js");
const { costinglyStatus } = await import("../src/domain/services/status.service.js");

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
  await rm(HOME, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
await wipe();

// ===========================================================================
// 1. Nothing installed — and asking must not change that
// ===========================================================================

const absent = await costinglyStatus();
ok(true, "costinglyStatus() on a missing profile RETURNED instead of throwing");
eq(existsSync(HOME), false, "REPORTING CREATED NOTHING");

eq(absent.profile.exists, false, "the profile reports itself absent");
eq(absent.profile.createdAt, null, "with no creation date");
eq(absent.profile.config.exists, false, "and no config.json");
eq(absent.profile.chosenBy, "COSTINGLY_HOME", "it names what chose the profile");

eq(absent.database.cluster.state, "uninitialised", "the database reports no cluster");
eq(absent.database.connection.ok, false, "and that it cannot connect");
eq(absent.database.cluster.listenAddress, "not allocated yet",
   "no port is invented for a profile that has never had one");

eq(absent.plaid.configured, false, "Plaid reports itself unconfigured");
eq(absent.plaid.reachable, false, "and therefore unreachable");
ok((absent.plaid.error ?? "").includes("credentials"), "saying which is missing");

eq(absent.banks, null, "banks are UNKNOWN, not empty — the database never answered");
eq(existsSync(HOME), false, "…and after all of that, still nothing was created");

// ===========================================================================
// 2. With a database — built explicitly, never as a side effect of reporting
// ===========================================================================

await database.ensureReady();

const live = await costinglyStatus();
eq(live.profile.exists, true, "the profile is now reported as present");
ok(live.profile.createdAt !== null, "with a creation date");
eq(live.profile.config.exists, true, "and a config.json");
eq(live.database.connection.ok, true, "the database connects");
eq(live.database.cluster.state, "running", "and is reported running");
ok((live.database.migrationsApplied ?? []).length > 0, "the schema is reported");
eq(live.banks, [], "banks are EMPTY now, which is a different answer from unknown");

// The Plaid section is independent: no credentials, but the database is fine.
eq(live.plaid.configured, false, "Plaid is still unconfigured");
eq(live.database.connection.ok, true, "…and that did not stop the database reporting");

// ===========================================================================
// 3. Server stopped — reported, not restarted
// ===========================================================================

await closeDb();
await server.stop();
eq(await server.status(), "stopped", "the server really is stopped");

const stopped = await costinglyStatus();
eq(stopped.database.cluster.state, "stopped", "status reports the server as stopped");
eq(stopped.database.connection.ok, false, "and that it cannot connect");
eq(await server.status(), "stopped", "REPORTING DID NOT START IT");
eq(stopped.profile.exists, true, "while the profile still reports present");
eq(stopped.banks, null, "and banks are unknown, because nothing was queried");

// ===========================================================================
// 4. The JSON contract
// ===========================================================================

const shape = JSON.parse(JSON.stringify(stopped)) as Record<string, unknown>;
eq(Object.keys(shape).sort(), ["banks", "database", "plaid", "profile", "version"],
   "--json exposes the three artifacts plus a version");

// A secret must never reach the report, in any section.
delete process.env["PLAID_CLIENT_ID"];
ok(!JSON.stringify(stopped).includes("password"), "the report carries no password field");

await closeDb();
await wipe();

console.log(out.join("\n"));
console.log(fail === 0 ? `\nAll ${out.length} checks passed.` : `\n${fail} FAILED.`);
process.exit(fail === 0 ? 0 : 1);
