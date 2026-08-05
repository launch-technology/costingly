/**
 * Database access, over one of two Postgres drivers.
 *
 *   default          PGlite — Postgres compiled to WASM, an ordinary npm
 *                    dependency. No Docker, no daemon, no port, nothing to
 *                    install. Data lives in a directory under the user's home.
 *   DATABASE_URL set node-postgres against a real server. This is the path a
 *                    Next.js deployment on Vercel takes, pointed at Neon /
 *                    Supabase / Vercel Postgres.
 *
 * Both are genuinely Postgres, so every query in this codebase is written once
 * and runs unchanged either way — which is the whole reason not to reach for
 * SQLite when "something lighter than Docker" is the goal.
 *
 * Callers see `DbResult` / `DbClient`, never a driver type. That is what keeps
 * the switch invisible above this module.
 */

import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { acquireDataDirLock } from "./lock.js";

/** Used for the data directory. One place to change if the product is renamed. */
const APP_NAME = "plaid-sync";

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
// Both drivers get the same treatment so a row looks identical either way:
//
//   DATE (OID 1082)    kept as the "YYYY-MM-DD" string Postgres sent. Parsing
//                      it into a JS Date builds it in local time under pg and
//                      UTC under PGlite — either way a calendar day like a
//                      Plaid transaction date can shift by one.
//   NUMERIC (OID 1700) left as a string by both drivers already. Parsing to a
//                      JS float would reintroduce the rounding NUMERIC exists
//                      to avoid.

const DATE_OID = 1082;
const keepAsSent = (value: string): string => value;

// ---------------------------------------------------------------------------
// Where local data lives
// ---------------------------------------------------------------------------

/**
 * Directory for the embedded database.
 *
 * `PLAID_SYNC_DATA_DIR` overrides it; otherwise XDG (`~/.local/share/...`),
 * which is predictable, easy to back up, and easy to delete.
 */
export function dataDir(): string {
  const override = process.env["PLAID_SYNC_DATA_DIR"];
  if (override !== undefined && override.trim() !== "") return override;

  const xdg = process.env["XDG_DATA_HOME"];
  const base = xdg !== undefined && xdg.trim() !== "" ? xdg : join(homedir(), ".local", "share");
  return join(base, APP_NAME, "pgdata");
}

function databaseUrl(): string | undefined {
  const url = process.env["DATABASE_URL"];
  return url !== undefined && url.trim() !== "" ? url : undefined;
}

/** True when queries will go to a real Postgres server rather than PGlite. */
export function usingRemoteDatabase(): boolean {
  return databaseUrl() !== undefined;
}

// ---------------------------------------------------------------------------
// PGlite driver (default)
// ---------------------------------------------------------------------------

async function createPgliteDriver(): Promise<Driver> {
  // Imported dynamically so a serverless deployment that sets DATABASE_URL
  // never pulls ~24MB of WASM into its bundle.
  const { PGlite } = await import("@electric-sql/pglite");
  const directory = dataDir();

  // PGlite's mkdir is not recursive: it creates the leaf only, so a first run
  // where ~/.local/share/<app>/ does not yet exist fails with ENOENT. Creating
  // the tree ourselves is the difference between "just works" and a stack trace
  // on somebody's very first command.
  await mkdir(directory, { recursive: true });

  // PGlite does no locking of its own, so two processes would open this
  // directory simultaneously and corrupt each other. See src/lock.ts — this
  // goes away when upstream PR #892 ships.
  const release = await acquireDataDirLock(directory);

  const db = await PGlite.create({
    dataDir: directory,
    parsers: { [DATE_OID]: keepAsSent },
  }).catch(async (error: unknown) => {
    // A failed boot must not orphan the lock, or the next run finds a live
    // holder that never actually opened anything.
    await release();
    throw error;
  });

  const run = async <T extends DbRow>(
    source: { query: (text: string, params?: unknown[]) => Promise<{ rows: T[]; affectedRows?: number }> },
    text: string,
    params?: readonly unknown[],
  ): Promise<DbResult<T>> => {
    const result = await source.query(text, params ? [...params] : undefined);
    return { rows: result.rows, rowCount: result.affectedRows ?? 0 };
  };

  return {
    query: (text, params) => run(db as never, text, params),
    execScript: async (sql) => {
      await db.exec(sql);
    },
    transaction: async (fn) =>
      db.transaction(async (tx) => fn({ query: (text, params) => run(tx as never, text, params) })),
    close: async () => {
      try {
        await db.close();
      } finally {
        // In `finally` on purpose: closeDb() swallows errors, so releasing only
        // on a successful close would silently leak the lock and leave the next
        // run reporting a busy database that is not.
        await release();
      }
    },
    describe: () => `PGlite (embedded) at ${directory}`,
  };
}

// ---------------------------------------------------------------------------
// node-postgres driver (when DATABASE_URL is set)
// ---------------------------------------------------------------------------

/**
 * Enable TLS unless the host is local.
 *
 * Hosted serverless Postgres requires TLS but commonly presents a chain Node
 * does not trust out of the box, hence `rejectUnauthorized: false` — the
 * standard configuration for these providers.
 */
function sslFor(connectionString: string): { rejectUnauthorized: boolean } | undefined {
  let hostname: string;
  try {
    hostname = new URL(connectionString).hostname;
  } catch {
    return undefined;
  }
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const isLocal =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local");
  return isLocal ? undefined : { rejectUnauthorized: false };
}

async function createPostgresDriver(connectionString: string): Promise<Driver> {
  const pgPkg = (await import("pg")).default;
  const { Pool, types } = pgPkg;

  types.setTypeParser(DATE_OID, keepAsSent);

  const pool = new Pool({
    connectionString,
    ssl: sslFor(connectionString),
    // Serverless containers are short-lived and platforms cap connections.
    // A daily sync is not throughput-bound.
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
  });

  // Without this, a backend terminated by the server (idle timeout, failover, a
  // pooler recycling the connection) surfaces as an unhandled 'error' event and
  // takes the process down. pg evicts the dead client itself.
  pool.on("error", (error: Error) => {
    console.error("[db] idle client error (connection will be recycled):", error.message);
  });

  const host = (() => {
    try {
      return new URL(connectionString).host;
    } catch {
      return "(unparseable DATABASE_URL)";
    }
  })();

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
    describe: () => `Postgres at ${host}`,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// Cached on globalThis for the same reason as before: Next.js hot reloads
// re-evaluate modules, and warm serverless containers reuse the process.
const globalForDb = globalThis as typeof globalThis & {
  __plaidSyncDriver?: Promise<Driver> | undefined;
};

function getDriver(): Promise<Driver> {
  const existing = globalForDb.__plaidSyncDriver;
  if (existing) return existing;

  const url = databaseUrl();
  const created = (url === undefined ? createPgliteDriver() : createPostgresDriver(url)).catch(
    (error: unknown) => {
      // Do not cache a rejected promise: it would re-throw on every later call,
      // including from closeDb() in the teardown path, where it surfaces as an
      // unhandled rejection on top of the real error.
      globalForDb.__plaidSyncDriver = undefined;
      throw error;
    },
  );
  globalForDb.__plaidSyncDriver = created;
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
 * Close the database. Call at the end of a CLI run so the process can exit.
 *
 * Do NOT call from a serverless handler — the container is reused between
 * invocations and the warm connections are worth keeping.
 */
export async function closeDb(): Promise<void> {
  const pending = globalForDb.__plaidSyncDriver;
  if (!pending) return;
  globalForDb.__plaidSyncDriver = undefined;
  try {
    const driver = await pending;
    await driver.close();
  } catch {
    // The driver never started. Whatever went wrong was already reported by
    // the command that triggered it; teardown must not report it twice.
  }
}
