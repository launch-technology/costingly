/**
 * Is the database working, and which one is it?
 *
 * THE ONE RULE: NOTHING HERE THROWS.
 *
 * A health check that fails when things are broken is worse than no health
 * check, because it fails exactly when someone needs it. Every layer below is
 * probed independently and records its own outcome, so a dead server still
 * produces a report — one that says the server is dead, which is the answer.
 *
 * The layers, cheapest and most reliable first:
 *
 *   1. profile     which directory, and what chose it     no I/O
 *   2. cluster     does the data directory exist          filesystem
 *   3. server      pg_ctl status                          reads a pid file
 *   4. connection  a round trip, and how long it took     needs a live server
 *   5. schema      which migrations are applied           needs a connection
 *
 * Layers 1-3 are the same facts `costingly doctor` reports, read through the
 * same functions in data/db/server.ts and core/profile.ts. This is a second
 * *renderer* of shared facts, not a second implementation of them — doctor
 * stops at layer 3 by design, because it must work when the server will not
 * start at all.
 *
 * DELIBERATELY NOT ABOUT THE DATA. No row counts, no date ranges, no last-sync
 * time. Those are questions for `query`, and answering them here would make
 * this the tool that gets called for everything. It reports on the database,
 * not on what is in it.
 *
 * The exception is WHICH PROFILE, which is not data but identity. Costingly
 * supports several — real money in one, `costingly seed` data in another — and
 * "which am I looking at?" is the first question in every confused session.
 */

import { db } from "../../data/default-database.js";
import { clusterDir, databaseCredentials, serverStatus } from "../../../platform/postgres/server.js";
import { profileDir, profileSource, displayPath } from "../../../platform/profile.js";
import { stat } from "node:fs/promises";

/** How long to wait for the probe before calling the connection dead. */
const PROBE_TIMEOUT_MS = 15_000;

export interface DatabaseHealth {
  profile: {
    path: string;
    /** "COSTINGLY_HOME" or "platform default". */
    chosenBy: string;
    exists: boolean;
  };
  cluster: {
    path: string;
    exists: boolean;
    /** "running" | "stopped" | "uninitialised" | "unknown". */
    state: string;
    /** Where the postmaster listens, as host:port. */
    listenAddress: string;
    /** Set when `pg_ctl status` itself failed. */
    error?: string;
    /** When the postmaster started. Null until a connection succeeds. */
    startedAt: string | null;
    /** Seconds since `startedAt`. Null until a connection succeeds. */
    uptimeSeconds: number | null;
  };
  connection: {
    ok: boolean;
    elapsedMs?: number;
    error?: string;
  };
  /**
   * Migrations recorded as applied, or null when they could not be read.
   *
   * Applied rather than pending: pending cannot be known here, because the
   * migration *list* is registered by the entry point, not owned by src/. It is
   * also nearly always empty — migrations run on the first connection, so by the
   * time this has connected they have already applied. What is worth seeing is
   * which ones a database has, e.g. an old profile that an updated build has not
   * opened yet.
   */
  migrationsApplied: string[] | null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Bound a probe that could otherwise hang.
 *
 * A Postgres server that is up but wedged accepts the socket and never answers,
 * which would hang the tool call until the client's own 60s timeout — reported
 * to the user as an unexplained failure rather than as "the database is not
 * responding".
 */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`no response after ${ms}ms`)), ms).unref(),
    ),
  ]);
}

export async function checkDatabase(): Promise<DatabaseHealth> {
  const { host, port } = await databaseCredentials();
  const health: DatabaseHealth = {
    profile: {
      path: displayPath(profileDir()),
      chosenBy: profileSource(),
      exists: await exists(profileDir()),
    },
    cluster: {
      path: displayPath(clusterDir()),
      exists: await exists(clusterDir()),
      state: "unknown",
      listenAddress: `${host}:${port}`,
      startedAt: null,
      uptimeSeconds: null,
    },
    connection: { ok: false },
    migrationsApplied: null,
  };

  try {
    health.cluster.state = await serverStatus();
  } catch (error) {
    health.cluster.error = message(error);
  }

  // Deliberately goes through the normal query path, which starts the server if
  // it is stopped. The question this tool answers is "can costingly reach its
  // data?", and auto-start is part of how it does — probing at a lower level
  // would report a failure a real tool call would not have hit.
  //
  // pg_postmaster_start_time() rather than SELECT 1: same round trip, and it
  // costs nothing to learn how long the server has been up. A near-zero uptime
  // is the signature of a server being restarted repeatedly, which is what two
  // copies of costingly competing for one cluster looks like from the inside.
  const started = Date.now();
  try {
    const { rows } = await withTimeout(
      db.query<{ started_at: string; uptime: string }>(
        // Formatted in SQL rather than cast to text: the raw value carries
        // microseconds and a timezone offset, which is noise in a line whose
        // only job is "roughly when did this start".
        `SELECT to_char(pg_postmaster_start_time(), 'YYYY-MM-DD HH24:MI')       AS started_at,
                EXTRACT(EPOCH FROM (now() - pg_postmaster_start_time()))::text  AS uptime`,
      ),
      PROBE_TIMEOUT_MS,
    );
    health.connection = { ok: true, elapsedMs: Date.now() - started };
    health.cluster.startedAt = rows[0]?.started_at ?? null;
    health.cluster.uptimeSeconds =
      rows[0] === undefined ? null : Math.max(0, Math.round(Number(rows[0].uptime)));
  } catch (error) {
    health.connection = { ok: false, elapsedMs: Date.now() - started, error: message(error) };
    return health;
  }

  try {
    const { rows } = await db.query<{ id: string }>(`SELECT id FROM schema_migrations ORDER BY id`);
    health.migrationsApplied = rows.map((r) => r.id);
  } catch (error) {
    // Connected but the ledger is unreadable — an un-migrated database, most
    // likely, which is itself the diagnosis. Noted without losing the report.
    health.connection.error = message(error);
  }

  return health;
}

export interface RestartOutcome {
  /** True if a server was running and was stopped. */
  wasRunning: boolean;
  /** True if a connection succeeded after the restart. */
  ok: boolean;
  elapsedMs: number;
  error?: string;
}

/**
 * Stop the server and bring it back.
 *
 * Stopping alone is never what anyone wants — it is a step towards being able
 * to connect again. So this completes the round trip and reports whether the
 * database actually came back, which is the only outcome worth telling someone
 * about. The restart itself is `stopServer()` plus a query, because opening a
 * connection is what starts the server.
 *
 * Loses no data. It can interrupt an in-flight sync, which resumes from its
 * stored cursor on the next run.
 */
export async function restartDatabase(): Promise<RestartOutcome> {
  const { closeDb } = await import("../../data/default-database.js");
  const { stopServer } = await import("../../../platform/postgres/server.js");

  const started = Date.now();

  // The pool must go first. Its sockets point at the postmaster we are about to
  // kill, and a pooled client that survives the restart hands out a dead
  // connection to the next caller.
  await closeDb().catch(() => {});

  let wasRunning = false;
  try {
    wasRunning = await stopServer();
  } catch (error) {
    return { wasRunning: false, ok: false, elapsedMs: Date.now() - started, error: message(error) };
  }

  try {
    await withTimeout(db.query(`SELECT 1`), PROBE_TIMEOUT_MS);
    return { wasRunning, ok: true, elapsedMs: Date.now() - started };
  } catch (error) {
    return { wasRunning, ok: false, elapsedMs: Date.now() - started, error: message(error) };
  }
}
