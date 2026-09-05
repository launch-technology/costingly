/**
 * Turning credentials into connections.
 *
 * The only place in the codebase that knows a connection string exists, or what
 * `pg`'s constructors want. Everything above it asks for a pool or a client and
 * is handed one already configured.
 *
 * `pg` is imported dynamically, not at module load: constructing a factory has
 * to stay free so that a diagnostic command — which must work when the cluster is
 * dead — pays nothing for the database layer merely being reachable.
 */

import type { Client, Pool } from "pg";
import { connectionStringFor } from "./credentials.js";
import type { PostgresServer } from "./server.js";

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

export class ConnectionFactory {
  constructor(private readonly server: PostgresServer) {}

  /**
   * A pool for the application database, as u_app.
   *
   * Registers the DATE parser on the way through. That is process-global in
   * `pg`, so it belongs wherever `pg` is first configured rather than in each
   * caller.
   */
  async createAppPool(): Promise<Pool> {
    const pgPkg = (await import("pg")).default;
    const { Pool: PgPool, types } = pgPkg;

    types.setTypeParser(DATE_OID, keepAsSent);

    const pool = new PgPool({
      connectionString: connectionStringFor(await this.server.credentials(), "app"),
      // No `ssl`: the listener is bound to loopback, so the bytes never leave
      // the machine and there is no network path to intercept.
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

  /**
   * One connected superuser client built from ALREADY-RECORDED credentials.
   *
   * The difference from `connectAsSuperuser` is what it refuses to do: no port
   * allocation, no password generation, no writes of any kind. A profile that
   * has never been set up produces an error describing that, which is the
   * answer a health check wants — rather than a working connection to a
   * database the act of asking brought into existence.
   */
  async connectAsRecordedSuperuser(): Promise<Client> {
    const credentials = await this.server.recordedCredentials();
    if (credentials === undefined) {
      throw new Error("This profile has no database yet — nothing has been set up.");
    }

    const pgPkg = (await import("pg")).default;
    const client = new pgPkg.Client({
      connectionString: connectionStringFor(credentials, "superuser"),
      // Short: the caller is reporting on a database, not waiting for one. A
      // server that is up answers in milliseconds; anything slower is itself
      // the finding.
      connectionTimeoutMillis: 5_000,
    });
    await client.connect();
    return client;
  }

  /** One connected superuser client against `database`. The caller closes it. */
  async connectAsSuperuser(database: string): Promise<Client> {
    const pgPkg = (await import("pg")).default;
    const client = new pgPkg.Client({
      connectionString: connectionStringFor(await this.server.credentials(), "superuser", database),
    });
    await client.connect();
    return client;
  }
}
