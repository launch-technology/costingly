/**
 * Everything that has to be true before a query can run.
 *
 * Three genuinely different jobs — start the server, make sure the database
 * exists, bring its schema up to date — and this is the only place that knows
 * they belong together. Doing it lazily on first use rather than at process
 * start is what keeps `costingly doctor`, which must never touch the database,
 * honest.
 */

import { DATABASE_NAME, databaseCredentials, ensureServerRunning } from "./server.js";
import { createPool, withConnection, type Driver } from "./connections.js";
import { pendingMigrations, runMigrations, type Migration } from "./migrations.js";

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
// Provisioning
// ---------------------------------------------------------------------------

/**
 * Create the application database if it is missing. Returns true if it did.
 *
 * Connects to the always-present `postgres` database, because a database cannot
 * be created from inside itself. Doing this here rather than in `init` is what
 * lets a half-finished setup heal itself instead of failing with
 * `database "costingly" does not exist`.
 */
export async function ensureDatabaseExists(): Promise<boolean> {
  return withConnection("superuser", "postgres", async (client) => {
    const existing = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [
      DATABASE_NAME,
    ]);
    if (existing.rowCount === 1) return false;

    // No parameters possible in CREATE DATABASE. The name is our own constant,
    // not user input, but quote it properly regardless.
    await client.query(`CREATE DATABASE "${DATABASE_NAME.replace(/"/g, '""')}"`);
    return true;
  });
}

/**
 * Bring the database's shape up to date, if a migration source was registered.
 *
 * Separate from connecting on purpose. A pool is "how to talk to Postgres";
 * which migrations have run is an application fact one layer up, and `Driver`
 * has no business knowing migrations exist. This needs only a `DbClient`, which
 * is the smaller contract.
 *
 * Costs one read of a small table when there is nothing to do — every start
 * after the first. Only a non-empty pending set escalates to a transaction and
 * an advisory lock. A failure is deliberately fatal: a database whose shape
 * disagrees with the code fails confusingly and much later.
 */
async function applyPendingMigrations(): Promise<void> {
  if (migrationSource === undefined) return;

  const migrations = await migrationSource();

  // As the superuser, on a one-off connection, and BEFORE the pool exists.
  // Migrations create u_app itself, so they cannot run through a pool that
  // authenticates as it — on a fresh cluster that role does not exist yet.
  await withConnection("superuser", DATABASE_NAME, async (client) => {
    if ((await pendingMigrations(client, migrations)).length === 0) return;

    await client.query("BEGIN");
    try {
      await runMigrations(client, migrations);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
  });
}

/**
 * Give u_app the password we generated for it.
 *
 * The migration creates the role but cannot set its password: migration files
 * are committed and secrets are not. Idempotent and cheap, so it runs on every
 * start — which also repairs a cluster whose role lost its password without
 * needing a separate recovery path.
 *
 * `ALTER ROLE` accepts no bind parameters, so the password is interpolated. The
 * assertion is what makes that safe rather than hopeful: generatePassword()
 * produces base64url, and anything outside that alphabet means something has
 * changed upstream and this needs revisiting before it becomes an injection.
 */
async function applyAppPassword(): Promise<void> {
  const { logins } = await databaseCredentials();
  const { user, password } = logins.app;

  if (!/^[A-Za-z0-9_-]+$/.test(password) || !/^[a-z_][a-z0-9_]*$/.test(user)) {
    throw new Error(
      "Refusing to set the database password: the generated credentials contain " +
        "characters this code does not know how to escape.",
    );
  }

  await withConnection("superuser", DATABASE_NAME, async (client) => {
    // Serialised across processes. ALTER ROLE writes a pg_authid row, and six
    // CLI commands starting at once produce "tuple concurrently updated".
    // try_ rather than plain: whoever holds it is doing the same work, so the
    // right move is to skip, not to queue behind them.
    const got = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [APP_PASSWORD_LOCK],
    );
    if (got.rows[0]?.locked !== true) return;

    try {
      await client.query(`ALTER ROLE ${user} LOGIN PASSWORD '${password}'`);
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [APP_PASSWORD_LOCK]).catch(() => {});
    }
  });
}

/** Arbitrary but fixed, like the migration lock. */
const APP_PASSWORD_LOCK = 4_812_233;

/**
 * Block until the server will actually answer.
 *
 * `pg_ctl -w` returns when the postmaster is up, and with TCP the port is bound
 * before recovery finishes — so a process that lost the start race can connect
 * to an open port and be told "the database system is starting up" (57P03). The
 * unix socket hid this: it did not exist until the server was ready.
 */
async function waitUntilAccepting(): Promise<void> {
  const deadline = Date.now() + 30_000;

  for (;;) {
    try {
      // `postgres`, not the application database: this runs before that one is
      // created, and a missing database is not a readiness problem.
      await withConnection("superuser", "postgres", async (c) => c.query("SELECT 1"));
      return;
    } catch (error) {
      const code = (error as { code?: string }).code;
      // 57P03 cannot_connect_now, 3D000 the database is not there yet.
      // 57P03 cannot_connect_now — the postmaster is up but still recovering.
      const transient = code === "57P03" || code === "ECONNREFUSED";
      if (!transient || Date.now() > deadline) throw error;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

/** Everything that has to be true before a query can run, in order. */
async function openDatabase(): Promise<Driver> {
  await ensureServerRunning();
  // Before anything connects. ensureDatabaseExists() opens a connection of its
  // own, and a process that lost the start race would hit it too early.
  await waitUntilAccepting();
  await ensureDatabaseExists();
  await applyPendingMigrations();
  await applyAppPassword();

  return createPool();
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// Cached on globalThis because Next.js hot reloads re-evaluate modules and warm
// serverless containers reuse the process.
const globalForDb = globalThis as typeof globalThis & {
  __costinglyDriver?: Promise<Driver> | undefined;
};

/** The opened database, opening it on first use. */
export function getDriver(): Promise<Driver> {
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
