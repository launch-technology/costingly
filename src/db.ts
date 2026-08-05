/**
 * Database access.
 *
 *   default          The local PostgreSQL cluster costingly manages itself —
 *                    real Postgres binaries shipped as an npm dependency, no
 *                    Docker, nothing to install. See src/server.ts.
 *   DATABASE_URL set  Someone else's Postgres server. This is the path a Next.js
 *                    deployment on Vercel takes, pointed at Neon / Supabase /
 *                    Vercel Postgres, and the escape hatch for anyone who would
 *                    rather run their own.
 *
 * Both are ordinary Postgres over `pg`, so the only real difference is who
 * starts the server. Callers see `DbResult` / `DbClient` and never a driver
 * type.
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

// ---------------------------------------------------------------------------
// Where the data goes
// ---------------------------------------------------------------------------

function databaseUrl(): string | undefined {
  const url = process.env["DATABASE_URL"];
  return url !== undefined && url.trim() !== "" ? url : undefined;
}

/** True when queries go to a server costingly does not manage. */
export function usingRemoteDatabase(): boolean {
  return databaseUrl() !== undefined;
}

/**
 * Enable TLS unless the host is local.
 *
 * Hosted serverless Postgres requires TLS but commonly presents a chain Node
 * does not trust out of the box, hence `rejectUnauthorized: false` — the
 * standard configuration for these providers.
 */
function sslFor(connString: string): { rejectUnauthorized: boolean } | undefined {
  let hostname: string;
  try {
    hostname = new URL(connString).hostname;
  } catch {
    return undefined;
  }
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const isLocal =
    host === "" ||
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local");
  return isLocal ? undefined : { rejectUnauthorized: false };
}

async function createDriver(): Promise<Driver> {
  const url = databaseUrl();
  const managed = url === undefined;

  // Starting the cluster is the one thing the managed path adds. Both calls are
  // idempotent and return almost immediately once things exist, so every command
  // auto-starts the database and nothing above this line has to care. Creating
  // the database here rather than in `init` is what makes a half-finished setup
  // heal itself instead of failing with `database "costingly" does not exist`.
  if (managed) {
    await ensureServerRunning();
    await ensureDatabaseExists();
  }

  const connString = url ?? connectionString();

  const pgPkg = (await import("pg")).default;
  const { Pool, types } = pgPkg;

  types.setTypeParser(DATE_OID, keepAsSent);

  const pool = new Pool({
    connectionString: connString,
    ssl: sslFor(connString),
    // Serverless containers are short-lived and platforms cap connections. A
    // daily sync is not throughput-bound.
    max: managed ? 10 : 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
  });

  // Without this, a backend terminated by the server (idle timeout, failover, a
  // pooler recycling the connection) surfaces as an unhandled 'error' event and
  // takes the process down. pg evicts the dead client itself.
  pool.on("error", (error: Error) => {
    console.error("[db] idle client error (connection will be recycled):", error.message);
  });

  const describe = (): string => {
    if (managed) return "local PostgreSQL (managed by costingly)";
    try {
      return `Postgres at ${new URL(connString).host}`;
    } catch {
      return "Postgres at (unparseable DATABASE_URL)";
    }
  };

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
 *
 * Do NOT call from a serverless handler either: the container is reused between
 * invocations and the warm connections are worth keeping.
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
