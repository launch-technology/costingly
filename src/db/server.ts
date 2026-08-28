/**
 * Costingly's local PostgreSQL cluster.
 *
 * The lifecycle itself — initdb, pg_ctl, config generation, the socket — lives
 * in `cluster.ts`, which knows nothing about costingly and can be lifted into
 * another project as-is. This file is the binding: it decides *where* costingly
 * puts its cluster and what it is called, and re-exports the operations under
 * the names the rest of the codebase already uses.
 *
 * Costingly ships real Postgres binaries (PostgreSQL 18, from zonky's
 * embedded-postgres-binaries) as an ordinary npm dependency. No Docker, nothing
 * for the user to install, and — unlike the PGlite setup this replaced — real
 * MVCC, so a sync, a CLI read and a long-lived MCP server can all touch the
 * database at the same time.
 */

import { userInfo } from "node:os";
import { join } from "node:path";
import { APP_NAME, displayPath, profileDir } from "../profile.js";
import { PG_MAJOR, PostgresCluster, type ClusterConfig } from "./cluster.js";

export type { ServerState } from "./cluster.js";

/** The database inside the cluster. The cluster also has the default `postgres`. */
export const DATABASE_NAME = APP_NAME;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * The cluster directory (PGDATA).
 *
 * Always inside the profile, never configurable separately. A second lever for
 * "put the database somewhere else" would let the config and the cluster drift
 * into different places — which is exactly how a sandbox config once ended up
 * sharing a database with a production one, under a different encryption key.
 * To move the database, move the whole profile with `COSTINGLY_HOME`.
 *
 * The major version is in the name because a data directory belongs to exactly
 * one: a future upgrade creates a new cluster beside the old one rather than
 * failing with an error about `PG_VERSION`.
 */
export function clusterDir(): string {
  return join(profileDir(), `pg${PG_MAJOR}`);
}

/**
 * Where the unix socket lives — a sibling of the cluster, never inside it.
 *
 * PGDATA belongs to Postgres, and `initdb` refuses to run against a directory
 * that already has anything in it.
 */
export function socketDir(): string {
  return `${clusterDir()}-run`;
}

/** Postmaster log. `pg_ctl start` redirects both stdout and stderr here. */
export function serverLogPath(): string {
  return `${clusterDir()}.log`;
}

// ---------------------------------------------------------------------------
// The cluster
// ---------------------------------------------------------------------------

/**
 * Built fresh on every call, never cached.
 *
 * `profileDir()` reads COSTINGLY_HOME at call time, and the test suite changes
 * it between assertions. A cached instance would answer for whichever profile
 * happened to be active first — the kind of bug that only shows up as one suite
 * quietly reading another suite's database.
 */
function cluster(): PostgresCluster {
  return new PostgresCluster(clusterConfig());
}

/** The shape `cluster.ts` needs, filled in from costingly's profile. */
function clusterConfig(): ClusterConfig {
  return {
    dataDir: clusterDir(),
    databaseName: DATABASE_NAME,
    logPath: serverLogPath(),
    socketDir: socketDir(),
    user: userInfo().username,
  };
}

/** Connection string for the local cluster. */
export function connectionString(): string {
  return cluster().connectionString();
}

export function serverStatus(): ReturnType<PostgresCluster["status"]> {
  return cluster().status();
}

export function ensureServerRunning(): Promise<void> {
  return cluster().ensureRunning();
}

export function stopServer(): Promise<boolean> {
  return cluster().stop();
}

export function ensureDatabaseExists(): Promise<boolean> {
  return cluster().ensureDatabase();
}

/** Human-readable summary for `costingly status`. */
export async function describeServer(): Promise<string> {
  const state = await serverStatus();
  const where = displayPath(clusterDir());
  if (state === "running") return `PostgreSQL ${PG_MAJOR} running at ${where}`;
  if (state === "stopped") return `PostgreSQL ${PG_MAJOR} stopped at ${where}`;
  return `No database yet — run \`costingly init\``;
}
