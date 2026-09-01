/**
 * Where a DataSource comes from.
 *
 * The single owner of "how do we connect to Postgres": what the connection
 * string is, which implementation suits which role, and what has to be shut
 * down at the end. Nothing else in the codebase constructs a pool or a client —
 * if code wants to reach the database, it asks here and gets a DataSource.
 *
 * TWO KINDS, AND THEY ARE NOT SYMMETRIC
 *
 *   app     pooled, as u_app, against the costingly database. Provisions the
 *           whole stack on first use.
 *   admin   unpooled, as the superuser, against whichever database is named.
 *           Provisions NOTHING.
 *
 * The asymmetry is load-bearing rather than an oversight. Provisioning is what
 * the admin source is *for* — it creates the database and the role the app
 * source needs — so an admin source that provisioned on first use would call
 * itself forever.
 */

import type { Client, Pool } from "pg";
import { connectionStringFor } from "../../postgres/credentials.js";
import { DATABASE_NAME, databaseCredentials } from "../../postgres/server.js";
import { provisionDatabase } from "./bootstrap.js";
import { reportDatabaseOpen } from "./migrations.js";
import { PooledDataSource } from "./pooled-data-source.js";
import { TransientDataSource } from "./transient-data-source.js";
import type { DataSource } from "./types/data-source.js";

// ---------------------------------------------------------------------------
// Type parsing
// ---------------------------------------------------------------------------
//   DATE (OID 1082)    kept as the "YYYY-MM-DD" string Postgres sent. Parsing it
//                      into a JS Date builds it in local time, so a calendar day
//                      like a Plaid transaction date can shift by one.
//   NUMERIC (OID 1700) left as a string by pg already. Parsing to a JS float
//                      would reintroduce the rounding NUMERIC exists to avoid.

const DATE_OID = 1082;
const keepAsSent = (value: string): string => value;

// ---------------------------------------------------------------------------
// Building the connections
// ---------------------------------------------------------------------------

/** Provision everything, then build the application pool. */
async function openAppPool(): Promise<Pool> {
  await provisionDatabase();

  const pgPkg = (await import("pg")).default;
  const { Pool: PgPool, types } = pgPkg;

  types.setTypeParser(DATE_OID, keepAsSent);

  const pool = new PgPool({
    connectionString: connectionStringFor(await databaseCredentials(), "app"),
    // No `ssl`: the listener is bound to loopback, so the bytes never leave the
    // machine and there is no network path to intercept.
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
  });

  // Without this, a backend terminated by the server (idle timeout, a crash)
  // surfaces as an unhandled 'error' event and takes the process down. pg
  // evicts the dead client itself.
  pool.on("error", (error: Error) => {
    console.error("[db] idle client error (connection will be recycled):", error.message);
  });

  return pool;
}

/** One connected superuser client against `database`. The caller closes it. */
async function connectAsSuperuser(database: string): Promise<Client> {
  const pgPkg = (await import("pg")).default;
  const client = new pgPkg.Client({
    connectionString: connectionStringFor(await databaseCredentials(), "superuser", database),
  });
  await client.connect();
  return client;
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

// Cached on globalThis because Next.js hot reloads re-evaluate modules and warm
// serverless containers reuse the process — a second pool over the same cluster
// would double the connection count without anyone asking for it.
const globalForDb = globalThis as typeof globalThis & {
  __costinglyAppDataSource?: PooledDataSource | undefined;
};

function appDataSource(): PooledDataSource {
  const existing = globalForDb.__costinglyAppDataSource;
  if (existing) return existing;

  const created = new PooledDataSource(
    openAppPool,
    "local PostgreSQL (managed by costingly)",
  );
  globalForDb.__costinglyAppDataSource = created;
  return created;
}

reportDatabaseOpen(() => globalForDb.__costinglyAppDataSource?.isOpen() === true);

/**
 * The application database. Lazy — nothing opens until the first query.
 *
 * This is what services, commands and tools hand to repositories.
 */
export const db: DataSource = appDataSource();

/**
 * The superuser, against one named database.
 *
 * Not cached: it holds no connection between calls, so there is no instance
 * state worth keeping and nothing to close.
 */
export function adminDataSource(database: string = DATABASE_NAME): DataSource {
  return new TransientDataSource(
    () => connectAsSuperuser(database),
    `local PostgreSQL as superuser (${database})`,
  );
}

/**
 * Close this process's connections. Call at the end of a CLI run so it can exit.
 *
 * Only the pool holds anything: admin sources close their connection at the end
 * of every call by construction.
 *
 * This does NOT stop the database — the server is shared and long-lived, and
 * stopping it is what `costingly stop` is for.
 */
export async function closeDb(): Promise<void> {
  // The instance stays registered and reopens on its next query. Dropping it
  // from the registry instead would leave `db` — bound at import — pointing at
  // an instance the registry no longer knows about, and a later caller would
  // build a second pool over the same cluster.
  await globalForDb.__costinglyAppDataSource?.close();
}
