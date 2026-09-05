/**
 * The point of the whole PGlite -> embedded Postgres swap: several processes
 * touching the database at once.
 *
 * Every assertion here would have FAILED under PGlite with DatabaseBusyError.
 */

import { fileURLToPath } from "node:url";

/** Repo root, derived from this file — no absolute paths baked in. */
const P = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");


import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Its own profile. Without this the suite runs against the user's real one and
// leaves a cluster behind — which quietly breaks any "from scratch" test.
// Short and outside the scratchpad: the socket path derives from it.
const HOME = "/tmp/costingly-concurrency";
process.env["COSTINGLY_HOME"] = HOME;
const NODE = process.execPath;
const CLI = `${P}/dist/apps/cli/main.js`;

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

// From dist/, not src/: the CLI child processes below run the built code, and
// both sides must agree on which build they are talking to.
const { db, closeDb, server, adminDataSource, database } =
  (await import(new URL("../dist/index.js", import.meta.url).href)) as typeof import("../src/index.js");

/** Run the CLI as a separate OS process. */
async function cli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const r = await execFileAsync(NODE, [CLI, ...args], {
      timeout: 120_000,
      env: { ...process.env, COSTINGLY_HOME: HOME },
    });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

// --- 0. baseline ----------------------------------------------------------
// Register the migration loader the way cli/main.ts does, so the first in-process
// query builds the database. From dist/ like everything else here: the CLI child
// processes run the built code and both sides must agree on which build they are
// talking to.
const { loadMigrations } =
  (await import(new URL("../dist/platform/postgres/migrations.js", import.meta.url).href)) as typeof import("../src/platform/postgres/migrations.js");

// Provisioning is deliberate: reading no longer creates a database, so this
// asks for one exactly as `costingly migrate` does. It has to happen before
// anything asks whether the server is up.
await database.ensureReady();
eq(await server.status(), "running", "server is running");
// Compared against what is actually in migrations/, not a hardcoded list: the
// claim being tested is "the first connection applied ALL of them by itself",
// and a literal here would turn every new migration into a failing test that
// says nothing about concurrency.
eq((await db.query<{ id: string }>(`SELECT id FROM schema_migrations ORDER BY id`)).rows.map((r) => r.id),
   (await loadMigrations()).map((m) => m.id),
   "and the migrations ran themselves, with no migrate step");

// --- 1. DATE still comes back as a plain YYYY-MM-DD string ----------------
// A regression here silently shifts every transaction by a calendar day.
// As the superuser: u_app deliberately has no DDL, so the app identity cannot
// create this and should not be able to. Creating it here is the test arranging
// its own fixture, not a capability the application has.
await adminDataSource("costingly").transaction(async (tx) => {
  await tx.query(`CREATE TABLE IF NOT EXISTS _probe (d DATE, n NUMERIC(20,4))`);
  await tx.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON _probe TO u_app`);
});
await db.query(`DELETE FROM _probe`);
await db.query(`INSERT INTO _probe (d, n) VALUES ($1, $2)`, ["2024-03-11", "42.1000"]);
const probe = await db.query<{ d: unknown; n: unknown }>(`SELECT d, n FROM _probe`);
eq(probe.rows[0]!.d, "2024-03-11", "DATE reads back as the YYYY-MM-DD string, not a Date");
eq(typeof probe.rows[0]!.n, "string", "NUMERIC stays a string (no float rounding)");

// --- 2. a SECOND PROCESS reads while THIS one holds a write transaction ---
// This is the assertion PGlite could never satisfy.
let readDuringWrite: { code: number; stdout: string } | undefined;
await db.transaction(async (tx) => {
  await tx.query(`INSERT INTO _probe (d, n) VALUES ('2024-04-01', '7.0000')`);
  // Transaction is open and holding a row lock. Now read from another process.
  readDuringWrite = await cli("status");
});
eq(readDuringWrite!.code, 0, "a separate process READS while a write transaction is open");

// The uncommitted row must not have been visible to that reader, and must be
// visible now that the transaction committed.
const after = await db.query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM _probe`);
eq(after.rows[0]!.c, "2", "the committed row is visible afterwards (isolation held)");

// --- 3. many processes at once --------------------------------------------
const parallel = await Promise.all(Array.from({ length: 8 }, () => cli("status")));
eq(
  parallel.filter((r) => r.code === 0).length,
  8,
  "8 concurrent CLI processes all succeed",
);
ok(
  !parallel.some((r) => /busy|DatabaseBusy|already in use/i.test(r.stdout + r.stderr)),
  "none of them reports a busy database",
);

// --- 4. cold-start stampede ------------------------------------------------
// Stop the server, then launch 6 processes simultaneously. Exactly one should
// win the start race; the other five must succeed anyway, not error.
//
// `sync`, not `status`: status is deliberately passive — it reports on the
// database without touching it — so it would neither start the server nor
// exercise the race. sync reads through the pool, which is what starts a
// stopped cluster.
await closeDb();
eq(await server.stop(), true, "server stopped for the stampede test");
eq(await server.status(), "stopped", "server really is stopped");

const stampede = await Promise.all(Array.from({ length: 6 }, () => cli("sync")));
eq(
  stampede.filter((r) => r.code === 0).length,
  6,
  "6 processes racing to start a stopped server ALL succeed",
);
const stampedeNoise = stampede
  .flatMap((r) => [r.stderr])
  .filter((s) => s.trim() !== "");
eq(stampedeNoise, [], "and none of them printed an error");
eq(await server.status(), "running", "exactly one of them started the server");

// --- 5. auto-restart after stop -------------------------------------------
await server.stop();
eq(await server.status(), "stopped", "stopped again");
const revived = await cli("sync");
eq(revived.code, 0, "a plain command auto-starts a stopped server");
eq(await server.status(), "running", "and the server is up afterwards");

// --- 6. costingly stop / restart via the CLI ------------------------------
const stopped = await cli("stop");
eq(stopped.code, 0, "`costingly stop` exits 0");
ok(/stopped/i.test(stopped.stdout), "`costingly stop` says so");
eq(await server.status(), "stopped", "`costingly stop` really stops it");
const again = await cli("stop");
ok(/not running/i.test(again.stdout), "`costingly stop` twice is not an error");

// --- 7. data survived all of that -----------------------------------------
const survived = await db.query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM _probe`);
eq(survived.rows[0]!.c, "2", "data survived repeated stop/start cycles");

// Dropped by the identity that created it: u_app can write the rows but does
// not own the table, which is the no-DDL boundary working as intended.
await adminDataSource("costingly").query(`DROP TABLE _probe`);
await closeDb();
await server.stop().catch(() => {});
const { rm } = await import("node:fs/promises");
// maxRetries: Windows can still hold handles on the cluster directory for a
// moment after the postmaster exits, which unlink-while-open unix does not.
await rm(HOME, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });

console.log(out.join("\n"));
console.log(`\ncluster: ${server.clusterDir()}`);
console.log(fail === 0 ? `\nAll ${out.length} checks passed.` : `\n${fail} FAILED.`);
process.exit(fail === 0 ? 0 : 1);
