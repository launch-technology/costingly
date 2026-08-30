/**
 * Handing out database connections.
 *
 * The only file that opens one. Everything above it — queries, provisioning,
 * migrations — receives a connection rather than making its own, which is what
 * keeps "who may talk to the database, and as whom" answerable by reading a
 * single file.
 *
 * It knows how to talk to a database that already exists, and nothing else. No
 * provisioning, no DDL, no migrations. Keeping it that narrow is what makes the
 * pool testable separately from everything that has to happen before a pool is
 * useful.
 */

import { connectionStringFor, type DbIdentity } from "./credentials.js";
import { databaseCredentials } from "./server.js";

// ---------------------------------------------------------------------------
// What a connection can do
// ---------------------------------------------------------------------------

/** Rows are plain objects; column types are decided by the type parsers below. */
export type DbRow = Record<string, any>;

export interface DbResult<T extends DbRow = DbRow> {
  rows: T[];
  /** Rows affected by INSERT/UPDATE/DELETE. 0 for SELECT-shaped statements. */
  rowCount: number;
  /**
   * Column names in select order.
   *
   * Comes from the result descriptor, not from the rows, so it is still correct
   * when the query matched nothing — which is exactly when a caller most needs
   * to know what shape the answer would have had.
   */
  columns: string[];
}

/** Anything queries can run against — the pool, or a transaction. */
export interface DbClient {
  query<T extends DbRow = DbRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<DbResult<T>>;
}

export interface Driver extends DbClient {
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
// The pool
// ---------------------------------------------------------------------------

/** Build a connection pool for the application database. */
export async function createPool(): Promise<Driver> {
  const pgPkg = (await import("pg")).default;
  const { Pool, types } = pgPkg;

  types.setTypeParser(DATE_OID, keepAsSent);

  const pool = new Pool({
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

  const describe = (): string => "local PostgreSQL (managed by costingly)";

  const driver: Driver = {
    query: async (text, params) => {
      const result = await pool.query(text, params ? [...params] : undefined);
      return {
        rows: result.rows,
        rowCount: result.rowCount ?? 0,
        columns: (result.fields ?? []).map((f) => f.name),
      };
    },
    transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn({
          query: async (text, params) => {
            const r = await client.query(text, params ? [...params] : undefined);
            return {
              rows: r.rows,
              rowCount: r.rowCount ?? 0,
              columns: (r.fields ?? []).map((f) => f.name),
            };
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

  return driver;
}

// ---------------------------------------------------------------------------
// One-off connections
// ---------------------------------------------------------------------------

/**
 * Run `fn` against a single connection that is opened and closed around it.
 *
 * For work the pool cannot do: creating the application database has to connect
 * to a *different* database (`postgres`), because you cannot create a database
 * from inside itself. Never pooled — this connection exists for one statement
 * and is closed in a `finally`, so it can never be handed to a later caller
 * carrying state from this one.
 */
export async function withConnection<T>(
  identity: DbIdentity,
  database: string,
  fn: (client: DbClient) => Promise<T>,
): Promise<T> {
  const pgPkg = (await import("pg")).default;
  const credentials = await databaseCredentials();
  const client = new pgPkg.Client({
    connectionString: connectionStringFor(credentials, identity, database),
  });

  await client.connect();
  try {
    return await fn({
      query: async (text, params) => {
        const r = await client.query(text, params ? [...params] : undefined);
        return {
          rows: r.rows,
          rowCount: r.rowCount ?? 0,
          columns: (r.fields ?? []).map((f) => f.name),
        };
      },
    });
  } finally {
    await client.end();
  }
}
