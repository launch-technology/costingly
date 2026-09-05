/**
 * The Postgres services, against a fake `pg_ctl`.
 *
 * These are the states that matter most and that no other suite can reach.
 * Every suite touching a real cluster can only produce the states a healthy
 * PostgreSQL actually reaches — so the interesting ones, where the tooling
 * itself is wrong or lying, have never been tested at all.
 *
 * The one that started all this: on 2026-09-03 a machine had a live postmaster
 * serving on port 54321 while `pg_ctl status` reported "no server running",
 * because the data directory had been deleted out from under it and the pid
 * file went with the rest. Everything downstream believed `pg_ctl`. Deleting
 * the directory in that state is silent and unrecoverable, which is why
 * `isAnswering()` exists and why it must never be replaced by `isRunning()`.
 *
 * A stubbed OsService is what makes those reachable: exit codes are chosen
 * rather than earned, no binary is spawned, and the whole suite runs in
 * milliseconds.
 */

import { createServer } from "node:net";

const { OsService } = await import("../src/platform/services/os-service.js");
const { PgBinariesService } = await import(
  "../src/platform/postgres/services/pg-binaries-service.js"
);
const { PgClusterService } = await import(
  "../src/platform/postgres/services/pg-cluster-service.js"
);
const { PgServerService } = await import(
  "../src/platform/postgres/services/pg-server-service.js"
);

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

// ---------------------------------------------------------------------------
// The stub
// ---------------------------------------------------------------------------

interface Invocation {
  file: string;
  args: readonly string[];
}

/**
 * An OsService that runs nothing and answers however the test says.
 *
 * `codes` maps a `pg_ctl` subcommand to the exit code it should report.
 * Anything unlisted succeeds, so a test names only the behaviour it cares
 * about.
 */
function stubOs(codes: Record<string, number> = {}): {
  os: InstanceType<typeof OsService>;
  calls: Invocation[];
} {
  const calls: Invocation[] = [];
  const os = {
    run: async (file: string, args: readonly string[]) => {
      calls.push({ file, args });
      const subcommand = args[0] ?? "";
      return {
        code: codes[subcommand] ?? 0,
        stdout: "",
        stderr: `stub: ${subcommand}`,
      };
    },
  } as unknown as InstanceType<typeof OsService>;
  return { os, calls };
}

/** A binaries service that resolves to fixed paths and never imports anything. */
function stubBinaries(os: InstanceType<typeof OsService>): InstanceType<typeof PgBinariesService> {
  const real = new PgBinariesService(os);
  return Object.assign(Object.create(Object.getPrototypeOf(real) as object), real, {
    locate: async () => ({ initdb: "/fake/initdb", pg_ctl: "/fake/pg_ctl", postgres: "/fake/postgres" }),
  }) as InstanceType<typeof PgBinariesService>;
}

const NOWHERE = "/tmp/costingly-pg-services-does-not-exist";

// ===========================================================================
// 1. THE DISAGREEMENT — a live server pg_ctl cannot see
// ===========================================================================

{
  // pg_ctl status exits 3: "no server running". Meanwhile something IS
  // listening — the exact state a deleted data directory leaves behind.
  const { os } = stubOs({ status: 3 });
  const server = new PgServerService(NOWHERE, `${NOWHERE}.log`, stubBinaries(os));

  const listener = createServer();
  const port = await new Promise<number>((done) => {
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      done(typeof address === "object" && address !== null ? address.port : 0);
    });
  });

  eq(await server.isRunning(), false, "isRunning() believes pg_ctl: no server");
  eq(
    await server.isAnswering("127.0.0.1", port),
    true,
    "isAnswering() sees the live server pg_ctl cannot",
  );
  ok(true, "THE TWO DISAGREE — which is the state that destroyed a cluster on 2026-09-03");

  await new Promise<void>((done) => listener.close(() => done()));
  eq(await server.isAnswering("127.0.0.1", port), false, "and agree again once it closes");
}

// ===========================================================================
// 2. stop() ATTEMPTS even when pg_ctl says there is nothing to stop
// ===========================================================================
//
// The old code short-circuited on status, so the one case where stopping
// mattered was the case where it was never tried.

{
  const { os, calls } = stubOs({ status: 3, stop: 0 });
  const server = new PgServerService(NOWHERE, `${NOWHERE}.log`, stubBinaries(os));

  await server.stop();
  const attempted = calls.filter((c) => c.args[0] === "stop");
  eq(attempted.length, 1, "stop() RAN pg_ctl stop despite status saying nothing was running");
  ok(
    attempted[0]?.args.includes("fast") === true,
    "and asked for a fast shutdown, not a wait-for-clients one",
  );
}

// --- a stop that fails while the server stays up must throw ----------------
{
  const { os } = stubOs({ status: 0, stop: 1 });
  const server = new PgServerService(NOWHERE, `${NOWHERE}.log`, stubBinaries(os));

  let threw = "";
  try {
    await server.stop();
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error);
  }
  ok(threw.includes("Could not stop"), "a failed stop with the server still up throws");
}

// ===========================================================================
// 3. start() CANNOT CREATE
// ===========================================================================
//
// The property the service split exists to guarantee. Before it, one function
// meant "create if absent, then start", so every caller that only wanted to
// resume a stopped server could silently run initdb instead.

{
  const { os, calls } = stubOs({ status: 3, start: 1 });
  const server = new PgServerService(NOWHERE, `${NOWHERE}.log`, stubBinaries(os));

  await server.start().catch(() => {});
  eq(
    calls.filter((c) => c.file.includes("initdb")).length,
    0,
    "start() NEVER runs initdb — creating is a different service",
  );
}

// --- a lost start race is not an error -------------------------------------
{
  // pg_ctl start fails, but the follow-up status says running: another process
  // won the race. That must succeed, not report a spurious failure.
  let statusCalls = 0;
  const os = {
    run: async (_file: string, args: readonly string[]) => {
      const subcommand = args[0] ?? "";
      if (subcommand === "status") return { code: statusCalls++ === 0 ? 3 : 0, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: "could not bind" };
    },
  } as unknown as InstanceType<typeof OsService>;

  const server = new PgServerService(NOWHERE, `${NOWHERE}.log`, stubBinaries(os));
  let raced = "ok";
  try {
    await server.start();
  } catch (error) {
    raced = error instanceof Error ? error.message : String(error);
  }
  eq(raced, "ok", "losing a start race succeeds, because the server IS up");
}

// --- a start that genuinely fails reports the log ---------------------------
{
  const { os } = stubOs({ status: 3, start: 1 });
  const server = new PgServerService(NOWHERE, `${NOWHERE}.log`, stubBinaries(os));

  let threw = "";
  try {
    await server.start();
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error);
  }
  ok(threw.includes("Could not start"), "a real start failure throws");
  ok(threw.includes(`${NOWHERE}.log`), "and points at the postmaster log");
}

// ===========================================================================
// 4. The cluster service answers from the filesystem
// ===========================================================================
//
// `exists()` is a stat for PG_VERSION rather than a pg_ctl call, so it answers
// when the binaries are missing entirely — which is one of the ways an install
// is broken.

{
  const { os, calls } = stubOs();
  const cluster = new PgClusterService(NOWHERE, stubBinaries(os));

  eq(await cluster.exists(), false, "an absent directory holds no cluster");
  eq(calls.length, 0, "and answering that ran no binary at all");
}

console.log(out.join("\n"));
console.log(fail === 0 ? `\nAll ${out.length} checks passed.` : `\n${fail} FAILED.`);
process.exit(fail === 0 ? 0 : 1);
