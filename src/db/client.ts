/**
 * Database access.
 *
 * One mode: the local PostgreSQL cluster costingly manages itself, inside the
 * profile (see src/profile.ts and src/db/server.ts). The connection is derived,
 * never configured — a unix socket under the profile, peer authentication, no
 * host, no port, no password. There is nothing to set and nothing that can
 * disagree with where the cluster actually is.
 *
 * There used to be a second mode behind DATABASE_URL, for a hosted Postgres on
 * Vercel. It was removed: nothing exercised it, and it put a two-way branch in
 * seven files. Restoring it is a connection-string source, not an architecture —
 * what actually preserves that option is the dialect, which is unchanged.
 */

import { connectionString, ensureDatabaseExists, ensureServerRunning } from "./server.js";

// ---------------------------------------------------------------------------
// Driver-agnostic surface
// ---------------------------------------------------------------------------

/** Rows are plain objects; column types are decided by the type parsers below. */
export type DbRow = Record<string, any>;

export interface DbResult<T extends DbRow = DbRow> {
  rows: T[];
  /** Rows affected by INSERT/UPDATE/DELETE. 0 for SELECT-shaped statements. */
  rowCount: number;
}

/** Anything queries can run against — the pool, or a transaction. */
export interface DbClient {
  query<T extends DbRow = DbRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<DbResult<T>>;
}

interface Driver extends DbClient {
  /** Run a multi-statement script (schema.sql). Not parameterised. */
  execScript(sql: string): Promise<void>;
  transaction<T>(fn: (client: DbClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  describe(): string;
}

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

async function createDriver(): Promise<Driver> {
  // Both calls are idempotent and return almost immediately once things exist,
  // so every command auto-starts the database and nothing above this line has
  // to care. Creating the database here rather than in `init` is what makes a
  // half-finished setup heal itself instead of failing with
  // `database "costingly" does not exist`.
  await ensureServerRunning();
  await ensureDatabaseExists();

  const pgPkg = (await import("pg")).default;
  const { Pool, types } = pgPkg;

  types.setTypeParser(DATE_OID, keepAsSent);

  const pool = new Pool({
    connectionString: connectionString(),
    // No `ssl`: a unix socket is not a network connection, so there is nothing
    // to encrypt and no certificate to verify.
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

  const describe = (): string => "local PostgreSQL (managed by costingly)";

  return {
    query: async (text, params) => {
      const result = await pool.query(text, params ? [...params] : undefined);
      return { rows: result.rows, rowCount: result.rowCount ?? 0 };
    },
    execScript: async (sql) => {
      // pg sends multi-statement strings in one implicit transaction.
      await pool.query(sql);
    },
    transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn({
          query: async (text, params) => {
            const r = await client.query(text, params ? [...params] : undefined);
            return { rows: r.rows, rowCount: r.rowCount ?? 0 };
          },
        });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          console.error(
            "[db] ROLLBACK failed:",
            rollbackError instanceof Error ? rollbackError.message : rollbackError,
          );
        }
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
    describe,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// Cached on globalThis because Next.js hot reloads re-evaluate modules and warm
// serverless containers reuse the process.
const globalForDb = globalThis as typeof globalThis & {
  __costinglyDriver?: Promise<Driver> | undefined;
};

function getDriver(): Promise<Driver> {
  const existing = globalForDb.__costinglyDriver;
  if (existing) return existing;

  const created = createDriver().catch((error: unknown) => {
    // Do not cache a rejected promise: it would re-throw on every later call,
    // including from closeDb() in the teardown path, where it surfaces as an
    // unhandled rejection on top of the real error.
    globalForDb.__costinglyDriver = undefined;
    throw error;
  });
  globalForDb.__costinglyDriver = created;
  return created;
}

/** Run a one-off query. */
export async function query<T extends DbRow = DbRow>(
  text: string,
  params?: readonly unknown[],
): Promise<DbResult<T>> {
  const driver = await getDriver();
  return driver.query<T>(text, params);
}

/** Apply a multi-statement script such as schema.sql. */
export async function execScript(sql: string): Promise<void> {
  const driver = await getDriver();
  return driver.execScript(sql);
}

/**
 * Run `fn` inside a single transaction.
 *
 * Every write for a given Plaid Item goes through here, so a run either applies
 * all of that item's changes *and* advances its cursor, or applies none of
 * them. There is no state where the cursor has moved past changes that were
 * never written — which is what makes the sync safely re-runnable.
 */
export async function withTransaction<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
  const driver = await getDriver();
  return driver.transaction(fn);
}

/** Human-readable description of where data is going. For status output. */
export async function describeDriver(): Promise<string> {
  const driver = await getDriver();
  return driver.describe();
}

/**
 * Close this process's connections. Call at the end of a CLI run so it can exit.
 *
 * This does NOT stop the database — the server is shared and long-lived, and
 * stopping it is what `costingly stop` is for.
 */
export async function closeDb(): Promise<void> {
  const pending = globalForDb.__costinglyDriver;
  if (!pending) return;
  globalForDb.__costinglyDriver = undefined;
  try {
    const driver = await pending;
    await driver.close();
  } catch {
    // The driver never started. Whatever went wrong was already reported by the
    // command that triggered it; teardown must not report it twice.
  }
}
