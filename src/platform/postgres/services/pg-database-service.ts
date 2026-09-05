/**
 * A database inside a cluster: creating it, and keeping its schema current.
 *
 * The third of the three PostgreSQL nouns. A *cluster* is a directory, a
 * *server* is the process serving it, and a *database* is one namespace of
 * tables within it — a cluster holds several, and `initdb` supplies three
 * before anyone asks for one.
 *
 * Unlike the other two services this one speaks SQL rather than running
 * binaries, so it is handed a way to obtain a superuser connection instead of a
 * directory. It never opens one itself: connecting requires credentials, and
 * credentials are the caller's business.
 *
 * Knows nothing about which database a project wants, or what its schema
 * contains — both arrive as arguments.
 */

import type { DataSource } from "../types/data-source.js";
import { applyPendingMigrations, type Migration } from "../migrations.js";

/** How long to keep waiting for a starting server before giving up. */
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 200;

/**
 * The database `initdb` always creates, which therefore always exists.
 *
 * Needed as a destination for `CREATE DATABASE`, because a database cannot be
 * created from inside itself, and as a target for the readiness probe, because
 * that runs before the application's database exists.
 */
const BOOTSTRAP_DATABASE = "postgres";

export class PgDatabaseService {
  /**
   * @param admin a superuser DataSource against the named database. Supplied
   *              rather than imported: this is the code that makes an
   *              application pool possible, so it must not depend on one.
   */
  constructor(private readonly admin: (database: string) => DataSource) {}

  /**
   * Block until the server will actually answer.
   *
   * `pg_ctl -w` returns when the postmaster is up, and with TCP the port is
   * bound before recovery finishes — so a process that lost the start race can
   * connect to an open port and be told "the database system is starting up"
   * (57P03). The unix socket hid this: it did not exist until the server was
   * ready.
   *
   * Probes `postgres` rather than the application's database, because this runs
   * before that one is created and a missing database is not a readiness
   * problem.
   */
  async waitUntilAccepting(): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;

    for (;;) {
      try {
        await this.admin(BOOTSTRAP_DATABASE).query("SELECT 1");
        return;
      } catch (error) {
        const code = (error as { code?: string }).code;
        // 57P03 cannot_connect_now — the postmaster is up but still recovering.
        const transient = code === "57P03" || code === "ECONNREFUSED";
        if (!transient || Date.now() > deadline) throw error;
        await new Promise((r) => setTimeout(r, READY_POLL_MS));
      }
    }
  }

  /** Is there a database of this name in the cluster? */
  async exists(name: string): Promise<boolean> {
    const found = await this.admin(BOOTSTRAP_DATABASE).query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [name],
    );
    return found.rowCount === 1;
  }

  /**
   * Create the database. Returns false if it was already there.
   *
   * Two separate `query()` calls, deliberately: `CREATE DATABASE` is one of the
   * few statements Postgres refuses to run inside a transaction block, so this
   * cannot be tightened into a `transaction()` even though it reads like it
   * wants to be one. A lost race is harmless — the loser's CREATE fails and the
   * next attempt finds the database present.
   */
  async create(name: string): Promise<boolean> {
    if (await this.exists(name)) return false;

    // No parameters are possible in CREATE DATABASE. Quote the identifier
    // properly regardless of where the name came from.
    await this.admin(BOOTSTRAP_DATABASE).query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
    return true;
  }

  /**
   * Bring a database's schema up to date.
   *
   * The migrations are the CALLER'S — this service supplies the mechanism and
   * has no opinion about the content. Runs as the superuser, because migrations
   * routinely create the very role an application pool would authenticate as.
   */
  async migrate(name: string, migrations: readonly Migration[]): Promise<void> {
    await applyPendingMigrations(this.admin(name), migrations);
  }

  /**
   * Give a role its password.
   *
   * Separate from `migrate` because migration files are committed and secrets
   * are not: a migration can create a role but must never contain its password.
   * Idempotent and cheap, so it is safe to run on every start — which also
   * repairs a cluster whose role lost its password without needing a distinct
   * recovery path.
   *
   * `ALTER ROLE` accepts no bind parameters, so both values are interpolated.
   * The assertion is what makes that safe rather than hopeful: anything outside
   * these alphabets means a caller is passing something this code does not know
   * how to escape, and the right response is to stop.
   */
  async setRolePassword(name: string, user: string, password: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]+$/.test(password) || !/^[a-z_][a-z0-9_]*$/.test(user)) {
      throw new Error(
        "Refusing to set a database password: the credentials contain characters " +
          "this code does not know how to escape.",
      );
    }

    await this.admin(name).transaction(async (tx) => {
      // Serialised across processes. ALTER ROLE writes a pg_authid row, and
      // several commands starting at once produce "tuple concurrently updated".
      //
      // try_ rather than plain: whoever holds it is doing the same work, so the
      // right move is to skip, not to queue behind them. _xact_ rather than the
      // session form: the lock releases with the COMMIT that ends this
      // transaction, so there is no unlock to forget and no way for a failure
      // between the two to strand it.
      const got = await tx.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_xact_lock($1) AS locked",
        [ROLE_PASSWORD_LOCK],
      );
      if (got.rows[0]?.locked !== true) return;

      await tx.query(`ALTER ROLE ${user} LOGIN PASSWORD '${password}'`);
    });
  }
}

/** Arbitrary but fixed, like the migration lock. */
const ROLE_PASSWORD_LOCK = 4_812_233;
