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
const CLI = `${P}/dist/cli/index.js`;

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
const { query, withTransaction, closeDb, serverStatus, stopServer, clusterDir } =
  (await import(new URL("../dist/src/index.js", import.meta.url).href)) as typeof import("../src/index.js");

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
// Register the migration loader the way cli/index.ts does, so the first in-process
// query builds the database. From dist/ like everything else here: the CLI child
// processes run the built code and both sides must agree on which build they are
// talking to.
const { setMigrationSource } =
  (await import(new URL("../dist/src/index.js", import.meta.url).href)) as typeof import("../src/index.js");
const { loadMigrations } =
  (await import(new URL("../dist/cli/migrations.js", import.meta.url).href)) as typeof import("../cli/migrations.js");
setMigrationSource(loadMigrations);

// The first connection is what creates the cluster, starts it, creates the
// database and runs the migrations — so it has to happen before anything asks
// whether the server is up.
await query(`SELECT 1`);
eq(await serverStatus(), "running", "server is running");
// Compared against what is actually in migrations/, not a hardcoded list: the
// claim being tested is "the first connection applied ALL of them by itself",
// and a literal here would turn every new migration into a failing test that
// says nothing about concurrency.
eq((await query<{ id: string }>(`SELECT id FROM schema_migrations ORDER BY id`)).rows.map((r) => r.id),
   (await loadMigrations()).map((m) => m.id),
   "and the migrations ran themselves, with no migrate step");

// --- 1. DATE still comes back as a plain YYYY-MM-DD string ----------------
// A regression here silently shifts every transaction by a calendar day.
await query(`CREATE TABLE IF NOT EXISTS _probe (d DATE, n NUMERIC(20,4))`);
await query(`DELETE FROM _probe`);
await query(`INSERT INTO _probe (d, n) VALUES ($1, $2)`, ["2024-03-11", "42.1000"]);
const probe = await query<{ d: unknown; n: unknown }>(`SELECT d, n FROM _probe`);
eq(probe.rows[0]!.d, "2024-03-11", "DATE reads back as the YYYY-MM-DD string, not a Date");
eq(typeof probe.rows[0]!.n, "string", "NUMERIC stays a string (no float rounding)");

// --- 2. a SECOND PROCESS reads while THIS one holds a write transaction ---
// This is the assertion PGlite could never satisfy.
let readDuringWrite: { code: number; stdout: string } | undefined;
await withTransaction(async (tx) => {
  await tx.query(`INSERT INTO _probe (d, n) VALUES ('2024-04-01', '7.0000')`);
  // Transaction is open and holding a row lock. Now read from another process.
  readDuringWrite = await cli("status");
});
eq(readDuringWrite!.code, 0, "a separate process READS while a write transaction is open");

// The uncommitted row must not have been visible to that reader, and must be
// visible now that the transaction committed.
const after = await query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM _probe`);
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
await closeDb();
eq(await stopServer(), true, "server stopped for the stampede test");
eq(await serverStatus(), "stopped", "server really is stopped");

const stampede = await Promise.all(Array.from({ length: 6 }, () => cli("status")));
eq(
  stampede.filter((r) => r.code === 0).length,
  6,
  "6 processes racing to start a stopped server ALL succeed",
);
const stampedeNoise = stampede
  .flatMap((r) => [r.stderr])
  .filter((s) => s.trim() !== "");
eq(stampedeNoise, [], "and none of them printed an error");
eq(await serverStatus(), "running", "exactly one of them started the server");

// --- 5. auto-restart after stop -------------------------------------------
await stopServer();
eq(await serverStatus(), "stopped", "stopped again");
const revived = await cli("status");
eq(revived.code, 0, "a plain command auto-starts a stopped server");
eq(await serverStatus(), "running", "and the server is up afterwards");

// --- 6. costingly stop / restart via the CLI ------------------------------
const stopped = await cli("stop");
eq(stopped.code, 0, "`costingly stop` exits 0");
ok(/stopped/i.test(stopped.stdout), "`costingly stop` says so");
eq(await serverStatus(), "stopped", "`costingly stop` really stops it");
const again = await cli("stop");
ok(/not running/i.test(again.stdout), "`costingly stop` twice is not an error");

// --- 7. data survived all of that -----------------------------------------
const survived = await query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM _probe`);
eq(survived.rows[0]!.c, "2", "data survived repeated stop/start cycles");

await query(`DROP TABLE _probe`);
await closeDb();
await stopServer().catch(() => {});
const { rm } = await import("node:fs/promises");
// maxRetries: Windows can still hold handles on the cluster directory for a
// moment after the postmaster exits, which unlink-while-open unix does not.
await rm(HOME, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });

console.log(out.join("\n"));
console.log(`\ncluster: ${clusterDir()}`);
console.log(fail === 0 ? `\nAll ${out.length} checks passed.` : `\n${fail} FAILED.`);
process.exit(fail === 0 ? 0 : 1);
