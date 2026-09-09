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
import type { DbCredentials } from "./credentials.js";

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

/** How this factory obtains the details it needs. One function, no datastore. */
export interface CredentialSource {
  /**
   * Everything needed to connect, or undefined if nothing is installed.
   *
   * A read. There used to be a second method here that decided a port and
   * generated passwords when none existed, which meant opening a connection
   * could quietly create half a profile.
   */
  credentials(): Promise<DbCredentials | undefined>;
}

/** Thrown when something tries to connect to a datastore that was never set up. */
function notInstalled(): Error {
  return new Error(
    "There is no datastore here yet — nothing has been installed in this profile.",
  );
}

export class ConnectionFactory {
  /**
   * Takes a credential source rather than a datastore.
   *
   * It needs one value, not a lifecycle — and depending on the whole
   * `Datastore` interface would make this file import from
   * `platform/datastore/`, reversing the one dependency that keeps
   * `platform/postgres/` liftable.
   */
  constructor(private readonly server: CredentialSource) {}

  /** The credentials, or a clear failure. Every connection starts here. */
  private async require(): Promise<DbCredentials> {
    const credentials = await this.server.credentials();
    if (credentials === undefined) throw notInstalled();
    return credentials;
  }

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
      connectionString: connectionStringFor(await this.require(), "app"),
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
   * One connected superuser client against `database`. The caller closes it.
   *
   * There used to be a second version of this for callers that must not write —
   * a health check, an inspector. It is gone because the distinction is now in
   * the credentials themselves: nothing here can create anything, so every
   * caller gets the safe behaviour without asking for it.
   *
   * The timeout is short on purpose. Callers are either reporting on a datastore
   * or working against one that is already up; a server that is running answers
   * in milliseconds, and anything slower is itself the finding.
   */
  async connectAsSuperuser(database?: string): Promise<Client> {
    const credentials = await this.require();
    const pgPkg = (await import("pg")).default;
    const client = new pgPkg.Client({
      connectionString: connectionStringFor(credentials, "superuser", database),
      connectionTimeoutMillis: 5_000,
    });
    await client.connect();
    return client;
  }
}
