/**
 * Costingly's local PostgreSQL cluster.
 *
 * The lifecycle itself — initdb, pg_ctl, config generation — lives in
 * `postgres-cluster.ts`, which knows nothing about costingly and can be lifted
 * into another project as-is. This file is the binding: it decides *where*
 * costingly puts its cluster, what port it listens on, and which credentials it
 * uses, then hands those down as plain values.
 *
 * Costingly ships real Postgres binaries (PostgreSQL 18) as an ordinary npm
 * dependency. No Docker, nothing for the user to install, and — unlike the
 * PGlite setup this replaced — real MVCC, so a sync, a CLI read and a
 * long-lived MCP server can all touch the database at the same time.
 */

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { APP_NAME, displayPath, profileDir } from "../profile.js";
import { readDatabaseLogins, writeDatabaseLogins, type DatabaseLogins } from "../config-store.js";
import { ports } from "../ports.js";
import { ROLE_APP, ROLE_SUPERUSER, type DbCredentials } from "./credentials.js";
import { PG_MAJOR, PostgresCluster, type ClusterConfig } from "./cluster.js";

export type { ServerState } from "./cluster.js";

/** The database inside the cluster. The cluster also has the default `postgres`. */
export const DATABASE_NAME = APP_NAME;

/** Loopback only. Never 0.0.0.0 — that would put bank data on the network. */
const HOST = "127.0.0.1";

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

/** Postmaster log. `pg_ctl start` redirects both stdout and stderr here. */
export function serverLogPath(): string {
  return `${clusterDir()}.log`;
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/** 24 random bytes. Long enough that nothing is gained by making it longer. */
function generatePassword(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * The database logins, generating and storing them on first use.
 *
 * Generated here rather than by a migration because `initdb` needs the superuser
 * password before any SQL can run at all. Both are written before the cluster is
 * created, so a crash midway leaves stored credentials that match a cluster
 * which does not exist yet — recoverable — rather than a cluster nothing holds
 * the password for.
 */
function databaseLogins(): DatabaseLogins {
  const existing = readDatabaseLogins();
  if (existing !== undefined) return existing;

  const created: DatabaseLogins = {
    superuser: { user: ROLE_SUPERUSER, password: generatePassword() },
    app: { user: ROLE_APP, password: generatePassword() },
  };
  writeDatabaseLogins(created);
  return created;
}

/**
 * Everything needed to connect, as either identity.
 *
 * The port is allocated only when the server is NOT already running. A running
 * postmaster holds its port legitimately; probing would find it taken, step to
 * the next one, and start a second server that then fails on the data directory
 * lock. `status()` reads postmaster.pid and needs no port, so it is safe to ask
 * before one exists.
 */
export async function databaseCredentials(): Promise<DbCredentials> {
  const logins = databaseLogins();

  // A running server is the authority on its own port. Asking the allocator
  // instead would step over the port it legitimately holds and hand back one
  // nothing is listening on — which is exactly what happens when two processes
  // start at the same moment.
  const live = await new PostgresCluster(clusterConfig(0)).runningPort();
  const port = live ?? (await ports().allocate("database"));

  return { host: HOST, port, database: DATABASE_NAME, logins };
}

// ---------------------------------------------------------------------------
// The cluster
// ---------------------------------------------------------------------------

/** The shape `postgres-cluster.ts` needs, filled in from costingly's profile. */
function clusterConfig(port: number): ClusterConfig {
  return {
    dataDir: clusterDir(),
    databaseName: DATABASE_NAME,
    logPath: serverLogPath(),
    host: HOST,
    port,
    superuser: databaseLogins().superuser,
  };
}

/**
 * Built fresh on every call, never cached.
 *
 * `profileDir()` reads COSTINGLY_HOME at call time, and the test suite changes
 * it between assertions. A cached instance would answer for whichever profile
 * happened to be active first — the kind of bug that only shows up as one suite
 * quietly reading another suite's database.
 *
 * `status` and `stop` work from PGDATA alone, so they pass port 0: the value is
 * never used and inventing one would imply a choice that has not been made.
 */
export function serverStatus(): ReturnType<PostgresCluster["status"]> {
  return new PostgresCluster(clusterConfig(0)).status();
}

export function stopServer(): Promise<boolean> {
  return new PostgresCluster(clusterConfig(0)).stop();
}

export async function ensureServerRunning(): Promise<void> {
  const { port } = await databaseCredentials();
  return new PostgresCluster(clusterConfig(port)).ensureRunning();
}

/** Human-readable summary for `costingly status`. */
export async function describeServer(): Promise<string> {
  const state = await serverStatus();
  const where = displayPath(clusterDir());
  if (state === "running") return `PostgreSQL ${PG_MAJOR} running at ${where}`;
  if (state === "stopped") return `PostgreSQL ${PG_MAJOR} stopped at ${where}`;
  return `No database yet — run \`costingly init\``;
}
