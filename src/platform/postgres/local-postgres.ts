/**
 * Phase one: a Postgres that is running, reachable, and has the database.
 *
 * Everything up to the point where a connection to the application database
 * would succeed — and nothing about what is IN that database. A second
 * application over a different schema needs this class unchanged.
 *
 * Every step is idempotent, because this runs on the first query of every
 * process and several processes routinely start at once.
 */

import type { DataSource } from "./types/data-source.js";
import type { PostgresServer } from "./server.js";

export class LocalPostgres {
  /**
   * @param admin a superuser DataSource against the named database. Supplied
   *              rather than imported: this is the code that makes the pool
   *              possible, so it must not depend on the registry that hands
   *              one out.
   */
  constructor(
    private readonly admin: (database: string) => DataSource,
    private readonly server: PostgresServer,
    private readonly databaseName: string,
  ) {}

  /**
   * Start the cluster if needed, wait until it answers, create the database.
   *
   * The order is load-bearing, which is why this is one method rather than
   * three a caller has to sequence correctly.
   */
  async ensureRunning(): Promise<void> {
    await this.server.ensureRunning();
    // Before anything connects. ensureDatabaseExists() opens a connection of
    // its own, and a process that lost the start race would hit it too early.
    await this.waitUntilAccepting();
    await this.ensureDatabaseExists();
  }

  /**
   * Create the application database if it is missing. Returns true if it did.
   *
   * Connects to the always-present `postgres` database, because a database
   * cannot be created from inside itself. Doing this here rather than in `init`
   * is what lets a half-finished setup heal itself instead of failing with
   * `database "<name>" does not exist`.
   *
   * Two separate `query()` calls, deliberately: `CREATE DATABASE` is one of the
   * few statements Postgres refuses to run inside a transaction block, so this
   * cannot be tightened into a `transaction()` even though it reads like it
   * wants to be one. A lost race is harmless — the loser's CREATE fails and the
   * next start finds the database present.
   */
  async ensureDatabaseExists(): Promise<boolean> {
    const admin = this.admin("postgres");

    const existing = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [
      this.databaseName,
    ]);
    if (existing.rowCount === 1) return false;

    // No parameters possible in CREATE DATABASE. The name is our own constant,
    // not user input, but quote it properly regardless.
    await admin.query(`CREATE DATABASE "${this.databaseName.replace(/"/g, '""')}"`);
    return true;
  }

  /**
   * Block until the server will actually answer.
   *
   * `pg_ctl -w` returns when the postmaster is up, and with TCP the port is
   * bound before recovery finishes — so a process that lost the start race can
   * connect to an open port and be told "the database system is starting up"
   * (57P03). The unix socket hid this: it did not exist until the server was
   * ready.
   */
  private async waitUntilAccepting(): Promise<void> {
    const deadline = Date.now() + 30_000;

    for (;;) {
      try {
        // `postgres`, not the application database: this runs before that one
        // is created, and a missing database is not a readiness problem.
        await this.admin("postgres").query("SELECT 1");
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
}
