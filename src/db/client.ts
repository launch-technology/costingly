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
import { pendingMigrations, runMigrations, type Migration } from "./migrate.js";

// ---------------------------------------------------------------------------
// Where the migrations come from
// ---------------------------------------------------------------------------
/**
 * Registered by the entry point, because reading `migrations/` means resolving a
 * path from `import.meta.url` and src/ deliberately does not do that — see the
 * header of cli/paths.ts. Nothing registered means no automatic migration, which
 * is the right default for code embedding this module rather than running the
 * CLI.
 */
let migrationSource: (() => Promise<Migration[]>) | undefined;

/**
 * Register the loader. Must happen before anything opens the database.
 *
 * The throw is not defensive noise — it is the exact bug this design invites,
 * made loud. Registering late used to succeed and silently skip every
 * migration, and the failure surfaced several steps later as
 * `relation "items" does not exist`. It cost a debugging cycle in the test
 * suite before this check existed.
 */
export function setMigrationSource(load: () => Promise<Migration[]>): void {
  if (globalForDb.__costinglyDriver !== undefined) {
    throw new Error(
      "setMigrationSource() was called after the database was already opened, so " +
        "migrations would be skipped for this process. Register it before the first query.",
    );
  }
  migrationSource = load;
}

// ---------------------------------------------------------------------------
// Driver-agnostic surface
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

interface Driver extends DbClient {
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

/**
 * Build a connection pool. Nothing else.
 *
 * No provisioning, no DDL, no migrations — this only knows how to talk to a
 * database that already exists. Keeping it that narrow is what makes it
 * possible to reason about (and test) the pool separately from everything that
 * has to happen before a pool is useful.
 */
async function connect(): Promise<Driver> {
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

/**
 * Bring the database's shape up to date, if a migration source was registered.
 *
 * Separate from connecting on purpose. A pool is "how to talk to Postgres";
 * which migrations have run is an application fact one layer up, and `Driver`
 * has no business knowing migrations exist. This function needs only a
 * `DbClient`, which is the smaller contract.
 *
 * Costs one read of a small table when there is nothing to do — every start
 * after the first. Only a non-empty pending set escalates to a transaction and
 * an advisory lock. A failure is deliberately fatal: a database whose shape
 * disagrees with the code fails confusingly and much later.
 */
async function applyPendingMigrations(driver: Driver): Promise<void> {
  if (migrationSource === undefined) return;

  const migrations = await migrationSource();
  if ((await pendingMigrations(driver, migrations)).length === 0) return;

  await driver.transaction((client) => runMigrations(client, migrations));
}

/**
 * Everything that has to be true before a query can run, in order.
 *
 * The three steps are genuinely different jobs — provision the server, open a
 * pool, migrate the schema — and this is the only place that knows they belong
 * together. Doing it lazily on first connection rather than at process start is
 * what keeps `costingly doctor`, which must never touch the database, honest.
 *
 * `ensureServerRunning`/`ensureDatabaseExists` are idempotent and return almost
 * immediately once things exist, so every command auto-starts the database and
 * nothing above this line has to care. Creating the database here rather than in
 * `init` is what lets a half-finished setup heal itself instead of failing with
 * `database "costingly" does not exist`.
 */
async function openDatabase(): Promise<Driver> {
  await ensureServerRunning();
  await ensureDatabaseExists();

  const driver = await connect();
  await applyPendingMigrations(driver);
  return driver;
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

  const created = openDatabase().catch((error: unknown) => {
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
