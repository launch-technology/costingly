/**
 * Everything that has to be true before a single application query can run.
 *
 * All of it goes through the admin DataSource — the superuser, unpooled — for
 * one reason: the application pool authenticates as u_app against the
 * `costingly` database, and on a fresh install neither of those exists yet.
 * This is the code that creates them.
 *
 * Runs once per process, from the registry, on the first application query.
 * Nothing here is reachable at runtime — a tool call arriving after startup
 * never touches this file.
 */

import { DATABASE_NAME, databaseCredentials, ensureServerRunning } from "../../postgres/server.js";
import { adminDataSource } from "./data-source-registry.js";
import { applyPendingMigrations } from "./migrations.js";

/**
 * Create the application database if it is missing. Returns true if it did.
 *
 * Connects to the always-present `postgres` database, because a database cannot
 * be created from inside itself. Doing this here rather than in `init` is what
 * lets a half-finished setup heal itself instead of failing with
 * `database "costingly" does not exist`.
 *
 * Two separate `query()` calls, deliberately: `CREATE DATABASE` is one of the
 * few statements Postgres refuses to run inside a transaction block, so this
 * cannot be tightened into a `transaction()` even though it reads like it wants
 * to be one. A lost race is harmless — the loser's CREATE fails and the next
 * start finds the database present.
 */
export async function ensureDatabaseExists(): Promise<boolean> {
  const admin = adminDataSource("postgres");

  const existing = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [
    DATABASE_NAME,
  ]);
  if (existing.rowCount === 1) return false;

  // No parameters possible in CREATE DATABASE. The name is our own constant,
  // not user input, but quote it properly regardless.
  await admin.query(`CREATE DATABASE "${DATABASE_NAME.replace(/"/g, '""')}"`);
  return true;
}

/** Arbitrary but fixed, like the migration lock. */
const APP_PASSWORD_LOCK = 4_812_233;

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

  await adminDataSource(DATABASE_NAME).transaction(async (tx) => {
    // Serialised across processes. ALTER ROLE writes a pg_authid row, and six
    // CLI commands starting at once produce "tuple concurrently updated".
    //
    // try_ rather than plain: whoever holds it is doing the same work, so the
    // right move is to skip, not to queue behind them. _xact_ rather than the
    // session form: the lock then releases with the COMMIT that ends this
    // transaction, so there is no unlock to forget and no way for a failure
    // between the two to strand it.
    const got = await tx.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_xact_lock($1) AS locked",
      [APP_PASSWORD_LOCK],
    );
    if (got.rows[0]?.locked !== true) return;

    await tx.query(`ALTER ROLE ${user} LOGIN PASSWORD '${password}'`);
  });
}

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
      await adminDataSource("postgres").query("SELECT 1");
      return;
    } catch (error) {
      const code = (error as { code?: string }).code;
      // 57P03 cannot_connect_now — the postmaster is up but still recovering.
      const transient = code === "57P03" || code === "ECONNREFUSED";
      if (!transient || Date.now() > deadline) throw error;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

/**
 * Bring the cluster, the database and the schema into existence, in order.
 *
 * Order is load-bearing throughout, which is why this is one function rather
 * than four calls a caller has to get right.
 */
export async function provisionDatabase(): Promise<void> {
  await ensureServerRunning();
  // Before anything connects. ensureDatabaseExists() opens a connection of its
  // own, and a process that lost the start race would hit it too early.
  await waitUntilAccepting();
  await ensureDatabaseExists();
  await applyPendingMigrations();
  await applyAppPassword();
}
